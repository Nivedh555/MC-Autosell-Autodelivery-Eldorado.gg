"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { MinecraftOnboarding, MODS } = require("../../v3/minecraft-onboarding");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t, platform = "linux") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "autosell-prism-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "PrismLauncher"), release = path.join(directory, "release");
  await fs.mkdir(path.join(root, "instances"), { recursive: true });
  await fs.writeFile(path.join(root, "prismlauncher.cfg"), "[General]\nInstanceDir=instances\n");
  await fs.mkdir(release);
  const hashes = [];
  for (const name of MODS) {
    const bytes = Buffer.from("fixture mod " + name);
    await fs.writeFile(path.join(release, name), bytes);
    hashes.push(sha(bytes) + "  release/" + name);
  }
  await fs.writeFile(path.join(release, "SHA256SUMS"), hashes.join("\n"));
  const pairs = [{ pairIndex: 1, buyerId: "buyer1", sellerId: "seller1" }];
  const paired = new Map();
  let pairCalls = 0;
  const services = {
    gameBridge: {
      options: { host: "donutsmp.net" },
      status: () => [...paired.values()].map(({ token, ...account }) => ({ id: account.accountId, ...account, connected: false })),
      async existingPairing(id, ign) {
        const previous = paired.get(id);
        if (previous && previous.ign !== ign) throw Error("This account slot belongs to a different Minecraft IGN");
        return previous || null;
      },
      async pair(accountId, ign) {
        pairCalls++;
        const value = { url: "ws://127.0.0.1:4210", accountId, ign, token: "a".repeat(64), server: "donutsmp.net", version: "26.3" };
        paired.set(accountId, value);
        return value;
      },
    },
    pairsRepo: { getPairByIndex: index => pairs.find(pair => pair.pairIndex === index), savePair: value => { pairs[0] = value; } },
    settings: { get: async () => ({}), set: async () => {} },
  };
  const options = { platform, home: directory, env: platform === "win32" ? { APPDATA: directory } : { XDG_DATA_HOME: directory }, release, stateFile: path.join(directory, "data/prism-roots.json") };
  const service = new MinecraftOnboarding(services, options);
  const rootId = (await service.roots())[0].id;
  const body = { rootId, create: true, accountId: "seller1", ign: "FixturePlayer", gameClosed: true };
  return { directory, root, release, services, service, options, body, pairCalls: () => pairCalls, paired };
}

test("Windows discovery creates the supported Prism instance, verifies mods, pairs once and retries without token rotation", async t => {
  const f = await fixture(t, "win32");
  const installed = await f.service.install(f.body);
  assert.equal(installed.instance.compatible, true);
  assert.equal(installed.instance.name, "Autosell Delivery seller1");
  for (const name of MODS) assert.deepEqual(await fs.readFile(path.join(installed.instance.gamePath, "mods", name)), await fs.readFile(path.join(f.release, name)));
  const file = path.join(installed.instance.gamePath, "config/autosell-bridge.json");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).ign, "FixturePlayer");
  const before = await fs.readFile(file);
  await f.service.install(f.body);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(f.pairCalls(), 1);
  const status = await f.service.status();
  assert.equal(status.roots[0].instances[0].compatible, true);
  assert.equal(status.release.ready, true);
  assert.equal(JSON.stringify(status).includes("a".repeat(64)), false);
});

test("Linux custom and Flatpak roots are discoverable without reading Microsoft accounts", async t => {
  const f = await fixture(t);
  const flatpak = path.join(f.directory, ".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher");
  await fs.mkdir(path.join(flatpak, "instances"), { recursive: true });
  await fs.writeFile(path.join(flatpak, "prismlauncher.cfg"), "[General]\n");
  await fs.writeFile(path.join(flatpak, "accounts.json"), "This credential file must not be parsed");
  assert.equal((await f.service.roots()).length, 2);
  const portable = path.join(f.directory, "portable");
  await fs.mkdir(path.join(portable, "instances"), { recursive: true });
  await fs.writeFile(path.join(portable, "prismlauncher.cfg"), "[General]\n");
  await f.service.registerRoot(portable);
  assert.equal((await new MinecraftOnboarding(f.services, f.options).roots()).length, 3);
});

test("tampered packaged mods, unknown roots and invalid accounts fail before pairing", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.install({ ...f.body, rootId: "unknown" }), /Refresh the Prism/);
  await assert.rejects(f.service.install({ ...f.body, accountId: "seller2" }), /Create this account pair/);
  await assert.rejects(f.service.install({ ...f.body, ign: "another name" }), /exact Minecraft IGN/);
  await fs.writeFile(path.join(f.release, MODS[0]), "tampered");
  await assert.rejects(f.service.install(f.body), /integrity verification/);
  assert.equal((await f.service.status()).release.ready, false);
  assert.equal(f.pairCalls(), 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, "instances")), []);
});

test("existing incompatible instances and conflicting mod or pairing files are preserved", async t => {
  const f = await fixture(t);
  const installed = await f.service.install(f.body);
  const select = { ...f.body, create: false, instanceId: installed.instance.id };
  const mod = path.join(installed.instance.gamePath, "mods", MODS[0]);
  await fs.writeFile(mod, "keep this existing file");
  await assert.rejects(f.service.install(select), /different contents/);
  assert.equal(await fs.readFile(mod, "utf8"), "keep this existing file");
  await fs.writeFile(mod, await fs.readFile(path.join(f.release, MODS[0])));
  const pairing = path.join(installed.instance.gamePath, "config/autosell-bridge.json");
  const foreign = JSON.stringify({ accountId: "seller9", token: "private" });
  await fs.writeFile(pairing, foreign);
  await assert.rejects(f.service.install(select), /different pairing file/);
  assert.equal(await fs.readFile(pairing, "utf8"), foreign);
  await assert.rejects(f.service.install({ ...select, instanceId: "../elsewhere" }), /detected list/);
  await fs.writeFile(path.join(installed.instance.path, "mmc-pack.json"), JSON.stringify({ components: [{ uid: "net.minecraft", version: "1.21" }] }));
  await assert.rejects(f.service.install(select), /Choose Minecraft/);
  assert.equal(f.pairCalls(), 1);
});

test("linked config directories cannot write outside a chosen Prism instance", async t => {
  const f = await fixture(t);
  const installed = await f.service.createInstance((await f.service.roots())[0], "seller1");
  const outside = path.join(f.directory, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(installed.gamePath, { recursive: true });
  await fs.symlink(outside, path.join(installed.gamePath, "config"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.service.install({ ...f.body, create: false, instanceId: installed.id }), /Linked files/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.pairCalls(), 0);
});

test("interrupted settings persistence retries using the already-created bridge token", async t => {
  const f = await fixture(t);
  const original = f.services.settings.set;
  f.services.settings.set = async () => { throw Error("fixture persistence interruption"); };
  await assert.rejects(f.service.install(f.body), /persistence interruption/);
  f.services.settings.set = original;
  const recovered = await f.service.install(f.body);
  assert.equal(recovered.success, true);
  assert.equal(f.pairCalls(), 1);
  assert.equal((await fs.readdir(path.join(recovered.instance.gamePath, "config"))).length, 1);
});

test("connected accounts, active obligations and concurrent installation are rejected", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.install({ ...f.body, gameClosed: false }), /Close this Minecraft/);
  f.services.gameBridge.status = () => [{ id: "seller1", connected: true }];
  await assert.rejects(f.service.install(f.body), /connected Minecraft/);
  f.services.gameBridge.status = () => [];
  f.services.pairsRepo.getPairByIndex = () => ({ pairIndex: 1, currentOrderId: "fixture-active-order" });
  await assert.rejects(f.service.install(f.body), /active or unresolved/);
  f.service.installing = true;
  await assert.rejects(f.service.install(f.body), /already running/);
  assert.equal(f.pairCalls(), 0);
});

test("onboarding routes use owner authentication and require reauthentication for writes", async t => {
  const f = await fixture(t);
  const express = require("express"), middleware = require("../../api/middleware"), shared = require("../../services");
  const previousKey = shared.apiKey;
  shared.apiKey = "fixture-onboarding-api-key";
  t.after(() => { shared.apiKey = previousKey; });
  const app = express();
  app.use(express.json(), middleware.verifyAuth, require("../../v3/minecraft-onboarding-routes")(f.services, f.options));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => server.close());
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(url)).status, 401);
  const headers = { "x-api-key": shared.apiKey, "content-type": "application/json" };
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal((await fetch(url + "/install", { method: "POST", headers, body: JSON.stringify(f.body) })).status, 403);
  const token = "fixture-reauth";
  middleware.CONFIRM_TOKENS.set(token, { expires: Date.now() + 60000, subject: "api-owner" });
  const response = await fetch(url + "/install", { method: "POST", headers: { ...headers, "x-confirm-token": token }, body: JSON.stringify(f.body) });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes("a".repeat(64)), false);
});
