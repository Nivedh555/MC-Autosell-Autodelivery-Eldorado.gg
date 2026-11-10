'use strict';
const services = require('../services');
const { integer } = require('../minecraft/verified-payments');
class PayoutService {
  constructor() { this.chain = Promise.resolve(); this.pending = 0; }
  payInstant(discordId, input) {
    if (this.pending >= 100) return Promise.resolve({ok:false,reason:'Payout processing is busy; operator review required'});
    this.pending++;
    const task = this.chain.then(() => require('../sell/intake-admission').runSale(discordId,input.saleId,
      () => require('../ops/maintenance').run(services,'payout',()=>this._payInstant(discordId, input))));
    this.chain = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }
  async _payInstant(discordId, { ltcAddress, usd, kind, donut = 0, count = 0, saleId }) {
    const { db: database, wallet, settings, ledger } = services;
    if (!saleId || !database) return { ok: false, reason: 'durable_sale_id_required' };
    const db = database.raw();
    const previous = db.prepare('SELECT * FROM payout_intents WHERE id=?').get(saleId);
    if (previous) {
      if (previous.discord_id !== discordId || previous.address !== ltcAddress || previous.fiat_micros !== String(Math.round(usd * 1000000))) return { ok: false, reason: 'payout_identity_changed' };
      return previous.state === 'BROADCAST' ? JSON.parse(previous.result) : { ok: false, reason: previous.state, message: 'Existing payout intent requires operator reconciliation; no repeat broadcast' };
    }
    try {
      if (db.prepare("SELECT 1 FROM payout_intents WHERE state!='BROADCAST'").get()) throw Error('An earlier sale payout needs reconciliation before another payout');
      if (!ltcAddress || !wallet?.enabled || !Number.isFinite(usd) || usd <= 0 || !Number.isSafeInteger(Math.round(usd * 1000000))) throw new Error('Invalid payout or wallet unavailable');
      await services.rollout.authorize('payout');
      const policy = require('./payout-policy').validate(await settings.get('payout.policy'));
      const fiatMicros = integer(Math.round(usd * 1000000));
      if (!policy.enabled || !integer(policy.maxPerTxFiatMicros) || !integer(policy.maxPerDayFiatMicros) || fiatMicros > integer(policy.maxPerTxFiatMicros)) throw new Error('Payout cap or enablement missing/exceeded');
      if (!require('./payout-policy').recipientAllowed(policy, discordId, ltcAddress, services)) throw new Error('Payout recipient does not match the permitted seller address');
      const litoshi = await wallet.usdToLitoshi(usd);
      if (!Number.isSafeInteger(litoshi) || litoshi <= 0) throw new Error('Invalid exact wallet amount');
      const rate = wallet.cachedRate();
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('No captured LTC price quote');
                                                                              
                                                                          
      const concurrent = db.prepare('SELECT * FROM payout_intents WHERE id=?').get(saleId);
      if (concurrent) return {ok:false,reason:'Existing payout requires reconciliation; no repeat broadcast'};
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare("SELECT 1 FROM payout_intents WHERE state!='BROADCAST'").get()) throw Error('An earlier sale payout needs reconciliation');
        const start = new Date().toISOString().slice(0,10);
        const spent = db.prepare('SELECT fiat_micros FROM payout_intents WHERE created_ms>=?').all(Date.parse(start))
          .reduce((sum, row) => sum + integer(row.fiat_micros), 0n);
        if (spent + fiatMicros > integer(policy.maxPerDayFiatMicros)) throw new Error('Daily payout cap exceeded');
        db.prepare("INSERT INTO payout_intents(id,discord_id,address,fiat_micros,litoshi,state,created_ms) VALUES(?,?,?,?,?,'BROADCAST_INTENT',?)")
          .run(saleId, discordId, ltcAddress, String(fiatMicros), String(litoshi), Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
                                                                                       
      const sent = await wallet.send(ltcAddress, litoshi, { intentId: saleId });
      if (sent.dryRun || typeof sent.txid !== 'string' || !/^[a-f0-9]{64}$/i.test(sent.txid)) throw new Error('Wallet did not return a real transaction identifier');
      const result = { ok: true, ...sent, usd, ltc: (litoshi / 1e8).toFixed(8),
        fiatMicros: String(fiatMicros), feeFiatMicros: String(Math.ceil(Number(sent.fee) * rate / 100)),
        quoteFiatMicrosPerLtc: String(Math.round(rate * 1000000)), quotedMs: Date.now(),
        pending: { moneyDonut: kind === 'money' ? donut : 0, moneyUsd: kind === 'money' ? usd : 0, skellyCount: kind === 'skelly' ? count : 0, skellyUsd: kind === 'skelly' ? usd : 0 } };
      integer(result.feeFiatMicros);
      db.exec('BEGIN IMMEDIATE');
      try {
        ledger.append({ idempotencyKey: 'payout:' + saleId, entryType: 'payout', currency: 'ltc', amount: litoshi,
          referenceType: 'sale', referenceId: saleId, accountId: 'wallet', metadata: { txid: sent.txid, fiatMicros: String(fiatMicros), quotedMs: result.quotedMs } });
        ledger.append({ idempotencyKey: 'payout-fee:' + saleId, entryType: 'fee', currency: 'ltc', amount: Number(sent.fee),
          referenceType: 'sale', referenceId: saleId, accountId: 'wallet', metadata: { txid: sent.txid } });
        const settlement = db.prepare('INSERT OR IGNORE INTO seller_payout_settlements(sale_id,discord_id,usd_micros,txid,settled_ms) VALUES(?,?,?,?,?)').run(saleId,discordId,String(fiatMicros),sent.txid,Date.now());
        if (settlement.changes) {
          const seller = db.prepare('SELECT stats FROM sellers WHERE discord_id=?').get(discordId);
          if (seller) {
            const stats = JSON.parse(seller.stats || '{}');
            stats.cashedOutUsd = +((stats.cashedOutUsd || 0) + usd).toFixed(6);
            stats.pending ||= {};
            for (const [key, amount] of Object.entries(result.pending)) stats.pending[key] = Math.max(0,+((stats.pending[key]||0)-amount).toFixed(6));
            db.prepare('UPDATE sellers SET stats=?,updated_at=? WHERE discord_id=?').run(JSON.stringify(stats),new Date().toISOString(),discordId);
          }
        }
        db.prepare("UPDATE payout_intents SET state='BROADCAST',result=? WHERE id=?").run(JSON.stringify(result), saleId);
        db.prepare("UPDATE intake_sales SET state='COMPLETED' WHERE id=? AND state='RECEIVED'").run(saleId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return result;
    } catch (error) {
      db.prepare("UPDATE payout_intents SET state='NEEDS_OPERATOR',reason=? WHERE id=? AND state!='BROADCAST'").run(error.message, saleId);
      services.events?.emit('operator:alert', { component: 'payout', saleId, reason: error.message });
      return { ok: false, reason: 'NEEDS_OPERATOR', message: error.message };
    }
  }
}
module.exports = new PayoutService();
module.exports.PayoutService = PayoutService;
