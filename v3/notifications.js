"use strict";
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
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
    this.timer.unref();
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const s = this.s,
        db = s.db.raw();
      if (
        !s.browserBridge?.status().connected ||
        s.settings.getSync("general.bot.paused")
      )
        return;
      const rows = db
        .prepare(
          `SELECT d.* FROM delivery_orders d LEFT JOIN v3_completions c ON c.order_id=d.id
           WHERE d.state='DELIVERED' AND json_extract(d.evidence,'$.screenshotCaptured')=1
           AND (c.state IS NULL OR (c.state='PENDING' AND c.updated_ms<=?))
           AND NOT EXISTS(SELECT 1 FROM message_outbox m WHERE m.order_id=d.id
             AND m.logical_key IN ('completion-text','confirm-guide','feedback-guide') AND m.next_check_ms>?)
           ORDER BY COALESCE(c.updated_ms,0),d.created_ms LIMIT 10`,
        )
        .all(Date.now()-30000,Date.now());
      for (const row of rows) {
        if (this.stopped) break;
        try {
          if (db.prepare(`SELECT count(*) n FROM message_outbox WHERE order_id=? AND state='SENT'
            AND logical_key IN ('completion-text','confirm-guide','feedback-guide')`).get(row.id).n===3) {
            this.finished(row.id,"All three customer notifications have saved receipts");
            continue;
          }
          const repo=s.deliveryService.repo;
          if(require('../marketplace/order-status').closure(repo.closedStatus?.(row.id))==='canceled') {
            this.finished(row.id,"Order canceled; completion notices stopped","SKIPPED");
            continue;
          }
          const saved = JSON.parse(row.payload);
          let order;
          if (saved.hybridWorkflow)
            order = await s.marketplace.chatOrder(row.id);
          else
            order = (await s.browserBridge.inspectOrders()).orders.find(
              (o) => o.id === row.id,
            );
          if (!order)
            throw Error(
              "Completed order is not available in this seller account",
            );
          if (require('../marketplace/order-status').closure(order.status)==='canceled') {
            repo.applyMarketplaceStatus?.(row.id,order.status);
            this.finished(row.id,"Marketplace canceled this order; completion notices stopped","SKIPPED");
            continue;
          }
          if (["received","order received","completed"].includes(order.status.toLowerCase())) {
            this.finished(row.id,"Buyer already confirmed receipt","SKIPPED");
            continue;
          }
          if(!["delivered","order delivered","order marked as delivered"].includes(order.status.toLowerCase()))
            throw Error('Marketplace has not confirmed delivery; completion notices are waiting.');
          order.quantityDisplay = saved.browserOrder.quantityDisplay;
          const authorize = async () => {
            if (
              this.stopped ||
              s.deliveryService.repo.get(row.id).state !== "DELIVERED" ||
              s.deliveryService.ownerHeld(row.id) ||
              s.settings.getSync("general.bot.paused")
            )
              throw Error("Delivery is paused or held for review");
          };
          const messages=require('../marketplace/customer-messages');
          const text=messages.render('delivered',{url:'https://www.eldorado.gg/order/'+row.id});
          // A previously submitted completion has to retain its original text for receipt reconciliation.
          const previous=db.prepare("SELECT request FROM browser_actions WHERE operation='sendMessageObserved' AND resource_id=? AND json_extract(request,'$.messageId')=? LIMIT 1").get(row.id,'v3-completion:'+row.id);
          const outgoing=previous?JSON.parse(previous.request).text:text;
          await s.browserBridge.sendOrderMessageObserved(order,outgoing,'v3-completion:'+row.id,saved.browserBinding.sellerHref,authorize);
          for(const filename of ['how-to-confirm-1.png','how-to-confirm-2.png']){
            await s.browserBridge.uploadOrderEvidenceObserved(order,require('node:path').join(messages.guideDirectory,filename),saved.browserBinding.sellerHref,authorize,{confirmationGuide:true});
          }
          this.finished(row.id,null);
        } catch (error) {
          db.prepare(
            "INSERT INTO v3_completions VALUES(?,'PENDING',?,?) ON CONFLICT(order_id) DO UPDATE SET reason=excluded.reason,updated_ms=excluded.updated_ms",
          ).run(row.id, error.message, Date.now());
        }
      }
    } finally {
      this.busy = false;
    }
  }
  finished(orderId,reason,state="SENT") {
    this.s.db.raw().prepare(`INSERT INTO v3_completions VALUES(?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_ms=excluded.updated_ms`)
      .run(orderId,state,reason,Date.now());
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
}
module.exports = { CompletionNotifications };
