"use strict";
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const IGN = /^\.?[A-Za-z0-9_]{3,16}$/;
const commandAllowed = (value) =>
  typeof value === "string" &&
  value.length < 160 &&
  /^(?:\/bal(?: \.?[A-Za-z0-9_]{3,16})?|\/pay \.?[A-Za-z0-9_]{3,16} [1-9][0-9]{0,15}|\/tpa \.?[A-Za-z0-9_]{3,16}|\/home(?: [A-Za-z0-9_-]{1,32})?|\/spawn|\/ec)$/.test(
    value,
  );
function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function allowedHost(host, configured) {
  const normalize = (v) =>
    String(v ?? "")
      .toLowerCase()
      .replace(/:25565$/, "");
  if (configured) return normalize(host) === normalize(configured);
  return /^(?:[a-z0-9-]+\.)*donutsmp\.net$/i.test(normalize(host));
}
class GameBridge extends EventEmitter {
  constructor(services, options = {}) {
    super();
    this.services = services;
    this.options = options;
    this.clients = new Map();
    this.pending = new Map();
    this.tokens = new Map();
    this.server = null;
  }
  async start() {
    const db = this.services.db.raw();
    db.exec(`CREATE TABLE IF NOT EXISTS v3_bridge_calls(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,request TEXT NOT NULL,result TEXT,created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS v3_accounts(id TEXT PRIMARY KEY,ign TEXT NOT NULL UNIQUE,created_ms INTEGER NOT NULL)`);
    db.prepare(
      "UPDATE v3_bridge_calls SET state='UNKNOWN' WHERE state='DISPATCHED'",
    ).run();
    for (const row of db.prepare("SELECT id FROM v3_accounts").all())
      this.tokens.set(
        row.id,
        await this.services.vault.retrieve("v3.bridge." + row.id),
      );
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: this.options.port ?? 4210,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.server.on("connection", (ws, req) => {
      if (req.headers.origin) {
        ws.close(1008, "Browser clients are not supported");
        return;
      }
      let identified = false;
      const timer = setTimeout(() => ws.close(1008, "Pairing required"), 5000);
      ws.on("error", () => {});
      ws.on("message", (bytes) => {
        try {
          const msg = JSON.parse(bytes.toString());
          if (!identified) {
            const account = db
              .prepare("SELECT * FROM v3_accounts WHERE id=?")
              .get(String(msg.accountId));
            if (
              msg.type !== "hello" ||
              !account ||
              !equal(this.tokens.get(account.id), msg.token) ||
              msg.ign !== account.ign ||
              msg.version !== "26.3" ||
              !allowedHost(
                msg.host,
                this.options.host || process.env.AUTOSELL_GAME_HOST,
              ) ||
              this.services.sessions?.manualStops?.has(account.id)
            )
              throw Error("Pairing, IGN, game version or server did not match");
            if (this.clients.has(account.id))
              throw Error("This account already has a connected client");
            identified = true;
            clearTimeout(timer);
            ws.accountId = account.id;
            ws.meta = {
              ign: msg.ign,
              host: msg.host,
              version: msg.version,
              connectedAt: Date.now(),
              lastSeen: Date.now(),
              sessionId: crypto.randomUUID(),
              receiptGeometry: msg.receiptGeometry === 1 ? 1 : 0,
            };
            ws.lastSeq = 0;
            this.clients.set(account.id, ws);
            this.emit("connected", account.id, ws.meta);
            return;
          }
          if (!Number.isSafeInteger(msg.seq) || msg.seq <= ws.lastSeq)
            throw Error("Repeated or invalid event sequence");
          ws.lastSeq = msg.seq;
          ws.meta.lastSeen = Date.now();
          if (msg.type === "result") {
            const pending = this.pending.get(msg.id);
            if (!pending || pending.accountId !== ws.accountId) return;
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            const payload = JSON.stringify(msg.result ?? null);
            db.prepare(
              "UPDATE v3_bridge_calls SET state=?,result=? WHERE id=?",
            ).run(
              msg.ok ? "DONE" : "FAILED",
              payload.length < 65536 ? payload : '{"largeResult":true}',
              msg.id,
            );
            msg.ok
              ? pending.resolve(msg.result)
              : pending.reject(
                  Error(
                    String(msg.error || "Game operation failed").slice(0, 500),
                  ),
                );
          } else if (
            msg.type === "chat" &&
            typeof msg.text === "string" &&
            msg.text.length <= 4000 &&
            ["system", "chat"].includes(msg.kind)
          )
            this.emit("chat", ws.accountId, msg);
          else if (
            msg.type === "snapshot" &&
            Array.isArray(msg.inventory) &&
            msg.inventory.length <= 46
          )
            this.emit("snapshot", ws.accountId, msg);
        } catch (error) {
          ws.close(1008, error.message.slice(0, 120));
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (!identified) return;
        if (this.clients.get(ws.accountId) === ws)
          this.clients.delete(ws.accountId);
        for (const [id, p] of this.pending)
          if (p.accountId === ws.accountId) {
            clearTimeout(p.timer);
            this.pending.delete(id);
            db.prepare(
              "UPDATE v3_bridge_calls SET state='UNKNOWN' WHERE id=?",
            ).run(id);
            p.reject(
              Error(
                "Minecraft disconnected; operation outcome requires reconciliation",
              ),
            );
          }
        this.emit("disconnected", ws.accountId);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients.values())
        if (Date.now() - ws.meta.lastSeen > 15000) ws.terminate();
    }, 5000);
    this.heartbeat.unref();
    return this;
  }
  async pair(accountId, ign) {
    if (this.pairing) throw Error("Another client is being paired. Retry when it finishes.");
    this.pairing = true;
    try { return await this.savePairing(accountId, ign); }
    finally { this.pairing = false; }
  }
  async savePairing(accountId, ign) {
    if (!/^(buyer|seller)[1-9][0-9]?$/.test(accountId) || !IGN.test(ign))
      throw Error("Choose buyer1/seller1 and an exact Minecraft IGN");
    if (this.clients.has(accountId))
      throw Error("Disconnect this client before changing pairing");
    const existing = this.services.db
      .raw()
      .prepare("SELECT * FROM v3_accounts WHERE id=?")
      .get(accountId);
    if (existing && existing.ign !== ign)
      throw Error(
        "Account already paired to another IGN; use a new account slot",
      );
    if (
      this.services.db
        .raw()
        .prepare(
          "SELECT id FROM v3_accounts WHERE lower(ign)=lower(?) AND id!=?",
        )
        .get(ign, accountId)
    )
      throw Error("IGN already paired to another account slot");
    const token = crypto.randomBytes(32).toString("hex");
    await this.services.vault.store("v3.bridge." + accountId, token);
    this.services.db
      .raw()
      .prepare(
        "INSERT INTO v3_accounts(id,ign,created_ms) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(accountId, ign, Date.now());
    this.tokens.set(accountId, token);
    this.services.sessions?.getClient(accountId);
    return {
      url: "ws://127.0.0.1:" + this.server.address().port,
      accountId,
      ign,
      token,
      server:
        this.options.host || process.env.AUTOSELL_GAME_HOST || "donutsmp.net",
      version: "26.3",
    };
  }
  status() {
    return this.services.db
      .raw()
      .prepare("SELECT id,ign FROM v3_accounts")
      .all()
      .map((row) => ({
        ...row,
        connected: this.clients.has(row.id),
        ...this.clients.get(row.id)?.meta,
      }));
  }
  request(accountId, operation, args = {}, timeout = 15000) {
    if (
      ![
        "command",
        "screenshot",
        "home",
        "store",
        "collect",
        "snapshot",
      ].includes(operation)
    )
      return Promise.reject(Error("Unsupported game operation"));
    if (operation === "command" && !commandAllowed(args.command))
      return Promise.reject(Error("Game command is not allowed"));
    const ws = this.clients.get(accountId);
    if (!ws || ws.readyState !== 1)
      return Promise.reject(Error("Minecraft client is offline"));
    const id = crypto.randomUUID(),
      db = this.services.db.raw();
    db.prepare(
      "INSERT INTO v3_bridge_calls VALUES(?,?,?,'DISPATCHED',?,NULL,?)",
    ).run(id, accountId, operation, JSON.stringify(args), Date.now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        db.prepare("UPDATE v3_bridge_calls SET state='UNKNOWN' WHERE id=?").run(
          id,
        );
        reject(
          Error(
            "Game operation timed out; do not repeat a transfer automatically",
          ),
        );
      }, timeout);
      this.pending.set(id, { accountId, resolve, reject, timer });
      ws.send(
        JSON.stringify({
          id,
          operation,
          args,
          expiresAt: Date.now() + timeout,
        }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            db.prepare(
              "UPDATE v3_bridge_calls SET state='UNKNOWN' WHERE id=?",
            ).run(id);
            reject(error);
          }
        },
      );
    });
  }
  requireReceiptClient(accountId) {
    if (this.clients.get(accountId)?.meta.receiptGeometry !== 1)
      throw Object.assign(Error("Install the updated Autosell Fabric bridge from release and reconnect to capture verified payment lines"),
        {code:"RECEIPT_CLIENT_REQUIRED"});
  }
  async screenshot(accountId, reference, order, chunks) {
    let spec;
    if (reference !== "owner-preview") {
      this.requireReceiptClient(accountId);
      if (order?.id !== reference) throw Error("Payment screenshot requires the current order");
      spec = require("../marketplace/receipt-crop").receiptSpec(order, chunks);
    }
    const result = await this.request(accountId, "screenshot", spec || {}, 20000);
    const data = Buffer.from(result.png || "", "base64");
    if (
      data.length < 32 ||
      data.length > 5 * 1024 * 1024 ||
      data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
      throw Error("Client returned an invalid or oversized PNG");
    if (spec)
      require("../marketplace/receipt-crop").cropReceipt(data, result.receipt, spec);
    const root = path.resolve("data/captures");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const name = crypto.randomUUID() + ".png",
      file = path.join(root, name);
    fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
    return {
      file,
      name,
      accountId,
      reference,
      ...(spec ? {receipt:result.receipt} : {}),
      capturedAt: new Date().toISOString(),
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      source: "Minecraft 26.3 framebuffer",
    };
  }
  async close() {
    clearInterval(this.heartbeat);
    for (const ws of this.clients.values()) ws.terminate();
    await new Promise((resolve) =>
      this.server ? this.server.close(resolve) : resolve(),
    );
  }
}
module.exports = { GameBridge, commandAllowed };
