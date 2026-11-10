'use strict';
const crypto = require('node:crypto');
const { missing } = require('../marketplace/contract/runtime');
class OperationsMonitor {
  constructor(services, options = {}) { this.services = services; this.db = services.db.raw(); this.options = options; this.busy = false; }
  start() {
    this.listener = alert => { try { this.alert(alert); } catch (error) { require('../services/console-logger').line('ERROR', 'ALERTS', 'Could not save an operator alert', { Reason: require('../discord/log-text').readableReason(error.message) }); } };
    this.services.events.on('operator:alert', this.listener);
    this.timer = setInterval(() => this.tick().catch(error => this.alert({ component: 'monitor', reason: error.message })), 10000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); if (this.listener) this.services.events.removeListener('operator:alert', this.listener); }
  alert({ component = 'delivery', orderId = null, saleId = null, reason = 'Unspecified anomaly' }) {
    orderId ||= saleId;
    const key = crypto.createHash('sha256').update(JSON.stringify([component, orderId, reason])).digest('hex');
    const record = this.db.prepare(`INSERT INTO operator_alerts(id,dedupe_key,component,order_id,reason,created_ms,last_ms) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(dedupe_key) DO UPDATE SET last_ms=excluded.last_ms,occurrences=occurrences+1 RETURNING occurrences`).get(crypto.randomUUID(), key, component, orderId, String(reason), Date.now(), Date.now());
                                                                                  
    if (!this.options.quiet && record.occurrences === 1) require('../services/console-logger').notice({ component, orderId, reason });
  }
  metric(orderId, step, elapsedMs, outcome) {
    this.db.prepare('INSERT INTO runtime_metrics(order_id,step,elapsed_ms,outcome,created_ms) VALUES(?,?,?,?,?)').run(orderId || null, step, elapsedMs, outcome, Date.now());
  }
  metrics() {
    const groups = {};
    for (const row of this.db.prepare('SELECT step,elapsed_ms,outcome FROM runtime_metrics ORDER BY id DESC LIMIT 10000').all()) (groups[row.step] ||= []).push(row);
    return Object.fromEntries(Object.entries(groups).map(([step, rows]) => {
      const values = rows.map(row => row.elapsed_ms).sort((a, b) => a - b);
      return [step, { count: rows.length, failures: rows.filter(row => row.outcome !== 'ok').length, p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) }];
    }));
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const policy = await this.services.settings.get('delivery.policy');
      for (const row of this.db.prepare("SELECT * FROM delivery_orders WHERE state NOT IN ('DELIVERED','TRANSFERRED','CANCELLED','EXPIRED','DRY_RUN','MARKETPLACE_CLOSED')").all()) {
        if (row.state === 'RECONCILIATION_REQUIRED') {
          this.alert({component:'order-reconciliation',orderId:row.id,reason:row.reason});
          continue;
        }
        if (row.state === 'NEEDS_OPERATOR') this.alert({ orderId: row.id, reason: row.reason });
        const deadline = JSON.parse(row.payload).deadlineMs;
        if (Number.isSafeInteger(deadline) && deadline - Date.now() <= (policy.slaWarningMs || 60000)) this.alert({ component: 'sla', orderId: row.id, reason: 'Delivery deadline near or elapsed; confirm late delivery with the buyer through Eldorado' });
        if (row.state === 'MARK_DELIVERED_PENDING' && Date.now() - row.updated_ms > policy.markEscalateMs) this.alert({ component: 'marketplace', orderId: row.id, reason: 'Acknowledgement overdue; money was already sent, do not repay' });
      }
      for (const row of this.db.prepare("SELECT order_id,logical_key,state,reason FROM message_outbox WHERE state IN ('UNKNOWN','FAILED')").all()) {
        this.alert({component:'order-message',orderId:row.order_id,reason:[row.logical_key,row.state,row.reason].filter(Boolean).join(' · ')});
      }
      for (const table of ['intake_sales', 'payout_intents']) for (const row of this.db.prepare(`SELECT id,reason FROM ${table} WHERE state='NEEDS_OPERATOR'`).all()) this.alert({ component: table, orderId: row.id, reason: row.reason });
      for (const row of this.db.prepare("SELECT id,details FROM orders WHERE status IN ('needs_operator','payout_failed')").all()) this.alert({component:'spawner',orderId:row.id,reason:JSON.parse(row.details||'{}').reason||'Interrupted spawner order requires inventory and payout reconciliation'});
      const client = this.services.discordClient;
      if (!client?.isReady?.()) return;
                                                                            
                                                                            
      const alert = this.db.prepare("SELECT * FROM operator_alerts WHERE notification_state='pending' AND acknowledged_ms IS NULL ORDER BY created_ms LIMIT 1").get();
      if (!alert) return;
      this.db.prepare("UPDATE operator_alerts SET notification_state='sending' WHERE id=?").run(alert.id);
      try {
        const result=await require('../discord/operator-notifications').notify(alert,this.services);
        this.db.prepare('UPDATE operator_alerts SET notification_state=? WHERE id=?').run(result.state==='unavailable'?'pending':result.state,alert.id);
        if(result.state==='unavailable'&&!this.channelWarning){this.channelWarning=true;console.error('[alerts] '+result.reason);}
        if(result.state==='sent')this.channelWarning=false;
      } catch { this.db.prepare("UPDATE operator_alerts SET notification_state='failed-or-unknown' WHERE id=?").run(alert.id); }
    } finally { this.busy = false; }
  }
  async health() {
    const s = this.services;
    const contract = await s.settings.get('eldorado.contract');
    const connection = await s.settings.get('eldorado.connection');
    const profile = connection === 'browser' ? await s.settings.get('eldorado.browser.profile') : null;
    const listingPolicy = await s.settings.get('listing.policy');
    const required = connection === 'browser'
      ? ['listOrders', 'getOrder', 'markDelivered', 'listOffers', 'getOffer', 'pauseOffer', 'resumeOffer', ...(listingPolicy?.manageQuantity || listingPolicy?.managePrice ? ['updateOffer'] : [])]
      : ['listOrders', 'getOrder', 'markDelivered', 'createOffer', 'updateOffer', 'pauseOffer'];
    let absent = [...new Set(required.flatMap(operation => profile ? require('../marketplace/browser/profile').missing(profile, operation) : missing(contract, operation)))];
    if (connection==='browser' && s.browserFulfillment) {
      try { await s.browserFulfillment.prerequisites(); absent=[]; }
      catch(error) { absent=[error.message]; }
    }
    const accounts = [...(s.sessions?.clients || [])].map(([id, client]) => ({ id, connected: Boolean(client.isOnline?.()), state: s.sessions.getState(id) }));
    const rollout = s.rollout?.status() || {mode:'live',ready:false};
    return { status: absent.length || !await require('../treasury/trading-controls').globallyEnabled(s.settings) ? 'blocked' : 'configured-live-checks-required', database: await s.db.healthCheck(),
      discord: { connected: Boolean(s.discordClient?.isReady?.()) }, wallet: { keyLoaded: Boolean(s.wallet?.enabled), broadcastConfigured: Boolean(s.config?.wallet?.sendEnabled) },
      accounts, marketplace: { connection, missing: absent, browser: s.browserBridge?.status() || null, pollerRunning: Boolean(s.orderPoller?.isRunning), blockedReason: s.orderPoller?.blockedReason || null, lastError: s.orderPoller?.lastError || null, lastPollMs: s.orderPoller?.lastPollMs || null },
      readiness:rollout, executionMode:'live', chat: { transport: s.browserFulfillment ? 'observed-order-browser' : s.marketplace?.capabilities?.getMessages ? 'browser' : 'manual-inbox', replyEngine: 'local-rules', autoSendConfigured: Boolean((await s.settings.get('eldorado.chat.local'))?.autoSend), automaticRemoteSending: Boolean(s.chatScheduler?.timer && ['ATTACHED_PAUSED','RUNNING'].includes(s.browserBridge?.status().state) && (s.browserFulfillment || s.marketplace?.capabilities?.sendMessage) && !await s.settings.get('general.bot.paused')) },
      screenshots: { available: false, reason: 'A genuine graphical client capture integration has not been supplied' },
      operatorAlerts: this.db.prepare('SELECT count(*) AS n FROM operator_alerts WHERE acknowledged_ms IS NULL').get().n,
      locks: this.db.prepare('SELECT account_id,order_id,acquired_ms FROM delivery_account_locks').all() };
  }
}
module.exports = { OperationsMonitor };
