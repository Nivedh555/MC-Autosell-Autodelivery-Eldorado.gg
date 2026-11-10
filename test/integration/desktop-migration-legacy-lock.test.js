"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../../db/database");
const { migrate } = require("../../ops/desktop-migration");

// The pre-desktop launcher validates this PID without reading migrated-to.json.
function legacyLauncherAcceptsLock(directory) {
  const file = path.join(directory, "process.lock");
  const previous = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isInteger(previous.pid) || previous.pid < 1)
    throw Error("Invalid process lock; inspect it manually");
  return true;
}

test("a crash after fencing the old launcher can recover before its retirement marker exists", async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "autosell-migration-fence-test-"));
  t.after(() => {
    assert.equal(path.dirname(parent), os.tmpdir());
    assert(path.basename(parent).startsWith("autosell-migration-fence-test-"));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const source = path.join(parent, "original");
  const target = path.join(parent, "desktop-workspace");
  const sourceData = path.join(source, "data");
  const db = await Database.open(path.join(sourceData, "autosell.db"));
  db.raw().prepare("INSERT INTO delivery_orders(id,fingerprint,payload,state,mode,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?)")
    .run("previously-paid", "fixture-fingerprint", "{}", "DELIVERED", "mock", 0, 0);
  await db.close();
  fs.writeFileSync(path.join(sourceData, "vault.enc"), "encrypted-fixture");

  assert.throws(() => migrate(source, target, {
    fault(phase) {
      if (phase === "fenced") throw Error("Simulated crash after old-launcher fence");
    },
  }), /Simulated crash/);
  assert.equal(fs.existsSync(path.join(sourceData, "migrated-to.json")), false);
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => legacyLauncherAcceptsLock(sourceData), /Invalid process lock/);

  const recovered = migrate(source, target);
  assert.equal(recovered.ok, true);
  assert.throws(() => legacyLauncherAcceptsLock(sourceData), /Invalid process lock/);
  assert.equal(fs.existsSync(path.join(sourceData, "migration-recovery.lock")), false);
  const imported = await Database.open(path.join(target, "data", "autosell.db"));
  assert.deepEqual(imported.raw().prepare("SELECT id,state FROM delivery_orders").all().map(row => ({ ...row })), [
    { id: "previously-paid", state: "DELIVERED" },
  ]);
  await imported.close();
});
