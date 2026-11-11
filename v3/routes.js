"use strict";
const router = require("express").Router(),
  s = require("../services");
const { asyncHandler, requireReauth } = require("../api/middleware");
const path = require("node:path"),
  fs = require("node:fs");
const run = asyncHandler;
router.use('/customer-messages', require('./customer-message-routes'));
const settingsKeys = [
  "pricing.money.ratePerMillion",
  "pricing.spawner.priceUsd",
  "pricing.money.enabled",
  "pricing.spawner.enabled",
  "wallet.ltc.sendEnabled",
  "wallet.maxPerTxUsd",
  "wallet.maxPerDayUsd",
  "discord.guild.id",
  "discord.channel.logs",
  "discord.category.sell",
  "discord.user.ownerId",
];
const secretKeys = [
  "discord.bot.token",
  "eldorado.api.clientId",
  "eldorado.api.clientSecret",
  "wallet.ltc.blockcypherToken",
];
router.get(
  "/overview",
  run(async (_req, res) => {
    const db = s.db.raw(),
      counts = {};
    for (const row of db
      .prepare("SELECT state,COUNT(*) n FROM delivery_orders GROUP BY state")
      .all())
      counts[row.state] = row.n;
    const intake = db
      .prepare("SELECT state,COUNT(*) n FROM intake_sales GROUP BY state")
      .all();
    const payouts = db
      .prepare(
        "SELECT p.id,p.address,p.litoshi,p.fiat_micros,p.state,p.txid,p.reason,p.created_ms,c.status chain_status,c.confirmations FROM payout_intents p LEFT JOIN v3_payout_status c ON c.id=p.id ORDER BY p.created_ms DESC LIMIT 50",
      )
      .all();
    const orders = db
      .prepare(
        "SELECT id,payload,state,reason,account_id,evidence,created_ms,updated_ms FROM delivery_orders ORDER BY created_ms DESC LIMIT 100",
      )
      .all()
      .map(({ payload, evidence, ...o }) => ({
        ...o,
        order: JSON.parse(payload),
        hasEvidence: Boolean(evidence),
      }));
    const recent = db
      .prepare(
        "SELECT order_id,kind,data,wall_ms FROM delivery_events ORDER BY sequence DESC LIMIT 30",
      )
      .all()
      .map(({ data, ...e }) => ({ ...e, data: JSON.parse(data) }));
    res.json({
      version: "3.0.1",
      runtime:s.buildStatus?.snapshot()||null,
      gameVersion: "26.3",
      platform: process.platform,
      paused:
        !(await require("../treasury/trading-controls").globallyEnabled()),
      counts,
      intake,
      payouts,
      orders,
      recent,
      accounts: s.gameBridge.status(),
      wallet: {
        configured: Boolean(s.wallet?.enabled),
        address: s.wallet?.address || null,
        sendEnabled: s.store.sendEnabled(),
      },
      discord: { connected: Boolean(s.discordClient?.isReady?.()) },
      browser: s.browserBridge?.status() || {
        connected: false,
        state: "CLOSED",
      },
      completionPending: db
        .prepare("SELECT * FROM v3_completions WHERE state IN ('PENDING','UNKNOWN','FAILED')")
        .all(),
    });
  }),
);
router.get(
  "/settings",
  run(async (_req, res) => {
    const values = {};
    for (const key of settingsKeys) values[key] = await s.settings.get(key);
    for (const key of secretKeys)
      values[key] = Boolean(await s.settings.get(key));
    values["payout.policy"] = await s.settings.get("payout.policy");
    res.json(values);
  }),
);
router.get(
  "/discord/preview",
  run(async (_req, res) => {
    const design = require("../discord/panel-designs");
    const choices = ["main", "test"].flatMap((source) =>
      Array.from(
        { length: source === "main" ? design.count : design.testCount },
        (_, index) => ({
          source,
          index,
          label: design.labelFor(index, source),
        }),
      ),
    );
    const selected =
      _req.query.source || _req.query.index != null
        ? choices.find(
            (c) =>
              c.source === _req.query.source &&
              String(c.index) === _req.query.index,
          )
        : design.getChoice();
    if (!selected) throw Error("Unknown panel style");
    const display = design.computeDisplay(
      {
        ratePerM: s.store.getRate(),
        price: s.store.getPrice(),
        ltc: null,
        usd: null,
        canDonut: null,
        canSkellys: null,
      },
      s.store.buyMoneyEnabled(),
      s.store.buySkellyEnabled(),
      !(await require("../treasury/trading-controls").globallyEnabled()),
    );
    res.json({
      ...design.renderEmbed(selected.index, display, selected.source).toJSON(),
      selected,
      choices,
    });
  }),
);
router.use("/game/onboarding", require("./minecraft-onboarding-routes")(s));
router.use(requireReauth);
router.post(
  "/discord/design",
  run(async (req, res) => {
    const design = require("../discord/panel-designs"),
      { source, index } = req.body;
    if (
      !["main", "test"].includes(source) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= (source === "main" ? design.count : design.testCount)
    )
      throw Error("Unknown panel style");
    if (source === "main") design.setChosenMain(index);
    else design.setChosenTest(index);
    res.json({ label: design.labelFor(index, source) });
  }),
);
router.post(
  "/settings",
  run(async (req, res) => {
    if (
      !req.body ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some(
        (k) => ![...settingsKeys, ...secretKeys].includes(k),
      )
    )
      throw Error("Unsupported setting");
    for (const [key, value] of Object.entries(req.body)) {
      if (secretKeys.includes(key) && (!value || typeof value !== "string"))
        continue;
      if (
        key.startsWith("pricing.") &&
        typeof value === "number" &&
        (!Number.isFinite(value) || value <= 0 || value > 100000)
      )
        throw Error("Enter a positive buying rate");
      if (key === "wallet.ltc.sendEnabled")
        throw Error("Use the wallet payout policy to enable sending");
      const validation = s.settings.validate(key, value);
      if (!validation.valid) throw Error(validation.error);
    }
    for (const [key, value] of Object.entries(req.body))
      if (!secretKeys.includes(key) || value)
        await s.settings.set(key, value, "v3-dashboard");
    if (
      req.body["eldorado.api.clientId"] ||
      req.body["eldorado.api.clientSecret"]
    ) {
      s.browserBridge?.pause(
        "Seller credentials changed; restart and verify the matching seller identity",
      );
      s.marketplacePendingRestart = {
        adapter: s.marketplace,
        reason: "Restart the backend after changing seller credentials",
      };
    }
    await s.config.bindRegistry(s.settings);
    if (Object.hasOwn(req.body, "pricing.money.ratePerMillion"))
      s.store.setRate(req.body["pricing.money.ratePerMillion"]);
    if (Object.hasOwn(req.body, "pricing.spawner.priceUsd"))
      s.store.setPrice(req.body["pricing.spawner.priceUsd"]);
    res.json({
      success: true,
      message:
        "Settings saved. Restart the backend after changing Discord or seller credentials.",
    });
  }),
);
router.post(
  "/controls",
  run(async (req, res) => {
    if (typeof req.body.enabled !== "boolean")
      throw Error("Choose enabled or paused");
    await s.settings.set(
      "general.bot.paused",
      !req.body.enabled,
      "v3-dashboard",
    );
    s.store.setAutosellPaused(!req.body.enabled);
    s.listingManager?.requestSync({ pauseOnly: !req.body.enabled });
    res.json({ success: true });
  }),
);
router.post(
  "/game/pair",
  run(async (req, res) => {
    const config = await require("./pairing").configurePairing(s, req.body.accountId, req.body.ign);
    res.setHeader("Cache-Control", "no-store");
    res.json(config);
  }),
);
router.post(
  "/game/capture",
  run(async (req, res) => {
    if (!s.gameBridge.clients.has(req.body.accountId))
      throw Error("Select an online client");
    const capture = await s.gameBridge.screenshot(
      req.body.accountId,
      "owner-preview",
    );
    res.json({ name: capture.name, url: "/api/v3/captures/" + capture.name });
  }),
);
router.get("/captures/:name", (req, res) => {
  if (!/^[a-f0-9-]{36}\.png$/.test(req.params.name)) return res.sendStatus(404);
  res.sendFile(path.resolve("data/captures", req.params.name));
});
router.get(
  "/evidence/:id",
  run(async (req, res) => {
    const row = s.deliveryService.repo.get(req.params.id);
    if (!row?.evidence) return res.sendStatus(404);
    const e = JSON.parse(row.evidence);
    const root = path.resolve("data/proofs");
    const directory = path.resolve(e.directory);
    if (!directory.startsWith(root + path.sep))
      throw Error("Invalid evidence path");
    res.sendFile(
      path.join(
        directory,
        e.screenshotCaptured
          ? e.screenshotName === "delivery-" + e.artifactId + ".png"
            ? e.screenshotName
            : "delivery.png"
          : "delivery-logs.txt",
      ),
    );
  }),
);
router.post(
  "/browser/open",
  run(async (_req, res) =>
    res.json(
      await s.browserBridge.open({
        channel: "chromium",
        sessionMode: "persistent",
        chromeProfile: "",
        actionMs: 750,
        characterMs: 1,
        timeoutMs: 30000,
      }),
    ),
  ),
);
router.post(
  "/browser/check",
  run(async (_req, res) => res.json(await s.browserBridge.checkConnection())),
);
router.get(
  "/eldorado/offers",
  run(async (_req, res) => {
      const state = require('../marketplace/connection-state').connectionState(await s.settings.get('eldorado.connection'), s);
      if (state.restartRequired) throw Error(state.reason);
    const result = await s.marketplace.inspectOffersForSetup();
    const accounts = s.pairManager
      .getPairs()
      .filter((pair) => !pair.disabled)
      .map((pair) =>
        require("../treasury/trading-controls").deliveryAccount(pair),
      )
      .filter((id) => s.gameBridge.tokens.has(id));
    res.json({
      offers: result.offers.map((o) => ({
        id: o.id,
        gameLabel: o.gameLabel,
        quantityDisplay: o.quantityDisplay,
        status: o.status,
        pricePerMillion: o.currency === 'USD' && o.unitCoins === '1000000' ? o.price : null,
      })),
      accounts: [...new Set(accounts)],
    });
  }),
);
router.post(
  "/eldorado/offer",
  run(async (req, res) => {
    if (!s.settings.getSync("general.bot.paused"))
      throw Error("Pause trading before linking a different offer");
    const { offerId, accountId } = req.body;
    const pair = s.pairManager
      .getPairs()
      .find(
        (p) =>
          !p.disabled &&
          require("../treasury/trading-controls").deliveryAccount(p) ===
            accountId,
      );
    if (!pair || !s.gameBridge.tokens.has(accountId))
      throw Error("Pair an enabled Minecraft delivery account first");
    const observed = (await s.marketplace.inspectOffersForSetup()).offers.find(
      (offer) => offer.id === offerId,
    );
    if (!observed?.apiBinding)
      throw Error(
        "The selected currency offer was not found in both seller accounts",
      );
    const old = await s.settings.get("listing.policy");
    if (old.automatic?.enabled)
      throw Error(
        "Disable automatic offer management in Advanced settings before selecting an existing offer",
      );
    const listing = {
      ...old,
      offerId,
      holderAccount: accountId,
      apiBinding: observed.apiBinding,
      gameId: observed.gameId,
      serverId: observed.serverId,
      observedSellerHref: observed.sellerHref,
      managePrice: false,
      manageQuantity: false,
    };
    await s.settings.set("listing.policy", listing, "v3-offer-binding");
    require("../marketplace/order-monitor").monitoring(s.db, listing);
    res.json({ success: true, offerId, accountId });
  }),
);
router.post(
  "/orders/refresh",
  run(async (_req, res) => {
    await s.orderPoller.poll({ inspect: true });
    res.json({ success: true });
  }),
);
router.post(
  "/wallet/refresh",
  run(async (_req, res) => {
    if (!s.wallet.enabled)
      throw Error("Create or import a payout wallet first");
    res.json(await s.wallet.getReadStatus());
  }),
);
let initializingWallet = false;
function initializeWallet(action) {
  return run(async (req, res) => {
    if (initializingWallet)
      throw Error("Wallet initialization is already in progress");
    initializingWallet = true;
    try {
      if (
        s.wallet.enabled ||
        (await s.settings.get("wallet.ltc.mnemonic")) ||
        (await s.settings.get("wallet.ltc.wif"))
      )
        throw Error("A wallet is already configured");
      await action(req, res);
    } finally {
      initializingWallet = false;
    }
  });
}
router.post(
  "/wallet/create",
  initializeWallet(async (_req, res) => {
    const mnemonic = require("bip39").generateMnemonic(256);
    await s.settings.set("wallet.ltc.mnemonic", mnemonic, "v3-wallet-create");
    await s.config.bindRegistry(s.settings);
    s.wallet.init();
    if (!s.wallet.enabled) throw Error("Wallet initialization failed");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      mnemonic,
      address: s.wallet.address,
      derivationPath: s.config.wallet.derivationPath,
    });
  }),
);
router.post(
  "/wallet/import",
  initializeWallet(async (req, res) => {
    if (s.wallet.enabled) throw Error("A wallet is already configured");
    const mnemonic = String(req.body.mnemonic || "").trim();
    if (!require("bip39").validateMnemonic(mnemonic))
      throw Error("Enter a valid BIP39 recovery phrase");
    await s.settings.set("wallet.ltc.mnemonic", mnemonic, "v3-wallet-import");
    await s.config.bindRegistry(s.settings);
    s.wallet.init();
    res.json({ address: s.wallet.address });
  }),
);
router.post(
  "/wallet/policy",
  run(async (req, res) => {
    const { perSaleUsd, perDayUsd, enabled } = req.body;
    if (
      ![perSaleUsd, perDayUsd].every(
        (x) => Number.isFinite(x) && x > 0 && x <= 100000,
      ) ||
      perSaleUsd > perDayUsd ||
      typeof enabled !== "boolean"
    )
      throw Error(
        "Enter positive payout caps, with daily cap at least the sale cap",
      );
    const policy = require("../payments/payout-policy").validate({
      enabled,
      addressMode: "linked-seller",
      allowedAddresses: [],
      maxPerTxFiatMicros: String(Math.round(perSaleUsd * 1e6)),
      maxPerDayFiatMicros: String(Math.round(perDayUsd * 1e6)),
    });
    await s.settings.set("payout.policy", policy, "v3-dashboard");
    await s.settings.set("wallet.ltc.sendEnabled", enabled, "v3-dashboard");
    s.store.setSetting("ltcSendEnabled", enabled);
    res.json({ success: true });
  }),
);
router.post(
  "/wallet/check-transactions",
  run(async (_req, res) => {
    await s.v3PayoutMonitor.tick();
    res.json({ success: true });
  }),
);
router.get("/review", (_req, res) => {
  const db = s.db.raw();
  res.json({
    deliveries: db
      .prepare(
        "SELECT id,state,reason,account_id FROM delivery_orders WHERE state IN ('NEEDS_OPERATOR','RECONCILIATION_REQUIRED') ORDER BY updated_ms DESC",
      )
      .all(),
    intake: db
      .prepare(
        "SELECT id,state,reason,account_id,sender,amount FROM intake_sales WHERE state='NEEDS_OPERATOR'",
      )
      .all(),
    spawners: db.prepare("SELECT id,status AS state,json_extract(details,'$.reason') AS reason FROM orders WHERE status='needs_operator'").all(),
    notifications: db.prepare("SELECT order_id AS id,state,reason FROM v3_completions WHERE state IN ('PENDING','UNKNOWN','FAILED')").all(),
    messages: db.prepare("SELECT order_id AS id,logical_key AS message,state,reason FROM message_outbox WHERE state IN ('UNKNOWN','FAILED') ORDER BY updated_ms DESC").all(),
    payouts: db
      .prepare(
        "SELECT id,state,reason,txid,address,litoshi FROM payout_intents WHERE state!='BROADCAST'",
      )
      .all(),
  });
});
router.use((error, _req, res, _next) =>
  res.status(400).json({ error: error.message }),
);
module.exports = router;
