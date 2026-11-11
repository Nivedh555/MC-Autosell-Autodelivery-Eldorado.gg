"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), express = require("express"), path = require("node:path");
const { chromium } = require("playwright");

test("the shipped dashboard installs the chosen Minecraft instance and gives exact launch instructions", async t => {
  const app = express(), calls = [], errors = [];
  let installed = false, missing = false;
  const root = { id: "prism-root", path: "C:/Fixture/PrismLauncher", instances: [
    { id: "compatible", name: "Existing delivery", gamePath: "C:/Fixture/PrismLauncher/instances/compatible/minecraft", compatible: true },
    { id: "old", name: "Old version", compatible: false },
  ] };
  app.use(express.json());
  app.use("/api", (req, res) => {
    calls.push({ path: req.path, method: req.method, body: req.body });
    if (req.path === "/events") { res.setHeader("Content-Type", "text/event-stream"); return res.end(": connected\n\n"); }
    if (req.path === "/v3/game/onboarding") return missing ? res.status(404).json({ error: "Not found" }) : res.json({ roots: [root], release: { ready: true }, server: "donutsmp.net" });
    if (req.path === "/v3/game/onboarding/install") {
      installed = true;
      return res.json({ success: true, accountId: "seller1", ign: "FixturePlayer", instance: root.instances[0], message: "Setup complete. Launch Existing delivery as FixturePlayer and join donutsmp.net." });
    }
    if (req.path === "/v3/overview") return res.json({ accounts: installed ? [{ id: "seller1", ign: "FixturePlayer", connected: false }] : [], orders: [], payouts: [], wallet: {} });
    if (req.path === "/marketplace/pairs") return res.json({ success: true, pairs: [{ id: 1, pairIndex: 1, buyerId: "buyer1", sellerId: "seller1", state: "IDLE" }] });
    return res.json({ success: true, pairs: [], accounts: [], orders: [], sellers: [], sales: [] });
  });
  app.use(express.static(path.resolve(__dirname, "../../web/dist")));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port + "/#pairs");
  const setup = page.locator(".desk-minecraft-setup");
  await setup.getByRole("heading", { name: "Set up Minecraft in Prism" }).waitFor();
  await setup.getByLabel("Minecraft instance", { exact: true }).selectOption("compatible");
  assert.equal(await setup.locator('option[value="old"]').evaluate(option => option.disabled), true);
  await setup.getByLabel("Exact Minecraft IGN", { exact: true }).fill("FixturePlayer");
  assert.equal(await setup.getByRole("button", { name: "Install mods and pair" }).isDisabled(), true);
  await setup.getByLabel("I have closed this Minecraft instance").check();
  await setup.getByRole("button", { name: "Install mods and pair" }).click();
  await setup.getByText("Minecraft files installed", { exact: true }).waitFor();
  const request = calls.find(call => call.path === "/v3/game/onboarding/install");
  assert.deepEqual(request.body, { rootId: "prism-root", instanceId: "compatible", accountId: "seller1", ign: "FixturePlayer", gameClosed: true });
  assert.match(await setup.innerText(), /Accounts → Manage Accounts → Add Microsoft/);
  assert.match(await setup.innerText(), /Select Existing delivery, choose FixturePlayer/);
  assert.match(await setup.innerText(), /Direct Connection → donutsmp.net/);
  assert.match(await setup.innerText(), /Waiting for the game connection/);
  await page.setViewportSize({ width: 560, height: 900 });
  assert.equal(await setup.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  if (process.env.AUTOSELL_UI_CAPTURE_DIR) await setup.screenshot({ path: path.join(process.env.AUTOSELL_UI_CAPTURE_DIR, "minecraft-setup.png") });
  missing = true;
  await setup.getByRole("button", { name: "Refresh Prism folders" }).click();
  await setup.getByText(/Restart Autosell to load Minecraft setup/).waitFor();
  assert.deepEqual(errors, []);
});
