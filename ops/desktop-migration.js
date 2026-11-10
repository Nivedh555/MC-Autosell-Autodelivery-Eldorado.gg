"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
};
function write(file, data) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), {
    mode: 0o600,
    flush: true,
  });
  fs.renameSync(file + ".tmp", file);
}
function regular(file) {
  if (fs.lstatSync(file).isSymbolicLink())
    throw Error("Linked files cannot be migrated: " + path.basename(file));
}
function inventory(root) {
  const result = {};
  function walk(file, relative) {
    regular(file);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) {
        if (
          relative === "data" &&
          [
            "process.lock",
            "migration-recovery.lock",
            "migrated-to.json",
          ].includes(name)
        )
          continue;
        if (
          ["SingletonLock", "SingletonSocket", "SingletonCookie"].includes(name)
        )
          throw Error("Close the seller browser before importing its profile");
        walk(path.join(file, name), relative + "/" + name);
      }
    } else if (stat.isFile()) result[relative] = hash(file);
    else throw Error("Unsupported file in the workspace");
  }
  for (const name of ["data", "auth-cache", ".env"])
    if (fs.existsSync(path.join(root, name))) walk(path.join(root, name), name);
  return result;
}
function copyVerified(from, to, manifest, { replace = false } = {}) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const [relative, expected] of Object.entries(manifest)) {
    const source = path.join(from, relative),
      destination = path.join(to, relative);
    if (!inside(from, source) || !inside(to, destination))
      throw Error("Invalid backup path");
    regular(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) regular(destination);
    if (
      fs.existsSync(destination) &&
      hash(destination) !== expected &&
      !replace
    )
      throw Error("Existing migration file differs; preserve it for review");
    if (!fs.existsSync(destination) || hash(destination) !== expected) {
      fs.copyFileSync(source, destination + ".copying");
      fs.chmodSync(destination + ".copying", 0o600);
      if (hash(destination + ".copying") !== expected)
        throw Error("Backup verification failed");
      fs.renameSync(destination + ".copying", destination);
    }
    if (hash(source) !== expected || hash(destination) !== expected)
      throw Error("Source changed during migration; close all old processes");
  }
}
function integrity(directory) {
  const db = new DatabaseSync(path.join(directory, "data", "autosell.db"));
  try {
    const checks = db.prepare("PRAGMA quick_check").all();
    if (checks.some((row) => Object.values(row)[0] !== "ok"))
      throw Error("Imported database integrity check failed");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
function migrate(sourceInput, targetInput, { fault = () => {} } = {}) {
  if (!path.isAbsolute(sourceInput) || !path.isAbsolute(targetInput))
    throw Error("Choose absolute installation and workspace paths");
  const source = fs.realpathSync(sourceInput),
    target = path.resolve(targetInput);
  if (inside(source, target) || inside(target, source))
    throw Error(
      "Import destination must be separate from the old installation",
    );
  regular(source);
  if (!fs.existsSync(path.join(source, "data", "autosell.db")))
    throw Error("The selected installation has no Autosell database");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  regular(path.dirname(target));
  const staging = target + ".migration",
    journalFile = path.join(staging, "migration.json"),
    retiredFile = path.join(source, "data", "migrated-to.json");
  const sameManifest = (a, b) => require("node:util").isDeepStrictEqual(a, b);
  if (fs.existsSync(staging)) regular(staging);
  else fs.mkdirSync(staging, { mode: 0o700 });
  let journal;
  if (fs.existsSync(journalFile)) {
    regular(journalFile);
    journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    if (journal.source !== source || journal.target !== target)
      throw Error("A different migration owns this destination");
  } else {
    journal = {
      version: 1,
      source,
      target,
      phase: "STARTED",
      startedAt: new Date().toISOString(),
    };
    write(journalFile, journal);
  }
  if (fs.existsSync(retiredFile)) {
    const retired = JSON.parse(fs.readFileSync(retiredFile, "utf8"));
    if (retired.target !== target)
      throw Error("This installation was already imported elsewhere");
    if (fs.existsSync(path.join(target, "data", "migration-paths.json"))) {
      const mapping = JSON.parse(
        fs.readFileSync(
          path.join(target, "data", "migration-paths.json"),
          "utf8",
        ),
      );
      if (mapping.source !== source || mapping.target !== target)
        throw Error("Existing workspace belongs to a different import");
      journal.phase = "COMMITTED";
      write(journalFile, journal);
      return {
        ok: true,
        workspace: target,
        backup: retired.backup,
        resumed: true,
      };
    }
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length)
    throw Error(
      "Destination already contains user data; it will not be overwritten",
    );
  // Same exclusive process lock as startup; the old program cannot start mid-copy.
  const release = require("./instance-lock").acquire(
    path.join(source, "data"),
    { migrationTarget: target },
  );
  try {
    const manifest = inventory(source);
    if (!manifest["data/vault.enc"])
      throw Error("The selected installation is missing its encrypted vault");
    if (!journal.manifest || !sameManifest(journal.manifest, manifest)) {
      if (fs.existsSync(retiredFile) || journal.phase === "RETIRED")
        throw Error(
          "The retired source changed. Review its original backup before importing.",
        );
      journal.snapshotId = crypto.randomUUID();
      journal.manifest = manifest;
      journal.phase = "STARTED";
      write(journalFile, journal);
    }
    const snapshot = path.join(staging, journal.snapshotId || "");
    if (!inside(staging, snapshot))
      throw Error("Invalid migration snapshot path");
    const backup = path.join(snapshot, "backup"),
      payload = path.join(snapshot, "workspace");
    copyVerified(source, backup, manifest);
    if (!sameManifest(manifest, inventory(backup)))
      throw Error("Backup does not match the complete source inventory");
    if (!["STAGED", "RETIRED"].includes(journal.phase)) {
      journal.phase = "BACKED_UP";
      write(journalFile, journal);
      fault("backup");
      copyVerified(backup, payload, manifest, { replace: true });
      integrity(payload);
      write(path.join(payload, "data", "migration-paths.json"), {
        version: 1,
        source,
        target,
      });
      journal.stagedManifest = inventory(payload);
      journal.phase = "STAGED";
      write(journalFile, journal);
      fault("staged");
    }
    // Retire the source before making the new database runnable. A crash here is
    // resumable with this same journal, never by creating a second obligation set.
    if (!sameManifest(journal.stagedManifest, inventory(payload)))
      throw Error(
        "Staged workspace changed before activation. Preserve the verified backup for recovery.",
      );
    if (!sameManifest(manifest, inventory(source)))
      throw Error(
        "Source changed before activation. Close old processes and retry the import.",
      );
    // Older backend versions do not recognize migrated-to.json but reject an
    // invalid process PID. Atomically replace our own lock with a durable fence.
    write(path.join(source, "data", "process.lock"), {
      pid: 0,
      retiredTo: target,
      reason: "Workspace imported into Autosell desktop",
    });
    fault("fenced");
    write(retiredFile, {
      version: 1,
      target,
      backup,
      importedAt: new Date().toISOString(),
    });
    journal.phase = "RETIRED";
    write(journalFile, journal);
    fault("retired");
    if (fs.existsSync(target)) fs.rmdirSync(target); // only the empty, checked destination
    fs.renameSync(payload, target);
    journal.phase = "COMMITTED";
    write(journalFile, journal);
    return { ok: true, workspace: target, backup, resumed: false };
  } finally {
    release();
  }
}
if (require.main === module) {
  try {
    const result = migrate(process.argv[2] || "", process.argv[3] || "");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
module.exports = { migrate, inventory, copyVerified, inside };
