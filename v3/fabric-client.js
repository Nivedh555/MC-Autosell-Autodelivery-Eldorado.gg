"use strict";
const { EventEmitter } = require("node:events");
const services = require("../services");
class FabricClient extends EventEmitter {
  constructor(accountId) {
    super();
    this.accountId = accountId;
    this.transport = "fabric";
    this.state = "offline";
    this.role = accountId === "buyer1" ? "primary" : "secondary";
    this.bot = null;
    this.chatHistory = [];
    this.snapshot = { inventory: [] };
    this._bound = false;
    this._shouldRun = true;
    this._bind();
  }
  _bind() {
    if (this._bound || !services.gameBridge) return;
    this._bound = true;
    const hub = services.gameBridge;
    hub.on("connected", (id, meta) => {
      if (id !== this.accountId) return;
      this._attach(meta);
    });
    hub.on("disconnected", (id) => {
      if (id !== this.accountId) return;
      const old = this.bot;
      this.bot = null;
      this.setState("offline");
      old?.emit("end", "Fabric bridge disconnected");
      this.emit("end", "Fabric bridge disconnected");
    });
    hub.on("snapshot", (id, msg) => {
      if (id !== this.accountId) return;
      this.snapshot = msg;
      if (this.bot) {
        this.bot.entity = { position: msg.position };
        this.bot.health = msg.health;
        this.bot.food = msg.food;
        this.bot.inventory.slots = [];
        for (const item of msg.inventory)
          this.bot.inventory.slots[item.slot] = item;
      }
      this.emit("telemetry", this.getTelemetry());
    });
    hub.on("chat", (id, msg) => {
      if (id !== this.accountId || !this.bot) return;
      this.chatHistory.push({ text: msg.text, at: Date.now(), level: "chat" });
      this.chatHistory = this.chatHistory.slice(-200);
      const sender = msg.kind === "chat" ? "player" : null;
      this.bot.emit(
        "messagestr",
        msg.text,
        msg.kind,
        { fabricBalanceHover: msg.balanceHover, fabricReceiptId: msg.receiptId },
        sender,
      );
      this.emit("chatMessage", this.chatHistory.at(-1));
      if (msg.kind === "system") {
        const matched = require("../payments/payment-patterns").matchCaptured(
          msg.text,
          { position: "system", sender: null },
        );
        if (matched)
          this.emit("chat:payment", {
            username: matched.username,
            amountText: matched.amountText,
            rawLine: msg.text,
            packet: { position: "system", sender: null },
          });
      }
    });
    const ws = hub.clients.get(this.accountId);
    if (ws) this._attach(ws.meta);
  }
  _attach(meta) {
    this.bot = new EventEmitter();
    Object.assign(this.bot, {
      username: meta.ign,
      version: meta.version,
      game: { serverBrand: "Observed through Fabric client" },
      _client: { options: { host: meta.host } },
      _clientRef: this,
      transport: "fabric",
    });
    this.bot.inventory = new EventEmitter();
    this.bot.inventory.items = () => this.snapshot.inventory || [];
    this.bot.inventory.slots = [];
    const attachedBot=this.bot;
    this.bot.chat = (message) => {
      if(this.bot!==attachedBot)throw Error('Minecraft session changed; the old command channel cannot dispatch');
      return this.chat(message);
    };
    this.bot.end = () => this.disconnect();
    this.setState("idle");
    this.emit("spawn");
  }
  _getEmail() {
    return (
      services.db
        ?.raw()
        .prepare("SELECT ign FROM v3_accounts WHERE id=?")
        .get(this.accountId)?.ign || ""
    );
  }
  getDetectedIgn() {
    return this.bot?.username || this._getEmail();
  }
  isOnline() {
    return Boolean(
      this.bot && services.gameBridge?.clients.has(this.accountId),
    );
  }
  async connect() {
    this._bind();
    if (this.isOnline()) this.emit("spawn");
    else {
      this.setState("offline");
      throw Error(
        "Open the paired Minecraft 26.3 Fabric client and join DonutSMP",
      );
    }
  }
  start() {
    return this.connect();
  }
  stop(reason) {
    return this.disconnect(reason);
  }
  reconnectNow() {
    return this.connect();
  }
  disconnect(reason = "Owner disconnected") {
    services.gameBridge?.clients
      .get(this.accountId)
      ?.close(1000, reason.slice(0, 120));
    this._shouldRun = false;
    this.emit("stopped", reason);
  }
  setState(value) {
    this.state = value;
    this.emit("state", value);
  }
  getStatus() {
    return {
      accountId: this.accountId,
      online: this.isOnline(),
      state: this.state,
      username: this.getDetectedIgn(),
      host: this.bot?._client.options.host || "donutsmp.net",
      transport: "fabric",
      version: "26.3",
    };
  }
  getTelemetry() {
    return {
      ...this.getStatus(),
      health: this.snapshot.health,
      food: this.snapshot.food,
      position: this.snapshot.position,
      inventory: this.getInventorySnapshot(),
    };
  }
  getInventorySnapshot() {
    return {
      items: this.snapshot.inventory || [],
      slots: this.snapshot.inventory || [],
      capturedAt: this.snapshot.at || null,
    };
  }
  chat(message) {
    if (!this.isOnline()) throw Error("Minecraft client is offline");
    const dispatchedBot=this.bot;
    services.gameBridge
      .request(this.accountId, "command", { command: message })
      .catch((error) => {
        services.events?.emit("operator:alert", {
          accountId: this.accountId,
          reason: error.message,
        });
        dispatchedBot?.emit("end", error.message);
      });
  }
  async goHome() {
    await services.gameBridge.request(this.accountId, "home", {}, 45000);
  }
  async syncAndDepositEnderChest() {
    const result = await services.gameBridge.request(
      this.accountId,
      "store",
      {},
      30000,
    );
    if (!result.success) throw Error("Storage transfer was not verified");
    return result;
  }
  handleHomeTeleportAndSync() {
    return this.goHome().then(() => this.syncAndDepositEnderChest());
  }
  async emergencyLockdown() {
    let secured = false;
    try {
      await this.goHome();
      secured = (await this.syncAndDepositEnderChest()).success;
    } finally {
      this.disconnect("Emergency stop");
    }
    return { success: true, secured };
  }
  clearChatHistory() {
    this.chatHistory = [];
  }
  async moveSlotItem() {
    throw Error(
      "Use the actual Minecraft inventory to move items outside an active sale",
    );
  }
}
FabricClient.STATE = {
  IDLE: "idle",
  DELIVERING: "delivering",
  COLLECTING: "collecting",
  OFFLINE: "offline",
};
module.exports = FabricClient;
