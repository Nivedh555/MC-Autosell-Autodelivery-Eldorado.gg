"use strict";
const path = require("node:path");
const closure = require("../marketplace/order-status").closure;
const { forServices } = require("../marketplace/customer-message-config");
class CompletionNotifications {
  constructor(s) {
    this.s = s;
    this.busy = false;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.s.db
      .raw()
      .exec(
        "CREATE TABLE IF NOT EXISTS v3_completions(order_id TEXT PRIMARY KEY,state TEXT NOT NULL,reason TEXT,updated_ms INTEGER NOT NULL)",
      );
    this.timer = setInterval(
      () =>
        this.tick().catch((error) =>
          this.s.events?.emit("operator:alert", {
            component: "customer-messages",
            reason: error.message,
          }),
        ),
      15000,
    );
    this.timer.unref();
  }
  async reference(row) {
    const saved = JSON.parse(row.payload),
      s = this.s;
    const order = saved.hybridWorkflow
      ? await s.marketplace.chatOrder(row.id)
      : (await s.browserBridge.inspectOrders()).orders.find(
          (o) => o.id === row.id,
        );
    if (!order || order.id !== row.id)
      throw Error("Completed order is not available in this seller account");
    order.quantityDisplay = saved.browserOrder?.quantityDisplay;
    return { saved, order };
  }
  authorize(row, { canceled = false } = {}) {
    return async () => {
      const s = this.s,
        current = s.deliveryService.repo.get(row.id);
      const canceledBeforeAdmission =
        canceled &&
        !current &&
        s.db
          .raw()
          .prepare(
            "SELECT 1 FROM seller_api_actions WHERE id=? AND state='CONFIRMED'",
          )
          .get("cancelOrder:" + row.id) &&
        !s.deliveryService.repo.chunks(row.id).length;
      if (
        this.stopped ||
        (!current && !canceledBeforeAdmission) ||
        s.deliveryService.ownerHeld(row.id) ||
        s.settings.getSync("general.bot.paused") ||
        s.settings.getSync("eldorado.chat.local")?.autoSend === false ||
        (!canceled &&
          closure(s.deliveryService.repo.closedStatus?.(row.id)) === "canceled")
      )
        throw Error("Delivery is paused, canceled or held for review");
    };
  }
  previous(orderId, id) {
    return this.s.db
      .raw()
      .prepare(
        "SELECT request FROM browser_actions WHERE operation='sendMessageObserved' AND resource_id=? AND json_extract(request,'$.messageId')=? LIMIT 1",
      )
      .get(orderId, id);
  }
  async sendSnapshot(snapshot, order, sellerHref, authorize) {
    const previous = this.previous(order.id, snapshot.id);
    if (!snapshot.enabled && !previous) return;
    const text = previous ? JSON.parse(previous.request).text : snapshot.text;
    await this.s.browserBridge.sendOrderMessageObserved(
      order,
      text,
      snapshot.id,
      sellerHref,
      authorize,
    );
    forServices(this.s)?.finish(snapshot.id);
  }
  async lifecycle(engine) {
    if (!engine) return;
    const db = this.s.db.raw(),
      rows = db
        .prepare(
          `SELECT m.id message_id,m.event,m.order_id id,COALESCE(d.payload,json_extract(m.binding,'$.order')) payload,d.state FROM customer_message_snapshots m LEFT JOIN delivery_orders d ON d.id=m.order_id LEFT JOIN customer_message_attempts a ON a.message_id=m.id
      WHERE m.state='PENDING' AND m.id LIKE 'customer-notification:%'
      AND (d.id IS NOT NULL OR (m.event='buyer_canceled' AND m.binding IS NOT NULL)) AND COALESCE(a.next_attempt_ms,0)<=?
      AND NOT EXISTS(SELECT 1 FROM message_outbox o WHERE o.order_id=m.order_id AND o.next_check_ms>?) ORDER BY m.created_ms LIMIT 10`,
        )
        .all(Date.now(), Date.now());
    for (const row of rows) {
      if (this.stopped) return;
      try {
        const { saved, order } = await this.reference(row),
          canceled = row.event === "buyer_canceled";
        if (
          row.state === "DELIVERED" &&
          [
            "delivery_delayed",
            "account_unavailable",
            "manual_attention",
          ].includes(row.event)
        ) {
          db.prepare(
            "UPDATE customer_message_snapshots SET state='SKIPPED' WHERE id=?",
          ).run(row.message_id);
          continue;
        }
        if (closure(order.status) === "canceled" && !canceled) {
          db.prepare(
            "UPDATE customer_message_snapshots SET state='SKIPPED' WHERE id=?",
          ).run(row.message_id);
          continue;
        }
        if (canceled && closure(order.status) !== "canceled")
          throw Error("Cancellation must be confirmed by Eldorado first");
        const snapshot = db
          .prepare("SELECT * FROM customer_message_snapshots WHERE id=?")
          .get(row.message_id);
        await this.sendSnapshot(
          snapshot,
          order,
          saved.browserBinding.sellerHref,
          this.authorize(row, { canceled }),
        );
      } catch (error) {
        db.prepare(
          `INSERT INTO customer_message_attempts VALUES(?,1,?,?) ON CONFLICT(message_id) DO UPDATE SET attempts=attempts+1,next_attempt_ms=?+min(900000,15000*(1<<min(attempts,6))),reason=excluded.reason`,
        ).run(
          row.message_id,
          Date.now() + 30000,
          String(error.message).slice(0, 500),
          Date.now(),
        );
        this.s.events?.emit("operator:alert", {
          component: "customer-messages",
          orderId: row.id,
          reason: error.message,
        });
      }
    }
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const s = this.s,
        db = s.db.raw(),
        engine = forServices(s);
      if (
        !s.browserBridge?.status().connected ||
        s.settings.getSync("general.bot.paused") ||
        s.settings.getSync("eldorado.chat.local")?.autoSend === false
      )
        return;
      await this.lifecycle(engine);
      const rows = db
        .prepare(
          `SELECT d.* FROM delivery_orders d LEFT JOIN v3_completions c ON c.order_id=d.id
        WHERE d.state='DELIVERED' AND json_extract(d.evidence,'$.screenshotCaptured')=1
        AND (c.state IS NULL OR (c.state='PENDING' AND c.updated_ms<=?))
        AND NOT EXISTS(SELECT 1 FROM message_outbox m WHERE m.order_id=d.id AND m.next_check_ms>?)
        ORDER BY COALESCE(c.updated_ms,0),d.created_ms LIMIT 10`,
        )
        .all(Date.now() - 30000, Date.now());
      for (const row of rows) {
        if (this.stopped) break;
        try {
          if (
            closure(s.deliveryService.repo.closedStatus?.(row.id)) ===
            "canceled"
          ) {
            this.finished(
              row.id,
              "Order canceled; completion notices stopped",
              "SKIPPED",
            );
            continue;
          }
          const saved = JSON.parse(row.payload),
            context = { ...saved, id: row.id };
          const completion = engine?.schedule(
            "order_delivered",
            context,
            "v3-completion:" + row.id,
          );
          const review = engine?.schedule(
            "review_request",
            context,
            "customer-review:" + row.id,
          );
          const guides = engine?.scheduleGuides(row.id) || false;
          const legacyText = this.previous(row.id, "v3-completion:" + row.id);
          const legacyGuides = db
            .prepare(
              "SELECT request FROM browser_actions WHERE operation='uploadEvidenceObserved' AND resource_id=?",
            )
            .all(row.id)
            .map((r) => JSON.parse(r.request).name);
          const guideFiles = [
            "how-to-confirm-1.png",
            "how-to-confirm-2.png",
          ].filter((file) => guides || legacyGuides.includes(file));
          if (
            !completion?.enabled &&
            !review?.enabled &&
            !legacyText &&
            !guideFiles.length
          ) {
            this.finished(
              row.id,
              "Optional completion messages and confirmation guides are disabled",
              "SKIPPED",
            );
            continue;
          }
          const { order } = await this.reference(row);
          if (closure(order.status) === "canceled") {
            s.deliveryService.repo.applyMarketplaceStatus?.(
              row.id,
              order.status,
            );
            this.finished(
              row.id,
              "Marketplace canceled this order; completion notices stopped",
              "SKIPPED",
            );
            continue;
          }
          if (
            ![
              "delivered",
              "order delivered",
              "order marked as delivered",
              "received",
              "order received",
              "completed",
            ].includes(order.status.toLowerCase())
          )
            throw Error(
              "Marketplace has not confirmed delivery; completion notices are waiting.",
            );
          const authorize = this.authorize(row);
          if (completion)
            await this.sendSnapshot(
              completion,
              order,
              saved.browserBinding.sellerHref,
              authorize,
            );
          else if (legacyText)
            await s.browserBridge.sendOrderMessageObserved(
              order,
              JSON.parse(legacyText.request).text,
              "v3-completion:" + row.id,
              saved.browserBinding.sellerHref,
              authorize,
            );
          for (const file of guideFiles)
            await s.browserBridge.uploadOrderEvidenceObserved(
              order,
              path.join(
                require("../marketplace/customer-messages").guideDirectory,
                file,
              ),
              saved.browserBinding.sellerHref,
              authorize,
              { confirmationGuide: true },
            );
          if (review)
            await this.sendSnapshot(
              review,
              order,
              saved.browserBinding.sellerHref,
              authorize,
            );
          engine?.finish("customer-guides:" + row.id);
          this.finished(row.id, null);
        } catch (error) {
          db.prepare(
            "INSERT INTO v3_completions VALUES(?,'PENDING',?,?) ON CONFLICT(order_id) DO UPDATE SET state='PENDING',reason=excluded.reason,updated_ms=excluded.updated_ms",
          ).run(row.id, error.message, Date.now());
        }
      }
    } finally {
      this.busy = false;
    }
  }
  finished(orderId, reason, state = "SENT") {
    this.s.db
      .raw()
      .prepare(
        "INSERT INTO v3_completions VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_ms=excluded.updated_ms",
      )
      .run(orderId, state, reason, Date.now());
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
}
module.exports = { CompletionNotifications };
