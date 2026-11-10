"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const Database = require("../../db/database"),
  {
    CustomerMessageConfig,
  } = require("../../marketplace/customer-message-config"),
  { CompletionNotifications } = require("../../v3/notifications");
async function fixture(t, status = "Received", configure = () => {}) {
  const db = await Database.open(":memory:"),
    engine = new CustomerMessageConfig(db),
    repo = new (require("../../db/repositories/delivery").DeliveryRepository)(
      db,
    );
  configure(engine);
  const order = {
    id: "order",
    amount: "100000000",
    buyerIgn: "BuyerOne",
    buyerName: "Buyer",
    hybridWorkflow: true,
    browserOrder: { quantityDisplay: "100 M" },
    browserBinding: { sellerHref: "seller" },
  };
  repo.observe(order, "live");
  repo.state(order.id, "DELIVERED");
  db.raw()
    .prepare("UPDATE delivery_orders SET evidence=?")
    .run(JSON.stringify({ screenshotCaptured: true }));
  const sends = [],
    uploads = [],
    s = {
      db,
      settings: { getSync: () => false },
      deliveryService: { repo, ownerHeld: () => false },
      marketplace: { chatOrder: async () => ({ ...order, status }) },
      browserBridge: {
        status: () => ({ connected: true }),
        sendOrderMessageObserved: async (o, text, id, _seller, auth) => {
          await auth();
          sends.push({ id, text });
        },
        uploadOrderEvidenceObserved: async (o, file, _seller, auth) => {
          await auth();
          uploads.push(file);
        },
      },
    };
  const worker = new CompletionNotifications(s);
  worker.start();
  t.after(() => {
    worker.stop();
    db.close();
  });
  return { db, engine, worker, s, sends, uploads };
}
test("configured final text is sent once even if buyer already confirmed receipt; no guide images by default", async (t) => {
  const { worker, sends, uploads, db } = await fixture(
    t,
    "Received",
    (engine) =>
      engine.save("order_delivered", {
        enabled: true,
        text: "Thank you! {amount} reached {minecraft_ign}.",
        revision: 1,
      }),
  );
  await worker.tick();
  await worker.tick();
  assert.deepEqual(sends, [
    { id: "v3-completion:order", text: "Thank you! 100M reached BuyerOne." },
  ]);
  assert.deepEqual(uploads, []);
  assert.equal(
    db.raw().prepare("SELECT state FROM v3_completions").get().state,
    "SENT",
  );
});
test("completion retry keeps old text after edits and cannot schedule a second version", async (t) => {
  const { engine, worker, sends, db, s } = await fixture(
    t,
    "Delivered",
    (engine) =>
      engine.save("order_delivered", {
        enabled: true,
        text: "Original {amount}",
        revision: 1,
      }),
  );
  const send = s.browserBridge.sendOrderMessageObserved;
  let fail = true;
  s.browserBridge.sendOrderMessageObserved = async (...args) => {
    if (fail) {
      fail = false;
      throw Error("Upload service unavailable");
    }
    return send(...args);
  };
  await worker.tick();
  engine.save("order_delivered", {
    enabled: true,
    text: "Changed message",
    revision: 2,
  });
  db.raw().prepare("UPDATE v3_completions SET updated_ms=0").run();
  await worker.tick();
  await worker.tick();
  assert.deepEqual(sends, [
    { id: "v3-completion:order", text: "Original 100M" },
  ]);
});
test("legacy uncertain confirmation-guide action is reconciled even with guides now disabled", async (t) => {
  const { worker, db, sends, uploads } = await fixture(t, "Delivered");
  db.raw()
    .prepare(
      "INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,created_ms,updated_ms) VALUES(?,?,'order','fixture','NEEDS_OPERATOR',?,1,1)",
    )
    .run(
      "legacy-guide",
      "uploadEvidenceObserved",
      JSON.stringify({ orderId: "order", name: "how-to-confirm-1.png" }),
    );
  await worker.tick();
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /how-to-confirm-1\.png$/);
  assert.equal(sends.length, 0);
});
test("canceled orders never receive completion text or optional guide uploads", async (t) => {
  const { worker, sends, uploads } = await fixture(t, "Canceled", (engine) => {
    engine.save("order_delivered", {
      enabled: true,
      text: "Thank you",
      revision: 1,
    });
    engine.guides({ enabled: true, revision: 1 });
  });
  await worker.tick();
  assert.deepEqual(sends, []);
  assert.deepEqual(uploads, []);
});
test("enabling completion after the actual delivered transition applies to future orders", async (t) => {
  const { engine, worker, sends } = await fixture(t);
  engine.save("order_delivered", {
    enabled: true,
    text: "Future completion",
    revision: 1,
  });
  await worker.tick();
  assert.deepEqual(sends, []);
});

test("buyer cancellation before delivery admission uses its confirmed marketplace receipt", async (t) => {
  const { engine, worker, db, s, sends } = await fixture(t, "Canceled");
  const id = "canceled-before-admission";
  engine.save("buyer_canceled", {
    text: "Order {order_id} canceled.",
    enabled: true,
    revision: 1,
  });
  engine.schedule(
    "buyer_canceled",
    { id, amount: "100000000" },
    "customer-notification:buyer_canceled:" + id,
    {
      order: {
        id,
        hybridWorkflow: true,
        browserOrder: { quantityDisplay: "100 M" },
        browserBinding: { sellerHref: "seller" },
      },
    },
  );
  db.raw()
    .prepare(
      "INSERT INTO seller_api_actions(id,operation,resource_id,state,created_ms,updated_ms) VALUES(?, 'cancelOrder', ?, 'CONFIRMED', 1, 1)",
    )
    .run("cancelOrder:" + id, id);
  s.marketplace.chatOrder = async (orderId) => ({
    id: orderId,
    status: "Canceled",
  });
  await worker.tick();
  await worker.tick();
  assert.deepEqual(sends, [
    {
      id: "customer-notification:buyer_canceled:" + id,
      text: "Order canceled-before-admission canceled.",
    },
  ]);
  assert.equal(
    db.raw().prepare("SELECT count(*) n FROM delivery_chunks").get().n,
    0,
  );
});

test("a failed optional notification records a retry delay without changing delivery state", async (t) => {
  const { engine, worker, db, s } = await fixture(t, "Delivered");
  engine.save("payment_verified", {
    text: "Verified {amount}",
    enabled: true,
    revision: 1,
  });
  engine.schedule(
    "payment_verified",
    { id: "order", amount: "100000000" },
    "customer-notification:payment_verified:order",
  );
  let calls = 0;
  s.browserBridge.sendOrderMessageObserved = async () => {
    calls++;
    throw Error("Fixture connection failure");
  };
  await worker.tick();
  await worker.tick();
  assert.equal(calls, 1);
  assert.equal(
    db
      .raw()
      .prepare("SELECT state FROM delivery_orders WHERE id=?")
      .get("order").state,
    "DELIVERED",
  );
  assert.ok(
    db
      .raw()
      .prepare("SELECT next_attempt_ms FROM customer_message_attempts")
      .get().next_attempt_ms > Date.now(),
  );
});
