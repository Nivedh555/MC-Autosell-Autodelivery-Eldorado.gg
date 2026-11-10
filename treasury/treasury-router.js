'use strict';
const crypto = require('node:crypto');
const services = require('../services');
const { VerifiedPayments, integer } = require('../minecraft/verified-payments');
class TreasuryRouter {
  constructor(options = {}) { this.state = 'UNCONFIGURED'; this.busy = false; this.timer = null; this.reads = new Map(); this.refreshTask = null; this.stopping = false; this.autoRefresh = options.autoRefresh !== false; }
  async start() {
    this.stopping = false;
    const policy = await services.settings.get('treasury.policy');
    if (Number.isSafeInteger(policy.intervalMs) && policy.intervalMs > 0) {
      this.timer = setInterval(() => this.tick().catch(error => services.events?.emit('operator:alert', { component: 'treasury', reason: error.message })), policy.intervalMs);
      this.timer.unref?.();
    }
  }
  stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; }
  requestBalanceRefresh() {
    if (this.stopping || !this.autoRefresh) return { state: 'stopped' };
    if (!this.refreshTask) this.refreshTask = this.refreshConfiguredAccounts()
      .catch(error => services.events?.emit('operator:alert', { component: 'treasury', reason: 'Account balance loading failed: ' + error.message }))
      .finally(() => { this.refreshTask = null; });
    return { state: 'pending' };
  }
  async refreshConfiguredAccounts() {
    if (this.stopping || !await require('./trading-controls').globallyEnabled()) return [];
    const accounts = [], logins = new Set(), results = [];
    for (const pair of services.pairManager?.getPairs() || []) {
      for (const [id, email] of [[pair.buyerId, pair.buyerEmail], [pair.sellerId, pair.sellerEmail]]) {
        if (!String(email || '').trim()) continue;
        const account = require('./trading-controls').canonical(id), login = String(email).trim().toLowerCase();
        if (logins.has(login)) {
          results.push({ accountId: account, ok: false, reason: 'This Microsoft login is already assigned to another configured account; no duplicate connection started.' });
          continue;
        }
        logins.add(login); accounts.push(account);
      }
    }
                                                                              
                                                                                
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, accounts.length) }, async () => {
      while (next < accounts.length && !this.stopping && await require('./trading-controls').globallyEnabled()) {
        const accountId = accounts[next++];
        if (!accountId) break;
        try { results.push({ accountId, ...await this.reconcile(accountId) }); }
        catch (error) {
          const reason = `Could not load ${accountId}'s balance: ${error.message}`;
          results.push({ accountId, ok: false, reason });
          services.events?.emit('operator:alert', { component: 'treasury', accountId, reason });
        }
      }
    }));
    services.listingManager?.requestSync();
    return results;
  }
  async acceptSale(fromId, amount, saleId) {
    const controls = require('./trading-controls');
    if (services.pairManager) {
      const choice = await controls.forwarding(fromId);
      if (!choice.enabled || !choice.destination) return { ok: false, state: 'RETAINED', holderId: fromId, reason: choice.destination ? 'Send to holder is disabled' : 'Buyer-only pair keeps received coins' };
    }
    const roles = await services.settings.get('treasury.accountRoles');
    const toId = roles[fromId]?.holderAccount;
    if (!toId || !roles[toId]) throw new Error('Holder role not configured');
    const db = services.db.raw();
    db.prepare("INSERT OR IGNORE INTO transfer_queue VALUES(?,?,?,?,'QUEUED',NULL,?)").run(saleId, fromId, toId, String(integer(amount)), Date.now());
    const prior = db.prepare('SELECT * FROM transfer_queue WHERE sale_id=?').get(saleId);
    if (prior.from_id !== fromId || prior.to_id !== toId || prior.amount !== String(amount)) throw new Error('Transfer queue identity changed');
    await this.flush(fromId);
    const row = db.prepare('SELECT * FROM transfer_queue WHERE sale_id=?').get(saleId);
    return { ok: row.state === 'FORWARDED', state: row.state, holderId: toId };
  }
  async flush(fromId) {
    const db = services.db.raw(), policy = await services.settings.get('treasury.policy');
    const rows = db.prepare("SELECT * FROM transfer_queue WHERE from_id=? AND state='QUEUED' ORDER BY sale_id").all(fromId);
    if (!rows.length) return;
    if (!await require('./trading-controls').globallyEnabled()) return;
    if (services.pairManager) {
      const choice = await require('./trading-controls').forwarding(fromId);
      if (!choice.enabled) return;
      if (!choice.destination || rows.some(row => row.to_id !== choice.destination)) throw new Error('Queued transfer destination no longer matches pair configuration');
    }
    const net = rows.reduce((sum, row) => sum + integer(row.amount), 0n);
    if (policy.trigger === 'batch_amount' && net < integer(policy.minBatch)) return;
    if (policy.trigger === 'interval' && (!Number.isSafeInteger(policy.intervalMs) || Date.now() - Math.min(...rows.map(r => r.created_ms)) < policy.intervalMs)) return;
    if (!['per_sale','batch_amount','interval'].includes(policy.trigger)) return;
    if (new Set(rows.map(row => row.to_id)).size !== 1) throw new Error('Mixed holder destinations in batch');
    const roles = await services.settings.get('treasury.accountRoles');
    const toId = rows[0].to_id;
    const batch = crypto.createHash('sha256').update(JSON.stringify(rows.map(row => row.sale_id))).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) if (db.prepare("UPDATE transfer_queue SET state='PROCESSING',batch_id=? WHERE sale_id=? AND state='QUEUED'").run(batch, row.sale_id).changes !== 1) throw new Error('Batch already claimed');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const result = await require('./transfer-executor').executeTransfer({ id: fromId, username: roles[fromId]?.ign }, { id: toId, username: roles[toId]?.ign }, net.toString(), batch);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE transfer_queue SET state=? WHERE batch_id=?').run(result.ok ? 'FORWARDED' : 'NEEDS_OPERATOR', batch);
      if (result.ok) for (const row of rows) db.prepare('UPDATE inventory_cost_lots SET account_id=? WHERE id=?').run(toId, row.sale_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    this.state = result.ok ? 'TRANSFERRED' : 'NEEDS_OPERATOR';
  }
  async reconcile(accountId) {
    if (this.reads.has(accountId)) return this.reads.get(accountId);
    const task = this._reconcile(accountId).finally(() => this.reads.delete(accountId));
    this.reads.set(accountId, task);
    return task;
  }
  async _reconcile(accountId) {
    let lease;
    try {
      const store = services.db.raw();
      const reserved = () => store.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(accountId) ||
          store.prepare("SELECT id FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get(accountId);
      if (reserved()) return { ok: false, reason: 'Account reserved or unresolved; baseline unchanged' };
      lease = await services.sessions.acquire(accountId, 'reconciliation'); await lease.ready();
      const verifier = new VerifiedPayments(await services.settings.get('delivery.patternPack'), undefined, undefined, { readOnly: true });
      if (reserved()) return { ok: false, reason: 'Account reserved or unresolved; baseline unchanged' };
      const balance = await verifier.readIdleBalance(lease.getBot());
                                                                              
                                                                                
      if (reserved()) return { ok: false, reason: 'Account became reserved during balance read; baseline unchanged' };
      const db = services.db.raw(), previous = db.prepare('SELECT * FROM account_snapshots WHERE account_id=?').get(accountId);
      const ledgerBalance = BigInt(services.ledger.balance(accountId, 'donut'));
      db.prepare('INSERT INTO balance_observations VALUES(?,?,?,NULL) ON CONFLICT(account_id) DO UPDATE SET balance=excluded.balance,observed_ms=excluded.observed_ms,reason=NULL')
        .run(accountId, String(balance), verifier.lastBalanceObservation.observedMs);
      const externalChange = previous ? balance - BigInt(previous.balance) - ledgerBalance + BigInt(previous.ledger_balance) : 0n;
      db.prepare('INSERT INTO account_snapshots VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET balance=excluded.balance,ledger_balance=excluded.ledger_balance,observed_ms=excluded.observed_ms')
        .run(accountId, String(balance), String(ledgerBalance), verifier.lastBalanceObservation.observedMs);
      services.events?.emit('treasury:balance_verified', { accountId, balance: String(balance) });
      if (externalChange) services.events?.emit('treasury:balance_refreshed', { accountId, balance: String(balance), externalChange: String(externalChange), reason: 'Idle account balance refreshed from the server; no sale, payout or payment inferred.' });
      this.state = 'BALANCE_CAPTURED';
      return { ok: true, balance: String(balance), balanceDisplay: verifier.lastBalanceObservation?.display, balanceExact: verifier.lastBalanceObservation?.exact, baseline: !previous, externalChange: String(externalChange) };
    } finally { lease?.release(); }
  }
  async tick() {
    if (this.busy || this.stopping || !await require('./trading-controls').globallyEnabled()) return;
    this.busy = true;
    try {
      await this.refreshConfiguredAccounts();
      const roles = await services.settings.get('treasury.accountRoles');
      for (const id of Object.keys(roles)) {
        if (this.stopping || !await require('./trading-controls').globallyEnabled()) break;
        if (roles[id].role === 'intake') await this.flush(id);
      }
    } finally { this.busy = false; }
  }
  async checkIntake(accountId) { return this.flush(accountId); }
  async checkHolder() { return services.listingManager?.syncListing(); }
  whatIf() { return { state: this.state, explanation: 'Only fresh captured balances can authorize transfers or listings.' }; }
}
module.exports = new TreasuryRouter();
module.exports.TreasuryRouter = TreasuryRouter;
