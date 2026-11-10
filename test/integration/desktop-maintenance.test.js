"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Database = require("../../db/database");
const { Maintenance } = require("../../ops/maintenance");
const { attach, tokenGuard } = require("../../ops/desktop-control");
async function fixture(t) {
  const db = await Database.open(":memory:");
  t.after(() => db.close());
  return { db: db.raw(), maintenance: new Maintenance(db.raw()) };
}
test("maintenance atomically fences new work, drains admitted work and persists across controllers", async (t) => {
  const { db, maintenance: m } = await fixture(t);
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let afterFence = false;
  const work = m.run("payment", async () => {
    await pending;
    m.assertCanDispatch();
    afterFence = true;
  });
  assert.equal(m.begin("3.1.0").safe, false);
  await assert.rejects(
    m.run("new-payment", () => assert.fail("must not start")),
    /maintenance/,
  );
  assert.throws(() => m.assertCanDispatch(), /maintenance/);
  const reopened = new Maintenance(db);
  assert.equal(reopened.active, true);
  assert.equal(reopened.row().target_version, "3.1.0");
  finish();
  await work;
  assert.equal(afterFence, true);
  assert.equal(m.status().safe, true);
  assert.equal(m.resume().resumed, true);
  assert.equal(new Maintenance(db).active, false);
});
test("uncertain journal and bridge outcomes block update even without in-memory workers", async (t) => {
  const { db, maintenance: m } = await fixture(t);
  db.prepare(
    "INSERT INTO delivery_orders(id,fingerprint,payload,state,mode,created_ms,updated_ms) VALUES('test','f','{}','NEEDS_OPERATOR','mock',0,0)",
  ).run();
  db.prepare(
    "INSERT INTO delivery_chunks(order_id,chunk_index,amount,command_amount,debit,state,idempotency_key) VALUES('test',0,'1','1','1','PAY_SENT','chunk')",
  ).run();
  assert.equal(m.begin().safe, false);
  assert.equal(m.resume().resumed, undefined);
  db.exec(
    "UPDATE delivery_chunks SET state='PAY_VERIFIED'; CREATE TABLE v3_bridge_calls(id TEXT,operation TEXT,state TEXT,request TEXT)",
  );
  db.prepare("INSERT INTO v3_bridge_calls VALUES(?,?,?,?)").run(
    "bridge",
    "command",
    "UNKNOWN",
    JSON.stringify({ command: "/pay Sample 1" }),
  );
  assert.equal(m.status().safe, false);
  assert.match(m.status().reason, /bridge/);
  db.exec("UPDATE v3_bridge_calls SET state='DONE'");
  assert.equal(m.status().safe, true);
});
test("LTC, account locks and spawner intake block safe shutdown", async (t) => {
  const { db, maintenance: m } = await fixture(t);
  m.begin();
  db.prepare(
    "INSERT INTO payout_intents(id,discord_id,address,fiat_micros,litoshi,state,created_ms) VALUES('p','seller','fixture','1','1','BROADCAST_INTENT',0)",
  ).run();
  assert.equal(m.status().safe, false);
  assert.match(m.status().reason, /Litecoin/);
  db.exec("UPDATE payout_intents SET state='BROADCAST'");
  assert.equal(m.status().safe, true);
});
test("desktop control refuses shutdown without durable maintenance and replies before stopping", async (t) => {
  const ctx = await fixture(t),
    channel = new EventEmitter(),
    replies = [];
  let stops = 0;
  channel.send = (value) => replies.push(value);
  ctx.shutdown = async () => {
    assert.equal(replies.at(-1).safe, true);
    stops++;
  };
  const detach = attach(ctx, channel);
  t.after(detach);
  channel.emit("message", { type: "control", id: "a", action: "shutdown" });
  await new Promise((r) => setImmediate(r));
  assert.equal(stops, 0);
  channel.emit("message", {
    type: "control",
    id: "b",
    action: "maintenance",
    targetVersion: "3.0.1",
  });
  await new Promise((r) => setImmediate(r));
  channel.emit("message", { type: "control", id: "c", action: "shutdown" });
  await new Promise((r) => setImmediate(r));
  assert.equal(stops, 1);
  channel.emit("message", { type: "control", id: "d", action: "execute" });
  assert.equal(replies.at(-1).safe, false);
});
test("desktop session token is mandatory for documents, assets and auth endpoints", () => {
  const token = "a".repeat(48),
    guard = tokenGuard({
      AUTOSELL_DESKTOP: "1",
      AUTOSELL_DESKTOP_TOKEN: token,
    });
  let allowed = 0,
    status;
  const response = {
    status(code) {
      status = code;
      return this;
    },
    json() {},
  };
  guard({ headers: {} }, response, () => allowed++);
  assert.equal(status, 403);
  guard(
    { headers: { "x-autosell-desktop": "wrong" } },
    response,
    () => allowed++,
  );
  assert.equal(allowed, 0);
  guard(
    { headers: { "x-autosell-desktop": token } },
    response,
    () => allowed++,
  );
  assert.equal(allowed, 1);
  assert.throws(() => tokenGuard({ AUTOSELL_DESKTOP: "1" }), /token/);
});

test('an admitted customer sale can finish its bound payout while new sales are fenced', async t => {
  const { maintenance } = await fixture(t);
  const services = require('../../services');
  const previous = services.maintenance;
  services.maintenance = maintenance;
  t.after(() => { services.maintenance = previous; });
  const admission = require('../../sell/intake-admission');
  const ticket = admission.acquire('fixture-seller');
  t.after(() => ticket.release());
  ticket.bindSale('fixture-sale');
  maintenance.begin('3.0.1');
  assert.equal(maintenance.status().safe, false);
  assert.throws(() => admission.acquire('new-seller'), /maintenance/);
  let paid = false;
  await admission.runSale('fixture-seller', 'fixture-sale', () => maintenance.run('payout', async () => {
    maintenance.assertCanDispatch();
    paid = true;
  }));
  assert.equal(paid, true);
  await assert.rejects(admission.runSale('fixture-seller', 'different-sale', () => maintenance.run('payout', () => {})), /maintenance/);
  ticket.release();
  assert.equal(maintenance.status().safe, true);
});
