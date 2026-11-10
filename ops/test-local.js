"use strict";
// Stage a credential-free copy so test data can never touch the owner's SQLite file or wallet.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "autosell-v3-tests-"));
const modules = path.join(root, "node_modules");
const parts = [
  "api",
  "audit",
  "db",
  "discord",
  "ledger",
  "marketplace",
  "minecraft",
  "ops",
  "payments",
  "sell",
  "services",
  "settings",
  "test",
  "treasury",
  "v3",
  "vault",
  "wallet",
  "web",
  "index.js",
  "config.js",
  "services.js",
  "constants.js",
  "package.json",
];
try {
  for (const entry of parts)
    fs.cpSync(path.join(root, entry), path.join(staging, entry), {
      recursive: true,
    });
  const env = { ...process.env, NODE_PATH: modules, NODE_ENV: "test" };
  for (const key of Object.keys(env))
    if (
      /^(DISCORD_|LTC_|VAULT_|ELDORADO_|AUTOSELL_|OPENAI_|MC_EMAIL|API_KEY)/.test(key)
    )
      delete env[key];
  for (const [group, serial] of [
    ["unit", false],
    ["integration", true],
    ["v3", true],
    ["ui", true],
  ]) {
    const files = fs
      .readdirSync(path.join(staging, "test", group))
      .filter((f) => f.endsWith(".test.js"))
      .map((f) => path.join("test", group, f));
    const result = spawnSync(
      process.execPath,
      ["--test", ...(serial ? ["--test-concurrency=1"] : []), ...files],
      { cwd: staging, env, stdio: "inherit" },
    );
    if (result.status !== 0) throw Error(group + " tests failed");
  }
  console.log(
    "Local simulation passed. No live orders or blockchain transactions were submitted.",
  );
} finally {
  if (
    path.dirname(staging) !== os.tmpdir() ||
    !path.basename(staging).startsWith("autosell-v3-tests-")
  )
    throw Error("Unexpected test directory");
  fs.rmSync(staging, { recursive: true, force: true });
}
