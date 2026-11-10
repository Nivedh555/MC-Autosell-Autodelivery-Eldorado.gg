"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const Database = require("../../db/database");
const { migrate } = require("../../ops/desktop-migration");
const { acquire } = require("../../ops/instance-lock");
async function fixture(t) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "autosell-migration-test-"),
  );
  t.after(() => {
    if (
      path.dirname(parent) !== os.tmpdir() ||
      !path.basename(parent).startsWith("autosell-migration-test-")
    )
      throw Error("Invalid test path");
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const source = path.join(parent, "old"),
    target = path.join(parent, "new");
  const db = await Database.open(path.join(source, "data", "autosell.db"));
  db.raw()
    .prepare(
      "INSERT INTO delivery_orders(id,fingerprint,payload,state,mode,created_ms,updated_ms) VALUES('paid','f','{}','DELIVERED','mock',0,0)",
    )
    .run();
  await db.close();
  fs.writeFileSync(path.join(source, "data", "vault.enc"), "encrypted-fixture");
  fs.writeFileSync(path.join(source, ".env"), "TEST_FIXTURE=true\n");
  return { source, target };
}
test("verified import preserves paid journals and vault, retires old workspace, and never overwrites a destination", async (t) => {
  const { source, target } = await fixture(t),
    result = migrate(source, target);
  assert.equal(result.ok, true);
  assert.equal(
    fs.readFileSync(path.join(target, "data", "vault.enc"), "utf8"),
    "encrypted-fixture",
  );
  assert.equal(
    fs.readFileSync(path.join(result.backup, "data", "vault.enc"), "utf8"),
    "encrypted-fixture",
  );
  const db = await Database.open(path.join(target, "data", "autosell.db"));
  assert.equal(
    db.raw().prepare("SELECT state FROM delivery_orders WHERE id='paid'").get()
      .state,
    "DELIVERED",
  );
  await db.close();
  assert.throws(() => acquire(path.join(source, "data")), /migrated/);
  assert.equal(migrate(source, target).resumed, true);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(source, "data", "process.lock"), "utf8"),
    ).pid,
    0,
  );
});
test("resumed import captures files created since backup and refuses a changed staged vault", async (t) => {
  const { source, target } = await fixture(t);
  assert.throws(
    () =>
      migrate(source, target, {
        fault: (phase) => {
          if (phase === "backup") throw Error("pause");
        },
      }),
    /pause/,
  );
  fs.writeFileSync(path.join(source, "data", "later.json"), "new journal");
  assert.throws(
    () =>
      migrate(source, target, {
        fault: (phase) => {
          if (phase === "staged") throw Error("pause");
        },
      }),
    /pause/,
  );
  const journal = JSON.parse(
    fs.readFileSync(path.join(target + ".migration", "migration.json"), "utf8"),
  );
  const staged = path.join(
    target + ".migration",
    journal.snapshotId,
    "workspace",
    "data",
  );
  assert.equal(
    fs.readFileSync(path.join(staged, "later.json"), "utf8"),
    "new journal",
  );
  fs.writeFileSync(path.join(staged, "vault.enc"), "corrupt");
  assert.throws(() => migrate(source, target), /Staged workspace changed/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(
    fs.existsSync(path.join(source, "data", "migrated-to.json")),
    false,
  );
});
test("import resumes interrupted backup, staging and retirement without a second journal set", async (t) => {
  for (const phase of ["backup", "staged", "retired"]) {
    const { source, target } = await fixture(t);
    assert.throws(
      () =>
        migrate(source, target, {
          fault: (at) => {
            if (at === phase) throw Error("simulated interruption");
          },
        }),
      /simulated/,
    );
    assert.equal(migrate(source, target).ok, true);
    const db = await Database.open(path.join(target, "data", "autosell.db"));
    assert.equal(
      db.raw().prepare("SELECT COUNT(*) AS n FROM delivery_orders").get().n,
      1,
    );
    await db.close();
  }
});
test("live workspace, nested destination and existing user data are refused", async (t) => {
  const { source, target } = await fixture(t);
  const release = acquire(path.join(source, "data"));
  assert.throws(() => migrate(source, target), /Another Autosell/);
  release();
  assert.throws(() => migrate(source, path.join(source, "nested")), /separate/);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "valuable.txt"), "keep");
  assert.throws(() => migrate(source, target), /already contains/);
  assert.equal(
    fs.readFileSync(path.join(target, "valuable.txt"), "utf8"),
    "keep",
  );
});
test("older backend refuses a newer database instead of silently running old payment code", async (t) => {
  const { source } = await fixture(t),
    file = path.join(source, "data", "autosell.db");
  const db = await Database.open(file);
  db.raw()
    .prepare("INSERT INTO schema_version VALUES(999,?)")
    .run(new Date().toISOString());
  await db.close();
  await assert.rejects(Database.open(file), /newer Autosell/);
});
