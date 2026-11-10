"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { configurePairing, validatePairing } = require("./pairing");

const VERSION = "26.3";
const FABRIC = "0.20.1";
const MODS = ["autosell-bridge-3.0.0.jar", "fabric-api-0.165.2+26.3.jar"];
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
function fail(message) { const error = Error(message); error.status = 400; return error; }
function iniValue(text, key) {
  const line = text.split(/\r?\n/).find(value => value.startsWith(key + "="));
  return line ? line.slice(key.length + 1).trim() : "";
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function safePath(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw fail("The selected file is outside the Prism instance");
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw fail("Choose an instance with regular folders and files. Linked files cannot be installed safely.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
async function readSmall(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw fail("Unexpected Prism configuration file");
  return fs.readFile(file, "utf8");
}

class MinecraftOnboarding {
  constructor(services, options = {}) {
    this.services = services;
    this.platform = options.platform || process.platform;
    this.home = options.home || os.homedir();
    this.env = options.env || process.env;
    this.release = options.release || path.resolve(__dirname, "../release");
    this.stateFile = options.stateFile || path.resolve("data/prism-roots.json");
    this.extraRoots = [];
    this.installing = false;
  }
  candidates() {
    if (this.platform === "win32") return [
      path.join(this.env.APPDATA || path.join(this.home, "AppData/Roaming"), "PrismLauncher"),
      path.join(this.home, "scoop/persist/prismlauncher"),
    ];
    return [path.join(this.env.XDG_DATA_HOME || path.join(this.home, ".local/share"), "PrismLauncher"),
      path.join(this.home, ".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher")];
  }
  async root(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 1000) throw fail("Enter the full Prism Launcher root folder path");
    const root = await fs.realpath(directory);
    const config = await readSmall(path.join(root, "prismlauncher.cfg"));
    const configured = iniValue(config, "InstanceDir");
    if (configured.startsWith("@")) throw fail("This Prism instances path is encoded. Choose a standard Instances folder in Prism settings.");
    const instancesPath = path.resolve(root, configured || "instances");
    await safePath(instancesPath, instancesPath);
    if (!(await fs.stat(instancesPath)).isDirectory()) throw fail("The Prism instances folder is missing. Open Prism once, then try again.");
    return { id: digest(root).slice(0, 20), path: root, instancesPath };
  }
  async roots() {
    let saved = [];
    try { saved = JSON.parse(await readSmall(this.stateFile)); } catch (error) { if (error.code !== "ENOENT") saved = []; }
    const candidates = [...this.candidates(), ...this.extraRoots, ...(Array.isArray(saved) ? saved.slice(0, 12) : [])];
    const found = new Map();
    for (const candidate of candidates) {
      try { const root = await this.root(candidate); found.set(root.id, root); } catch { /* Missing launcher roots are shown through the empty state. */ }
    }
    return [...found.values()];
  }
  async registerRoot(directory) {
    const root = await this.root(directory);
    this.extraRoots = [...new Set([...this.extraRoots, root.path])].slice(-12);
    const roots = await this.roots();
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = this.stateFile + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(temporary, json(roots.map(item => item.path)), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, this.stateFile);
    return { ...await this.status(), selectedRootId: root.id };
  }
  async artifacts() {
    const manifest = await readSmall(path.join(this.release, "SHA256SUMS"));
    const result = [];
    for (const name of MODS) {
      const entry = manifest.split(/\r?\n/).find(line => line.trim().split(/\s+/).at(-1) === "release/" + name);
      const expected = entry?.trim().split(/\s+/)[0];
      if (!/^[a-f0-9]{64}$/.test(expected || "")) throw fail("The packaged Minecraft mod manifest is incomplete. Reinstall Autosell.");
      const bytes = await fs.readFile(path.join(this.release, name));
      if (digest(bytes) !== expected) throw fail("The packaged Minecraft mods failed integrity verification. Reinstall Autosell before setup.");
      result.push({ name, sha256: expected, bytes });
    }
    return result;
  }
  async instance(root, name) {
    if (typeof name !== "string" || !name || name !== path.basename(name) || /[\\/:\x00-\x1f]/.test(name) || name === "." || name === "..") throw fail("Select an instance from the detected list");
    const directory = path.join(root.instancesPath, name);
    await safePath(root.instancesPath, directory);
    const pack = JSON.parse(await readSmall(path.join(directory, "mmc-pack.json")));
    const config = await readSmall(path.join(directory, "instance.cfg"));
    const components = Array.isArray(pack.components) ? pack.components : [];
    const minecraft = components.find(item => item.uid === "net.minecraft")?.version;
    const fabric = components.find(item => item.uid === "net.fabricmc.fabric-loader")?.version;
    const modern = path.join(directory, "minecraft"), legacy = path.join(directory, ".minecraft");
    if (await exists(modern) && await exists(legacy)) throw fail("This instance contains two game folders. Select a dedicated Autosell instance.");
    const gamePath = await exists(legacy) ? legacy : modern;
    await safePath(root.instancesPath, gamePath);
    return { id: name, name: iniValue(config, "name") || name, path: directory, gamePath, minecraft, fabric,
      compatible: minecraft === VERSION && fabric === FABRIC && !components.some(item => /forge|quilt/i.test(item.uid)),
      running: iniValue(config, "IsRunning") === "true" };
  }
  async instances(root) {
    const found = [];
    for (const entry of (await fs.readdir(root.instancesPath, { withFileTypes: true })).slice(0, 300)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try { found.push(await this.instance(root, entry.name)); } catch { /* Unsupported or incomplete instances cannot be selected. */ }
    }
    return found;
  }
  async status() {
    const roots = await this.roots();
    for (const root of roots) root.instances = await this.instances(root);
    let release;
    try { release = { ready: true, mods: (await this.artifacts()).map(({ name, sha256 }) => ({ name, sha256 })) }; }
    catch (error) { release = { ready: false, error: error.message }; }
    return { version: VERSION, fabric: FABRIC, java: 25, server: this.services.gameBridge.options?.host || process.env.AUTOSELL_GAME_HOST || "donutsmp.net",
      roots, release, accounts: this.services.gameBridge.status(), installing: this.installing };
  }
  async createInstance(root, accountId) {
    const name = "Autosell-" + accountId;
    const destination = path.join(root.instancesPath, name);
    if (await exists(destination)) {
      const instance = await this.instance(root, name);
      if (!instance.compatible || !(await exists(path.join(destination, ".autosell-created")))) throw fail("That dedicated instance name already exists. Choose the compatible instance from the list.");
      return instance;
    }
    const staging = await fs.mkdtemp(path.join(root.instancesPath, ".autosell-setup-"));
    await fs.writeFile(path.join(staging, "instance.cfg"), "[General]\nInstanceType=OneSix\nname=Autosell Delivery " + accountId + "\niconKey=default\n", { flag: "wx" });
    await fs.writeFile(path.join(staging, "mmc-pack.json"), json({ formatVersion: 1, components: [
      { uid: "net.minecraft", version: VERSION, important: true },
      { uid: "net.fabricmc.fabric-loader", version: FABRIC },
    ] }), { flag: "wx" });
    await fs.writeFile(path.join(staging, ".autosell-created"), "1\n", { flag: "wx" });
    await fs.rename(staging, destination);
    return this.instance(root, name);
  }
  async install(body) {
    if (this.installing) throw fail("Minecraft setup is already running. Wait for it to finish.");
    this.installing = true;
    try { return await this.installSelected(body); } finally { this.installing = false; }
  }
  async installSelected(body) {
    if (!body || Object.keys(body).some(key => !["rootId", "instanceId", "create", "accountId", "ign", "gameClosed", "confirmToken"].includes(key))) throw fail("Unsupported Minecraft setup option");
    const { accountId, ign } = body;
    if (!/^(buyer|seller)[1-9][0-9]?$/.test(accountId) || !/^\.?[A-Za-z0-9_]{3,16}$/.test(ign)) throw fail("Enter an account slot and exact Minecraft IGN");
    if (body.gameClosed !== true) throw fail("Close this Minecraft instance and confirm it is closed before installation");
    if (this.services.gameBridge.status().some(account => account.id === accountId && account.connected)) throw fail("Close the connected Minecraft client before installing its mods");
    const root = (await this.roots()).find(item => item.id === body.rootId);
    if (!root) throw fail("Refresh the Prism folders and choose one from the list");
    try { validatePairing(this.services, accountId, ign); } catch (error) { throw fail(error.message); }
    let previous;
    try { previous = await this.services.gameBridge.existingPairing(accountId, ign); } catch (error) { throw fail(error.message); }
    const artifacts = await this.artifacts();
    const instance = body.create === true ? await this.createInstance(root, accountId) : await this.instance(root, body.instanceId);
    if (!instance.compatible) throw fail("Choose Minecraft 26.3 with Fabric Loader 0.20.1, or create an Autosell instance");
    if (instance.running) throw fail("Close this Minecraft instance in Prism before installing");
    const mods = path.join(instance.gamePath, "mods"), config = path.join(instance.gamePath, "config");
    const pairingFile = path.join(config, "autosell-bridge.json");
    await safePath(root.instancesPath, mods);
    await safePath(root.instancesPath, pairingFile);
    if (await exists(pairingFile)) {
      const installed = JSON.parse(await readSmall(pairingFile));
      if (!previous || JSON.stringify(installed) !== JSON.stringify(previous)) {
        const same = previous && ["accountId", "ign", "token", "url", "version", "server"].every(key => installed[key] === previous[key]);
        if (!same) throw fail("This instance has a different pairing file. Choose a new dedicated instance to keep its existing pairing.");
      }
    }
    if (await exists(mods)) {
      for (const name of await fs.readdir(mods)) {
        if (/^(autosell-bridge|fabric-api)[-\.].*\.jar$/i.test(name) && !MODS.includes(name)) throw fail("This instance has another Autosell bridge or Fabric API version. Create a dedicated instance.");
      }
    }
    for (const artifact of artifacts) {
      const target = path.join(mods, artifact.name);
      await safePath(root.instancesPath, target);
      if (await exists(target) && digest(await fs.readFile(target)) !== artifact.sha256) throw fail("An existing mod has different contents. Choose a dedicated instance to keep that file.");
    }
    await fs.mkdir(mods, { recursive: true });
    await fs.mkdir(config, { recursive: true });
    for (const artifact of artifacts) {
      const target = path.join(mods, artifact.name);
      if (!(await exists(target))) await fs.writeFile(target, artifact.bytes, { flag: "wx", mode: 0o600 });
      if (digest(await fs.readFile(target)) !== artifact.sha256) throw fail("Installed mod verification failed. Retry setup with Minecraft closed.");
    }
    const pairing = await configurePairing(this.services, accountId, ign, { reuseExisting: true });
    if (!(await exists(pairingFile))) {
      const temporary = path.join(config, ".autosell-pairing-" + crypto.randomUUID());
      await fs.writeFile(temporary, json(pairing), { flag: "wx", mode: 0o600 });
      try { await fs.link(temporary, pairingFile); } finally { await fs.unlink(temporary); }
    }
    await safePath(root.instancesPath, pairingFile);
    const written = JSON.parse(await readSmall(pairingFile));
    const current = await this.services.gameBridge.existingPairing(accountId, ign);
    if (!["accountId", "ign", "token", "url", "version", "server"].every(key => written[key] === pairing[key] && current?.[key] === pairing[key]))
      throw fail("The pairing changed during setup. Close the game, refresh and select a new dedicated instance.");
    return { success: true, instance, accountId, ign, server: pairing.server,
      message: "Setup complete. In Prism, select " + instance.name + ", choose the Minecraft account " + ign + ", launch and join " + pairing.server + "." };
  }
}

module.exports = { MinecraftOnboarding, VERSION, FABRIC, MODS, safePath };
