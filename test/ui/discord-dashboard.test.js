"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), express = require("express"), path = require("node:path");
const { chromium } = require("playwright");

const GUILD = "111111111111111111", CHANNEL = "222222222222222222", MESSAGE = "333333333333333333";

async function fixture(t) {
  const app = express(), calls = [], errors = [];
  const state = {
    token: "fixture-token", guild: GUILD, logs: "", postEnabled: true, stale: false,
    panel: { channelId: CHANNEL, messageId: MESSAGE }, template: { title: "Saved design", description: "Saved body", color: "#dc143c", buttonLayout: "moneyAutosell", fields: [{ name: "Rate", value: "{{ratePer1b}}" }] },
  };
  app.use(express.json());
  app.use("/api", (req, res) => {
    calls.push({ method: req.method, path: req.path, body: req.body });
    if (req.path === "/events") { res.setHeader("Content-Type", "text/event-stream"); return res.end(": connected\n\n"); }
    if (req.path === "/auth/status") return res.json({ setupRequired: false, authenticated: true });
    if (req.path === "/v2/discord/dashboard") {
      const fields = [
        { id: "discord.bot.token", label: "Bot token", secret: true, value: "", configured: Boolean(state.token) },
        { id: "discord.guild.id", label: "Server ID", secret: false, value: state.guild, configured: Boolean(state.guild) },
        { id: "discord.user.ownerId", label: "Owner user ID", secret: false, value: "", configured: false },
        { id: "discord.role.admin", label: "Admin role ID", secret: false, value: "", configured: false },
        { id: "discord.channel.logs", label: "Logs channel ID", secret: false, value: state.logs, configured: Boolean(state.logs) },
        { id: "discord.category.sell", label: "Selling tickets category ID", secret: false, value: "", configured: false },
        { id: "discord.role.sold", label: "Completed seller role ID", secret: false, value: "", configured: false },
        { id: "discord.channel.vouch", label: "Vouch channel ID", secret: false, value: "", configured: false },
        { id: "discord.role.automodExempt", label: "Moderation exempt role ID", secret: false, value: "", configured: false },
      ];
      return res.json({
        success: true, connected: true, botName: "FixtureBot#0001", guild: { id: GUILD, name: "Fixture Guild" }, guildError: "",
        fields, buying: { pricePerSpawnerUsd: 0.05, ratePerMillion: 0.027, moneyEnabled: true, spawnerEnabled: true, paused: false },
        panel: state.panel ? { ...state.panel, stale: state.stale, reason: state.stale ? "The saved panel message is missing." : "" } : null,
        template: state.template, preview: null, channels: [{ id: CHANNEL, name: "sell-here", type: 0, parent: "" }], roles: [],
        intake: [{ id: "guild", label: "Server", state: "configured", detail: "Server ID is saved." }],
        links: { pairs: "#pairs", sellers: "#sellers", wallet: "#wallet", intake: "/intake-setup", operations: "/operations" },
      });
    }
    if (req.path === "/v2/discord/settings" && req.method === "POST") {
      const values = req.body.values || {};
      if (values["discord.bot.token"]) state.token = values["discord.bot.token"];
      if (values["discord.guild.id"] !== undefined) state.guild = values["discord.guild.id"];
      if (values["discord.channel.logs"] !== undefined) state.logs = values["discord.channel.logs"];
      return res.json({ success: true, message: "Discord settings saved." });
    }
    if (req.path === "/v2/discord/buying" && req.method === "POST") return res.json({ success: true, buying: req.body, message: "Buying controls saved." });
    if (req.path === "/v2/discord/check") return res.json({ success: true, ok: true, message: "Connected to Fixture Guild. All configured channels and roles were found.", checks: [{ id: "guild", label: "Server", state: "configured", detail: "Server ID is saved." }] });
    if (req.path === "/v2/discord/panel/preview") return res.json({ success: true, embed: { title: req.body.template.title, description: req.body.template.description, color: 0xdc143c, fields: req.body.template.fields || [], footer: { text: "" } } });
    if (req.path === "/v2/discord/panel/save") { state.template = req.body.template; return res.json({ success: true, template: state.template, message: "Panel design saved for future posts and refreshes." }); }
    if (req.path === "/v2/discord/panel/post") {
      if (!state.postEnabled) return res.status(409).json({ error: "Allow the bot to View Channel, Send Messages and Embed Links in this channel." });
      state.panel = { channelId: req.body.channelId, messageId: MESSAGE }; state.template = req.body.template || state.template;
      return res.json({ success: true, channelId: req.body.channelId, messageId: MESSAGE, message: "Panel posted to #sell-here." });
    }
    if (req.path === "/v2/discord/panel/refresh") return res.json({ success: true, message: "Saved panel refreshed." });
    if (req.path === "/ai-chat") return res.json({});
    return res.json({ success: true, pairs: [], orders: [], sellers: [], accounts: [], sales: [], wallet: {}, botPaused: false });
  });
  const dist = path.resolve(__dirname, "../../web/dist");
  app.get(["/", "/classic"], (_req, res) => res.sendFile(path.join(dist, "index.html")));
  app.use(express.static(dist));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: "reduce" });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port + "/#discord");
  await page.getByRole("heading", { name: "Discord Dashboard", exact: true }).waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return { page, state, calls };
}

test("Discord Dashboard masks the token, saves settings, previews and posts a panel", async t => {
  const { page, state, calls } = await fixture(t);
  const token = page.getByLabel("Bot token", { exact: true });
  assert.equal(await token.inputValue(), "");
  assert.match(await token.getAttribute("placeholder"), /Saved/);
  const guild = page.getByLabel("Server ID", { exact: true });
  await guild.fill("999999999999999999");
  await page.getByRole("button", { name: "Save Discord settings", exact: true }).click();
  await page.getByText("Discord settings saved.", { exact: true }).first().waitFor();
  const saved = calls.filter(call => call.path === "/v2/discord/settings").at(-1);
  assert.equal(saved.body.values["discord.bot.token"], "");
  assert.equal(state.guild, "999999999999999999");

  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await page.getByText(/Connected to Fixture Guild/).first().waitFor();

  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Panel embed", exact: true }) });
  await panel.getByLabel("Title", { exact: true }).fill("Fixture panel");
  await panel.locator("textarea").fill("Buy from this panel");
  await panel.getByRole("button", { name: "Preview panel", exact: true }).click();
  await page.locator(".desk-embed-preview").getByText("Fixture panel", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Post panel to Discord", exact: true }).click();
  await page.getByText("Panel posted to #sell-here.", { exact: true }).first().waitFor();
  const posted = calls.filter(call => call.path === "/v2/discord/panel/post").at(-1);
  assert.equal(posted.body.channelId, CHANNEL);
  assert.equal(posted.body.template.title, "Fixture panel");
  assert.equal(state.panel.messageId, MESSAGE);

  await page.reload();
  await page.getByText("Saved panel", { exact: true }).waitFor();
  await page.getByText("Current", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Bot token", { exact: true }).inputValue(), "");
});

test("Discord Dashboard surfaces permission errors, stale panels and audio preferences", async t => {
  const { page, state } = await fixture(t);
  state.postEnabled = false;
  await page.getByRole("button", { name: "Post panel to Discord", exact: true }).click();
  await page.getByText(/View Channel/).first().waitFor();

  state.stale = true;
  await page.reload();
  await page.getByText("Needs attention", { exact: true }).waitFor();
  await page.getByText(/saved panel message is missing/).waitFor();

  const payment = page.getByLabel("Payment received", { exact: true });
  assert.equal(await payment.isChecked(), true);
  await payment.uncheck();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("autosell_discord_audio_v1")).sounds.payment), false);

  assert.equal(await page.getByRole("link", { name: "Sellers and cashouts" }).getAttribute("href"), "#sellers");
  assert.equal(await page.getByRole("link", { name: "Seller payout wallet" }).getAttribute("href"), "#wallet");
  assert.equal(await page.getByRole("link", { name: "Payout limits and setup" }).getAttribute("href"), "/intake-setup");
});
