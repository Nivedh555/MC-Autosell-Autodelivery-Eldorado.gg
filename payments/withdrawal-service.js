'use strict';
const bitcoin = require('bitcoinjs-lib');
const services = require('../services');
const { build } = require('../wallet/withdrawal-transaction');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exactLitoshi(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number(value.toFixed(8)) !== value)) throw Error('Enter a positive LTC amount with at most 8 decimal places');
  const text = typeof value === 'number' ? value.toFixed(8) : String(value);
  if (text.length > 40) throw Error('Invalid LTC amount');
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(text)) throw Error('Enter a positive LTC amount with at most 8 decimal places');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid LTC amount');
  return Number(amount);
}
function atomic(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
class WithdrawalService {
  constructor(context = services) { this.context = context; }
  send(input) {
    const { wallet } = this.context;
    if (!wallet) return Promise.reject(Error('Wallet unavailable'));
    return wallet._runQueued(() => require('../ops/maintenance').run(this.context,'withdrawal',()=>this._send(input)));
  }
  async _send({ toAddress, amountLtc, all = false, requestId }) {
    const ctx = this.context; const { wallet, settings } = ctx; const db = ctx.db.raw();
    if (!UUID.test(String(requestId))) throw Error('A UUID withdrawal requestId is required; refresh the dashboard');
    const address = String(toAddress || '').trim();
    if (!wallet.enabled || !wallet.isValidAddress(address)) throw Error('Wallet unavailable or invalid Litecoin recipient address');
    if (typeof all !== 'boolean') throw Error('all must be boolean');
    const amount = all ? 0 : exactLitoshi(amountLtc);
    let row = db.prepare('SELECT * FROM wallet_withdrawals WHERE id=?').get(requestId);
    if (row && (row.address !== address || row.requested_litoshi !== String(amount) || Boolean(row.send_all) !== all)) throw Error('Withdrawal requestId is already bound to a different recipient or amount');
    if (row?.state === 'BROADCAST') return JSON.parse(row.result);
    const enabled = ctx.store?.sendEnabled?.() ?? ctx.config.wallet.sendEnabled;
    if (!enabled) throw Error('Send LTC is disabled. Enable it in Controls & Console before withdrawing.');
    if (!ctx.settings?.store?.auditLog?.log || !ctx.ledger) throw Error('Durable wallet audit and ledger are required');
    if (!row) {
      const noPending = () => {
        if (require('../sell/intake-admission').busy) throw Error('A customer sale is being prepared; retain its payout funds');
        if (db.prepare("SELECT 1 FROM orders WHERE status IN ('collecting','payout_failed','needs_operator')").get()) throw Error('A spawner collection or payout needs review before withdrawing');
        if (db.prepare("SELECT 1 FROM intake_sales WHERE state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get()) throw Error('A customer intake is active or unresolved; retain wallet funds for its payout');
        if (db.prepare("SELECT 1 FROM payout_intents WHERE state!='BROADCAST'").get()) throw Error('A sale payout needs reconciliation before withdrawing');
        if (db.prepare("SELECT 1 FROM wallet_withdrawals WHERE state!='BROADCAST'").get()) throw Error('An earlier withdrawal needs reconciliation; retry its original request instead');
      };
      noPending();
      ctx.settings.store.auditLog.log('owner', 'WITHDRAWAL_INTENT', requestId, null, { address, amount: String(amount), all });
      const maxTx = exactLitoshi(await settings.get('wallet.withdrawal.maxLtc'));
      const maxDay = exactLitoshi(await settings.get('wallet.withdrawal.dailyLtc'));
      const maxFee = exactLitoshi(await settings.get('wallet.withdrawal.maxFeeLtc'));
      const tx = await build(wallet, address, amount, all, maxFee);
      if (tx.amount > maxTx) throw Error('Withdrawal exceeds the per-transaction LTC cap');
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const spent = () => db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM ledger WHERE currency='ltc' AND entry_type IN ('payout','fee') AND created_at>=?").get(since.toISOString()).amount;
      const usdTx = Number(await settings.get('wallet.maxPerTxUsd'));
      const usdDay = Number(await settings.get('wallet.maxPerDayUsd'));
      const rate = usdTx > 0 || usdDay > 0 ? await wallet.getRate() : null;
      if (usdTx > 0 && tx.amount / 1e8 * rate > usdTx) throw Error('Withdrawal exceeds the configured USD transaction cap');
      if (!(ctx.store?.sendEnabled?.() ?? ctx.config.wallet.sendEnabled)) throw Error('Send LTC was disabled while preparing the withdrawal');
      atomic(db, () => {
        noPending();
        const daily = spent() + tx.amount + tx.fee;
        if (daily > maxDay || (usdDay > 0 && daily / 1e8 * rate > usdDay)) throw Error('Withdrawal exceeds the daily wallet cap');
        db.prepare("INSERT INTO wallet_withdrawals(id,address,requested_litoshi,send_all,state,amount_litoshi,fee_litoshi,txid,signed_hex,created_ms,updated_ms) VALUES(?,?,?,?,'BROADCAST_INTENT',?,?,?,?,?,?)")
          .run(requestId, address, String(amount), all ? 1 : 0, tx.amount, tx.fee, tx.txid, tx.hex, Date.now(), Date.now());
        for (const u of tx.chosen) db.prepare('INSERT INTO wallet_utxo_reservations(outpoint,withdrawal_id) VALUES(?,?)').run(`${u.txid}:${u.vout}`, requestId);
      });
      row = db.prepare('SELECT * FROM wallet_withdrawals WHERE id=?').get(requestId);
    }
    try {
      const tx = bitcoin.Transaction.fromHex(row.signed_hex);
      if (tx.getId() !== row.txid) throw Error('Persisted withdrawal transaction integrity check failed');
      let acknowledged = false;
                                                                                           
      if (row.state === 'NEEDS_OPERATOR') {
        try { acknowledged = bitcoin.Transaction.fromHex(await wallet._fetchTxHex(row.txid)).getId() === row.txid; }
        catch {                                                                                   }
      }
      if (!acknowledged) {
        const receipt = await wallet._broadcast(row.signed_hex);
        if (receipt !== row.txid) throw Error('Provider returned an unexpected withdrawal transaction ID');
      }
      const result = { success: true, requestId, pending: false, txid: row.txid, litoshi: row.amount_litoshi, fee: row.fee_litoshi, ltc: (row.amount_litoshi / 1e8).toFixed(8), to: address };
      atomic(db, () => {
        for (const [entryType, amount] of [['payout', row.amount_litoshi], ['fee', row.fee_litoshi]]) ctx.ledger.append({
          idempotencyKey: `withdrawal:${requestId}:${entryType}`, entryType, currency: 'ltc', amount, referenceType: 'withdrawal', referenceId: requestId, accountId: 'wallet', metadata: { txid: row.txid },
        });
        db.prepare("UPDATE wallet_withdrawals SET state='BROADCAST',result=?,reason=NULL,updated_ms=? WHERE id=?").run(JSON.stringify(result), Date.now(), requestId);
                                                                                             
      });
      wallet.invalidateBalanceCache();
      return result;
    } catch (error) {
      db.prepare("UPDATE wallet_withdrawals SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=? AND state!='BROADCAST'").run(error.message, Date.now(), requestId);
      const failure = Error('Withdrawal outcome requires reconciliation: ' + error.message + '. Retry the same request; do not create a second withdrawal.');
      failure.receipt = { success: false, requestId, pending: true, txid: row.txid, error: failure.message };
      throw failure;
    }
  }
}
module.exports = { WithdrawalService, exactLitoshi };
