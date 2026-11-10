"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const roots = [
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
  "treasury",
  "v3",
  "vault",
  "wallet",
];
let count = 0;
function inspect(file) {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(file)) inspect(path.join(file, child));
    return;
  }
  if (!file.endsWith(".js")) return;
  new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
  count++;
}
for (const entry of [
  ...roots,
  "index.js",
  "config.js",
  "services.js",
  "constants.js",
])
  inspect(entry);
console.log("Parsed " + count + " JavaScript files.");
