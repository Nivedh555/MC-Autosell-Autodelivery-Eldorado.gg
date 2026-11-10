"use strict";
const crypto = require("node:crypto");
const variables = [
  "buyer_name",
  "minecraft_ign",
  "amount",
  "order_id",
  "order_url",
  "server_name",
  "shop_name",
];
const definitions = [
  [
    "new_order",
    "New order",
    "When a funded order first enters the buyer conversation.",
    true,
    "Hey {buyer_name} 👋 Thanks for your order!",
  ],
  [
    "request_username",
    "Request Minecraft username",
    "With the first greeting, when a recipient is still needed.",
    true,
    "Reply with your Minecraft name like this:\n\nign: YourName\n\nUse your in-game name. For Bedrock, include the starting dot: .YourName",
  ],
  [
    "invalid_username",
    "Invalid Minecraft username",
    "When the recipient needs clarification before payment.",
    true,
    "Please send your exact Minecraft username, including the starting dot for Bedrock.",
  ],
  [
    "username_corrected",
    "Username correction",
    "When a buyer supplies a replacement recipient, immediately before the new authorization prompt.",
    false,
    "Thanks for the correction.",
  ],
  [
    "confirm_recipient",
    "Confirm recipient and amount",
    "Before payment. The fixed authorization details below are always included.",
    true,
    "Got it ✅ Sending {amount} to {minecraft_ign}.",
  ],
  [
    "buyer_confirmed",
    "Buyer confirms",
    "After the current recipient is authorized, immediately before payment starts.",
    false,
    "Thanks, your recipient is confirmed.",
  ],
  [
    "payment_started",
    "Payment starts",
    "Immediately before starting the verified payment workflow.",
    true,
    "Sending {amount} to {minecraft_ign} now 💸",
  ],
  [
    "proof_ready",
    "Payment proof is ready",
    "Before uploading the genuine payment receipt.",
    true,
    "Done! Here's your proof 📸",
  ],
  [
    "payment_verified",
    "Payment fully verified",
    "After all payment chunks are verified.",
    false,
    "Your {amount} payment to {minecraft_ign} is verified.",
  ],
  [
    "order_delivered",
    "Order marked delivered",
    "After Eldorado acknowledges delivery, even if the buyer already confirmed receipt.",
    false,
    "",
  ],
  [
    "delivery_delayed",
    "Delivery delayed",
    "On a recorded retry or failed delivery step; once per order.",
    false,
    "Delivery is taking longer than expected. Your order is still being checked.",
  ],
  [
    "account_unavailable",
    "Minecraft account unavailable",
    "When a recorded delivery failure reports the game account disconnected or unavailable.",
    false,
    "The delivery account is reconnecting. Your order is waiting.",
  ],
  [
    "manual_attention",
    "Manual attention",
    "When the delivery state requires operator review; once per order.",
    false,
    "Your order needs a manual check. We will review the saved delivery record.",
  ],
  [
    "buyer_canceled",
    "Buyer cancels before payment",
    "After a confirmed cancellation with no payment intent.",
    false,
    "Your order was canceled before payment.",
  ],
  [
    "review_request",
    "Optional review request",
    "After delivery is acknowledged; once per order.",
    false,
    "",
  ],
].map(([event, label, description, defaultEnabled, defaultText]) => ({
  event,
  label,
  description,
  defaultEnabled,
  defaultText,
  required: event === "confirm_recipient",
}));
function error(message, status = 400) {
  return Object.assign(Error(message), { status, statusCode: status });
}
function definition(event) {
  const found = definitions.find((t) => t.event === event);
  if (!found) throw error("Unknown customer message event");
  return found;
}
function validate(event, text, enabled) {
  const def = definition(event);
  if (
    typeof enabled !== "boolean" ||
    typeof text !== "string" ||
    text.length > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
  )
    throw error(
      "Use a message of at most 2,000 characters and a valid enabled switch.",
    );
  if (def.required && !enabled)
    throw error("Recipient confirmation is required and cannot be disabled.");
  if (enabled && !text.trim() && !def.required)
    throw error("Enter a message before enabling this event.");
  for (const match of text.matchAll(/\{([^{}]*)\}/g))
    if (!variables.includes(match[1]))
      throw error("Unsupported placeholder: {" + match[1] + "}");
  if (
    ["new_order", "request_username", "invalid_username"].includes(event) &&
    text.includes("{minecraft_ign}")
  )
    throw error(
      "The confirmed Minecraft username is not available at this stage.",
    );
  if (/[{}]/.test(text.replace(/\{([^{}]*)\}/g, "")))
    throw error("Use complete supported placeholders, for example {amount}.");
  const maxOutput = [
    "new_order",
    "request_username",
    "username_corrected",
    "confirm_recipient",
  ].includes(event)
    ? 1750
    : 3800;
  const limits = {
    order_id: 36,
    order_url: 66,
    buyer_name: 200,
    minecraft_ign: 17,
    amount: 45,
    server_name: 8,
    shop_name: 200,
  };
  if (
    text.replace(/\{([^{}]*)\}/g, (_match, key) => "x".repeat(limits[key]))
      .length > maxOutput
  )
    throw error(
      "This message could exceed the chat limit after inserting order details. Shorten the text or use fewer placeholders.",
    );
  return { text: text.trim(), enabled };
}
function fields(order = {}) {
  const clean = (value) =>
    String(value ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 200);
  return {
    buyer_name: clean(
      order.buyerName ||
        order.buyerMarketplaceId ||
        order.browserOrder?.buyerName ||
        "there",
    ),
    minecraft_ign: clean(
      order.buyerIgn || order.minecraft_ign || "not confirmed",
    ),
    amount: /^[1-9][0-9]*$/.test(String(order.amount))
      ? require("./customer-messages").displayAmount(order.amount)
      : "not recorded",
    order_id: clean(order.id),
    order_url: order.id
      ? "https://www.eldorado.gg/order/" + encodeURIComponent(order.id)
      : "",
    server_name: "DonutSMP",
    shop_name: clean(order.shopName || "our shop"),
  };
}
function render(text, values) {
  const rendered = text.replace(/\{([^{}]*)\}/g, (_all, key) => {
    if (!variables.includes(key)) throw error("Unsupported placeholder");
    if (!values[key])
      throw error(
        "This event has no " +
          key +
          " yet. Choose a placeholder available at this stage.",
      );
    return String(values[key]);
  });
  if (rendered.length > 3800)
    throw error(
      "Rendered customer message is too long. Use fewer repeated placeholders.",
    );
  return rendered;
}
function authorizationFooter(binding) {
  if (
    !binding?.orderId ||
    !require("../minecraft/verified-payments").validIgn(binding.ign, ".") ||
    !/^\d+$/.test(binding.amount) ||
    BigInt(binding.amount) < 1n ||
    !/^[a-f0-9]{64}$/.test(binding.revision)
  )
    throw error(
      "Confirmation needs this order, exact recipient, amount and captured conversation revision.",
    );
  return (
    "Confirm payment: " +
    binding.amount +
    " Donut dollars to " +
    binding.ign +
    ".\nOrder: " +
    binding.orderId +
    "\nReply yes to confirm or no to change the recipient.\nConfirmation: " +
    binding.revision.slice(0, 12)
  );
}
class CustomerMessageConfig {
  constructor(db) {
    this.db = db.raw ? db.raw() : db;
  }
  get(event) {
    const def = definition(event),
      saved = this.db
        .prepare("SELECT * FROM customer_message_templates WHERE event=?")
        .get(event);
    return {
      ...def,
      ...(saved
        ? {
            text: saved.text,
            enabled: Boolean(saved.enabled),
            revision: saved.revision,
          }
        : { text: def.defaultText, enabled: def.defaultEnabled, revision: 1 }),
    };
  }
  snapshot() {
    const options = this.db
      .prepare("SELECT * FROM customer_message_options WHERE id=1")
      .get();
    return {
      templates: definitions.map((def) => this.get(def.event)),
      placeholders: variables,
      example: {
        buyer_name: "Alex",
        minecraft_ign: "BuyerOne",
        amount: "100M",
        order_id: "example-order",
        order_url: "https://www.eldorado.gg/order/example-order",
        server_name: "DonutSMP",
        shop_name: "our shop",
      },
      guides: {
        enabled: Boolean(options.guides_enabled),
        revision: options.revision,
      },
    };
  }
  save(event, input) {
    if (!input || typeof input !== "object")
      throw error("Message settings are required.");
    const current = this.get(event),
      value = validate(event, input.text, input.enabled);
    if (input.revision !== current.revision)
      throw error(
        "This template changed elsewhere. Refresh and review it before saving.",
        409,
      );
    const result = this.db
      .prepare(
        `INSERT INTO customer_message_templates VALUES(?,?,?,?,?) ON CONFLICT(event) DO UPDATE SET text=excluded.text,enabled=excluded.enabled,revision=excluded.revision,updated_ms=excluded.updated_ms WHERE customer_message_templates.revision=?`,
      )
      .run(
        event,
        value.text,
        Number(value.enabled),
        current.revision + 1,
        Date.now(),
        current.revision,
      );
    if (!result.changes)
      throw error("Template revision changed. Refresh and try again.", 409);
    return this.snapshot();
  }
  reset(event, revision) {
    const def = definition(event);
    return this.save(event, {
      text: def.defaultText,
      enabled: def.defaultEnabled,
      revision,
    });
  }
  guides(input) {
    if (!input || typeof input !== "object")
      throw error("Guide settings are required.");
    if (
      typeof input.enabled !== "boolean" ||
      !Number.isSafeInteger(input.revision)
    )
      throw error("Invalid guide settings");
    const changed = this.db
      .prepare(
        "UPDATE customer_message_options SET guides_enabled=?,revision=revision+1 WHERE id=1 AND revision=?",
      )
      .run(Number(input.enabled), input.revision);
    if (!changed.changes)
      throw error("Guide settings changed. Refresh and try again.", 409);
    return this.snapshot();
  }
  schedule(event, order, id, binding = null) {
    const saved = this.db
      .prepare("SELECT * FROM customer_message_snapshots WHERE id=?")
      .get(id);
    if (saved) return { ...saved, enabled: Boolean(saved.enabled) };
    const template = this.get(event),
      text = template.enabled ? render(template.text, fields(order)) : "";
    const outgoing =
      event === "confirm_recipient"
        ? [binding?.correction, text, authorizationFooter(binding)]
            .filter(Boolean)
            .join("\n\n")
        : text;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO customer_message_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        String(order.id),
        event,
        template.revision,
        outgoing,
        Number(template.enabled),
        binding ? JSON.stringify(binding) : null,
        template.enabled ? "PENDING" : "SKIPPED",
        Date.now(),
      );
    const row = this.db
      .prepare("SELECT * FROM customer_message_snapshots WHERE id=?")
      .get(id);
    return { ...row, enabled: Boolean(row.enabled) };
  }
  recognize(text, ign, amount, orderId, revision) {
    if (!orderId || !revision) return false;
    return this.db
      .prepare(
        "SELECT text,binding FROM customer_message_snapshots WHERE order_id=? AND event='confirm_recipient'",
      )
      .all(orderId)
      .some((row) => {
        const b = JSON.parse(row.binding || "null");
        return (
          row.text === text &&
          b?.ign === ign &&
          b.amount === String(amount) &&
          b.orderId === orderId &&
          b.revision === revision
        );
      });
  }
  scheduleGuides(orderId) {
    const id = "customer-guides:" + orderId,
      saved = this.db
        .prepare("SELECT * FROM customer_message_snapshots WHERE id=?")
        .get(id);
    if (saved) return Boolean(saved.enabled);
    const options = this.db
      .prepare("SELECT * FROM customer_message_options WHERE id=1")
      .get();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO customer_message_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        orderId,
        "confirmation_guides",
        options.revision,
        "",
        options.guides_enabled,
        null,
        options.guides_enabled ? "PENDING" : "SKIPPED",
        Date.now(),
      );
    return Boolean(options.guides_enabled);
  }
  finish(id) {
    this.db
      .prepare(
        "UPDATE customer_message_snapshots SET state='SENT' WHERE id=? AND enabled=1",
      )
      .run(id);
  }
}
function forServices(services) {
  const db = services?.db?.raw?.();
  if (
    !db ||
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_message_templates'",
      )
      .get()
  )
    return null;
  return new CustomerMessageConfig(db);
}
function identity(event, orderId, suffix = "") {
  return (
    "customer-event:" +
    event +
    ":" +
    orderId +
    (suffix
      ? ":" +
        crypto.createHash("sha256").update(suffix).digest("hex").slice(0, 24)
      : "")
  );
}
function recordDeliveryEvent(db, orderId, kind, data) {
  if (
    ![
      "STATE",
      "DELIVERY_FAILED",
      "MARK_ACK_FAILED",
      "SCREENSHOT_PENDING",
    ].includes(kind)
  )
    return;
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_message_templates'",
      )
      .get()
  )
    return;
  const row = db
    .prepare("SELECT payload,mode FROM delivery_orders WHERE id=?")
    .get(orderId);
  if (!row || row.mode !== "live") return;
  const order = JSON.parse(row.payload);
  if (order.kind === "transfer" || !order.browserBinding?.sellerHref) return;
  if (kind === "STATE" && data.state === "DELIVERED") {
    const engine = new CustomerMessageConfig(db);
    scheduleSafely(
      engine,
      "order_delivered",
      order,
      "v3-completion:" + orderId,
    );
    scheduleSafely(
      engine,
      "review_request",
      order,
      "customer-review:" + orderId,
    );
    engine.scheduleGuides(orderId);
    return;
  }
  const events = [];
  if (kind === "STATE" && data.state === "ALL_VERIFIED")
    events.push("payment_verified");
  if (kind === "STATE" && data.state === "NEEDS_OPERATOR")
    events.push("manual_attention");
  if (
    kind === "STATE" &&
    data.state === "CANCELLED" &&
    !db
      .prepare("SELECT 1 FROM delivery_chunks WHERE order_id=?")
      .get(orderId) &&
    db
      .prepare(
        "SELECT 1 FROM buyer_messages WHERE order_id=? AND direction='in' AND intent='cancel'",
      )
      .get(orderId)
  )
    events.push("buyer_canceled");
  if (
    ["DELIVERY_FAILED", "MARK_ACK_FAILED", "SCREENSHOT_PENDING"].includes(kind)
  )
    events.push("delivery_delayed");
  if (
    kind === "DELIVERY_FAILED" &&
    /offline|disconnected|session|connect|unavailable/i.test(data.reason || "")
  )
    events.push("account_unavailable");
  const engine = new CustomerMessageConfig(db);
  for (const event of events) {
    const id = "customer-notification:" + event + ":" + orderId;
    scheduleSafely(engine, event, { ...order, id: orderId }, id);
  }
}
function scheduleSafely(engine, event, order, id) {
  try {
    return engine.schedule(event, order, id);
  } catch (error) {
    // An optional notification configuration must never roll back a verified payment journal.
    engine.db
      .prepare(
        "INSERT OR IGNORE INTO customer_message_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        order.id,
        event,
        0,
        String(error.message).slice(0, 250),
        0,
        null,
        "CONFIG_ERROR",
        Date.now(),
      );
  }
}
module.exports = {
  CustomerMessageConfig,
  forServices,
  definitions,
  variables,
  validate,
  fields,
  render,
  authorizationFooter,
  identity,
  recordDeliveryEvent,
};
