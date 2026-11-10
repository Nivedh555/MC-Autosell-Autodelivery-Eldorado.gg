"use strict";
const { GameBridge } = require("./bridge");
async function init(s) {
  const db = s.db.raw();
  db.exec(
    "CREATE TABLE IF NOT EXISTS v3_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  if (!db.prepare("SELECT 1 FROM v3_meta WHERE key='initialized'").get()) {
    const values = {
      "general.bot.paused": true,
      "security.api.port": 4203,
      "security.api.allowedOrigins": [
        "http://127.0.0.1:4203",
        "http://localhost:4203",
      ],
      "mc.server.version": "26.3",
      "eldorado.connection": "hybrid",
      "eldorado.browser.options": {
        channel: "chromium",
        sessionMode: "persistent",
        chromeProfile: "",
        actionMs: 750,
        characterMs: 1,
        timeoutMs: 30000,
      },
      "eldorado.chat.local": {
        autoSend: true,
        confirmIgn: true,
        minimalChat: true,
        openingEnabled: true,
        fastReplies: true,
        pollMs: 2000,
        typingMinMs: 0,
        typingMaxMs: 0,
        minIntervalMs: 0,
      },
      "payout.policy": {
        enabled: false,
        addressMode: "linked-seller",
        allowedAddresses: [],
        maxPerTxFiatMicros: "10000000",
        maxPerDayFiatMicros: "50000000",
      },
      "wallet.ltc.sendEnabled": false,
    };
    for (const [key, value] of Object.entries(values))
      if (s.settings.definitions.has(key))
        await s.settings.set(key, value, "v3-first-run");
    db.prepare("INSERT INTO v3_meta VALUES('initialized',?)").run(
      new Date().toISOString(),
    );
  }
  await s.config.bindRegistry(s.settings);
  s.gameBridge = await new GameBridge(s).start();
  s.v3Notifications = new (require("./notifications").CompletionNotifications)(
    s,
  );
  s.v3Notifications.start();
  s.v3PayoutMonitor = new (require("./payout-monitor").PayoutMonitor)(s);
  s.v3PayoutMonitor.start();
}
module.exports = { init };
