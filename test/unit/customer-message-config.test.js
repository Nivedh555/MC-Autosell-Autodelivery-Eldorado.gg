"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const Database = require("../../db/database");
const {
  CustomerMessageConfig,
  recordDeliveryEvent,
} = require("../../marketplace/customer-message-config");
const flow = require("../../marketplace/order-chat-flow");
const order = {
  id: "test-order",
  buyerName: "Alex",
  buyerIgn: "BuyerOne",
  amount: "100000000",
  hybridWorkflow: true,
  browserBinding: { sellerHref: "seller" },
  browserOrder: { quantityDisplay: "100 M" },
};
async function fixture(t) {
  const db = await Database.open(":memory:");
  t.after(() => db.close());
  return { db, engine: new CustomerMessageConfig(db), services: { db } };
}
test("all fifteen message stages exist; optional completion and both guide images start disabled", async (t) => {
  const { engine } = await fixture(t),
    snapshot = engine.snapshot();
  assert.equal(snapshot.templates.length, 15);
  assert.equal(engine.get("order_delivered").enabled, false);
  assert.equal(engine.get("order_delivered").text, "");
  assert.equal(engine.get("review_request").enabled, false);
  assert.equal(snapshot.guides.enabled, false);
  assert.throws(
    () =>
      engine.save("confirm_recipient", {
        revision: 1,
        text: "Okay",
        enabled: false,
      }),
    /required/,
  );
});
test("multiline templates persist across database close/reopen with explicit variables and revision conflicts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autosell-messages-"));
  let db = await Database.open(path.join(dir, "test.db")),
    engine = new CustomerMessageConfig(db);
  t.after(async () => {
    await db.close();
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith("autosell-messages-")
    )
      throw Error("Unexpected fixture directory");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const message =
    "Hello {buyer_name}\n\nOrder {order_id}: {amount} on {server_name}";
  engine.save("new_order", { text: message, enabled: true, revision: 1 });
  assert.throws(
    () =>
      engine.save("new_order", { text: "stale", enabled: true, revision: 1 }),
    /changed/,
  );
  assert.throws(
    () =>
      engine.save("new_order", {
        text: "Hi {process.env.KEY}",
        enabled: true,
        revision: 2,
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      engine.save("request_username", {
        text: "Hey {minecraft_ign}",
        enabled: true,
        revision: 1,
      }),
    /not available/,
  );
  assert.throws(
    () =>
      engine.save("order_delivered", { text: "", enabled: true, revision: 1 }),
    /Enter/,
  );
  await db.close();
  db = await Database.open(path.join(dir, "test.db"));
  engine = new CustomerMessageConfig(db);
  assert.equal(engine.get("new_order").text, message);
  assert.equal(engine.get("new_order").revision, 2);
  const rendered = engine.schedule("new_order", order, "first");
  assert.equal(
    rendered.text,
    "Hello Alex\n\nOrder test-order: 100M on DonutSMP",
  );
  engine.save("new_order", {
    text: "New greeting",
    enabled: true,
    revision: 2,
  });
  assert.equal(
    engine.schedule("new_order", order, "first").text,
    rendered.text,
  );
  assert.equal(
    engine.schedule("new_order", { ...order, id: "another" }, "second").text,
    "New greeting",
  );
  engine.reset("new_order", 3);
  assert.equal(
    engine.get("new_order").text,
    engine.get("new_order").defaultText,
  );
});
test("disabled events are pinned as skipped and cannot be backfilled by enabling a later revision", async (t) => {
  const { engine } = await fixture(t);
  const skipped = engine.schedule("order_delivered", order, "completion");
  assert.equal(skipped.state, "SKIPPED");
  engine.save("order_delivered", {
    text: "Thanks {minecraft_ign}!\n{order_url}",
    enabled: true,
    revision: 1,
  });
  assert.equal(
    engine.schedule("order_delivered", order, "completion").enabled,
    false,
  );
  assert.match(
    engine.schedule(
      "order_delivered",
      { ...order, id: "next" },
      "next-completion",
    ).text,
    /Thanks BuyerOne!/,
  );
});
test("custom confirmation text retains immutable exact order/amount/IGN and current conversation authorization", async (t) => {
  const { engine, services } = await fixture(t),
    messages = [{ id: "name", peer: true, text: "ign: BuyerOne" }];
  engine.save("confirm_recipient", {
    text: "Please double-check:",
    enabled: true,
    revision: 1,
  });
  const text = flow.confirmationPrompt("BuyerOne", order.amount, {
    orderId: order.id,
    order,
    services,
    messages,
  });
  engine.save("confirm_recipient", {
    text: "Changed for the next customer",
    enabled: true,
    revision: 2,
  });
  assert.equal(
    flow.confirmationPrompt("BuyerOne", order.amount, {
      orderId: order.id,
      order,
      services,
      messages,
    }),
    text,
  );
  const transcript = [
    ...messages,
    { id: "prompt", peer: false, text },
    { id: "yes", peer: true, text: "yes" },
  ];
  assert.equal(
    flow.selection(transcript, {
      services,
      orderId: order.id,
      amount: order.amount,
    }).confirmed,
    true,
  );
  assert.equal(
    flow.selection(transcript, {
      services,
      orderId: "other-order",
      amount: order.amount,
    }).confirmed,
    false,
  );
  assert.equal(
    flow.selection(transcript, {
      services,
      orderId: order.id,
      amount: "10000000",
    }).confirmed,
    false,
  );
  assert.equal(
    flow.selection(
      [...transcript, { id: "correction", peer: true, text: "ign: BuyerTwo" }],
      { services, orderId: order.id, amount: order.amount },
    ).confirmed,
    false,
  );
  assert.equal(
    flow.selection(
      [
        messages[0],
        { id: "wait", peer: true, text: "wait" },
        transcript[1],
        transcript[2],
      ],
      { services, orderId: order.id, amount: order.amount },
    ).confirmed,
    false,
  );
});
test("delivery event hooks schedule configured lifecycle notices once and never create a payment", async (t) => {
  const { db, engine } = await fixture(t),
    repo = new (require("../../db/repositories/delivery").DeliveryRepository)(
      db,
    );
  repo.observe(order, "live");
  engine.save("payment_verified", {
    text: "Verified {amount}",
    enabled: true,
    revision: 1,
  });
  recordDeliveryEvent(db.raw(), order.id, "STATE", { state: "ALL_VERIFIED" });
  recordDeliveryEvent(db.raw(), order.id, "STATE", { state: "ALL_VERIFIED" });
  const rows = db
    .raw()
    .prepare(
      "SELECT * FROM customer_message_snapshots WHERE event='payment_verified'",
    )
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "Verified 100M");
  assert.equal(
    db.raw().prepare("SELECT count(*) n FROM delivery_chunks").get().n,
    0,
  );
});

test("a configurable greeting that imitates the old confirmation cannot authorize payment", async (t) => {
  const { engine, services } = await fixture(t);
  const oldText = flow.confirmationPrompt("BuyerOne", order.amount);
  engine.save("new_order", { text: oldText, enabled: true, revision: 1 });
  engine.schedule("new_order", order, "custom-greeting");
  const messages = [
    { id: "ign", peer: true, text: "ign: BuyerOne" },
    { id: "greeting", peer: false, text: oldText },
    { id: "yes", peer: true, text: "yes" },
  ];
  assert.equal(
    flow.selection(messages, {
      services,
      orderId: order.id,
      amount: order.amount,
    }).confirmed,
    false,
  );
});

test("replacement usernames use the configured correction and a fresh mandatory confirmation", async (t) => {
  const { engine, services } = await fixture(t);
  engine.save("username_corrected", {
    text: "Updated to {minecraft_ign}.",
    enabled: true,
    revision: 1,
  });
  const messages = [
    { id: "name", peer: true, text: "ign: BuyerOne" },
    { id: "correction", peer: true, text: "ign: BuyerTwo" },
  ];
  const prompt = flow.confirmationPrompt("BuyerTwo", order.amount, {
    services,
    orderId: order.id,
    order,
    messages,
    corrected: true,
  });
  assert.match(prompt, /^Updated to BuyerTwo\./);
  assert.match(
    prompt,
    /Confirm payment: 100000000 Donut dollars to BuyerTwo\./,
  );
  assert.equal(
    flow.selection(
      [
        ...messages,
        { id: "prompt", peer: false, text: prompt },
        { id: "yes", peer: true, text: "yes" },
      ],
      { services, orderId: order.id, amount: order.amount },
    ).confirmed,
    true,
  );
});
