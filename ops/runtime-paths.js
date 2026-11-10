"use strict";
const path = require("node:path");
const fs = require("node:fs");
const application = path.resolve(__dirname, "..");
function resolveHome(env = process.env) {
  if (!env.AUTOSELL_HOME) return application;
  if (!path.isAbsolute(env.AUTOSELL_HOME))
    throw Error("AUTOSELL_HOME must be an absolute persistent workspace path");
  return path.resolve(env.AUTOSELL_HOME);
}
const home = resolveHome();
const data = (...parts) => path.join(home, "data", ...parts);
function initialize() {
  fs.mkdirSync(data(), { recursive: true, mode: 0o700 });
  process.chdir(home);
}
function resolveStored(value) {
  const original = path.resolve(value);
  const aliases = data("migration-paths.json");
  if (!fs.existsSync(aliases)) return original;
  const mapping = JSON.parse(fs.readFileSync(aliases, "utf8"));
  if (mapping.version !== 1 || path.resolve(mapping.target) !== home)
    return original;
  const relative = path.relative(path.resolve(mapping.source), original);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    return original;
  return path.resolve(home, relative);
}
module.exports = {
  application,
  home,
  data,
  envFile: path.join(home, ".env"),
  resolveHome,
  initialize,
  resolveStored,
};
