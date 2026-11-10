"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { GameBridge } = require("../../v3/bridge");
test("a paired client can report commands; a lost /pay is recorded once and never replayed", async (t) => {
  const db = new DatabaseSync(":memory:"),
    secrets = new Map();
  const hub = new GameBridge(
    {
      db: { raw: () => db },
      vault: {
        store: (id, value) => secrets.set(id, value),
        retrieve: (id) => secrets.get(id),
      },
    },
    { port: 0, host: "localhost:25566" },
  );
  await hub.start();
  t.after(async () => {
    await hub.close();
    db.close();
  });
  const pair = await hub.pair("buyer1", "FixturePlayer");
  const hello = { ...pair, type: "hello", host: pair.server };
  async function open(message) {
    const ws = new WebSocket(pair.url);
    await once(ws, "open");
    ws.send(JSON.stringify(message));
    return ws;
  }
  const impostor = await open({ ...hello, token: "0".repeat(64) });
  assert.equal((await once(impostor, "close"))[0], 1008);
  const connected = once(hub, "connected"),
    client = await open(hello);
  await connected;
  assert.throws(()=>hub.requireReceiptClient('buyer1'),{code:'RECEIPT_CLIENT_REQUIRED'});
  await assert.rejects(hub.screenshot('buyer1','order-uuid'),{code:'RECEIPT_CLIENT_REQUIRED'});
  assert.equal(db.prepare('SELECT count(*) n FROM v3_bridge_calls').get().n,0);
  await assert.rejects(
    hub.request("buyer1", "command", { command: "/op stranger" }),
    /not allowed/,
  );
  const read = hub.request("buyer1", "command", { command: "/bal" }),
    [buf] = await once(client, "message");
  client.send(
    JSON.stringify({
      type: "result",
      seq: 1,
      id: JSON.parse(buf).id,
      ok: true,
      result: { sent: true },
    }),
  );
  assert.deepEqual(await read, { sent: true });
  const unknown = assert.rejects(
    hub.request("buyer1", "command", { command: "/pay Buyer_1 500000000" }),
    /disconnect/,
  );
  const [pay] = await once(client, "message");
  client.terminate();
  await unknown;
  assert.equal(
    db
      .prepare("SELECT state FROM v3_bridge_calls WHERE id=?")
      .get(JSON.parse(pay).id).state,
    "UNKNOWN",
  );
  const second = once(hub, "connected"),
    next = await open({...hello,receiptGeometry:1});
  await second;
  assert.doesNotThrow(()=>hub.requireReceiptClient('buyer1'));
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM v3_bridge_calls WHERE request LIKE '%/pay %'",
      )
      .get().n,
    1,
  );
  next.close();
});
test("renaming a spider spawner and adding skeleton lore cannot pass item verification", () => {
  const { isWantedSpawner } = require("../../minecraft/spawner");
  const fixture = (id) => ({
    name: "spawner",
    displayName: "Skeleton Spawner",
    isSpawner: true,
    customLore: ["minecraft:skeleton"],
    nbt: { BlockEntityTag: { SpawnData: { entity: { id } } } },
  });
  assert.equal(isWantedSpawner(fixture("minecraft:spider")), false);
  assert.equal(isWantedSpawner(fixture("minecraft:skeleton")), true);
  assert.equal(
    isWantedSpawner({ ...fixture("minecraft:skeleton"), name: "paper" }),
    false,
  );
});
test("node-less payout checks require matching transaction id, address and litoshi", async (t) => {
  const { PayoutMonitor } = require("../../v3/payout-monitor");
  const txid = "ab".repeat(32);
  const monitor = new PayoutMonitor({
    wallet: {
      _bcy: () => "https://example.test",
      _tryProviders: (ops) => ops.blockcypher(),
    },
  });
  const row = { txid, address: "recipient-fixture", litoshi: "5000" };
  let value = 5001;
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => ({
      hash: txid,
      confirmations: 2,
      outputs: [{ addresses: [row.address], value }],
    }),
  }));
  await assert.rejects(monitor.check(row), /does not contain/);
  value = 5000;
  assert.deepEqual(await monitor.check(row), {
    txid,
    confirmations: 2,
    status: "CONFIRMED",
  });
});
