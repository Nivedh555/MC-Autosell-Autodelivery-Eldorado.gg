'use strict';
const crypto = require('node:crypto');
const services = require('../services');
const { DeliveryRepository } = require('../db/repositories/delivery');
const { integer, validIgn, splitAmount } = require('../minecraft/verified-payments');
const { OwnerPayments } = require('../minecraft/owner-payments');
const { canonical } = require('./trading-controls');
const { connectionRecord } = require('../minecraft/connection-record');

function requestId(id) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) throw Error('A request ID is required. Refresh the dashboard before starting this transfer.');
  return id;
}
function payCommand(command) {
  if (typeof command !== 'string' || /[\r\n]/.test(command)) return null;
  const m = /^\/pay (\.?[A-Za-z0-9_]{3,16}) ([0-9]+(?:\.[0-9]{1,4})?[kmbt]?)$/i.exec(command.trim());
  if (!m) return null;
  const [whole, fraction = ''] = m[2].replace(/[kmbt]$/i, '').split('.');
  const scale = { k: 1000n, m: 1000000n, b: 1000000000n, t: 1000000000000n }[m[2].at(-1).toLowerCase()] || 1n;
  const divisor = 10n ** BigInt(fraction.length), numerator = BigInt(whole + fraction) * scale;
  if (numerator % divisor) return null;
  const amount = numerator / divisor;
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? { recipient: m[1], amount: String(amount) } : null;
}
async function once(id, intent, fn, ctx = services) {
  requestId(id);
  const db = ctx.db.raw(), fingerprint = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const inserted = db.prepare("INSERT OR IGNORE INTO owner_actions VALUES(?,?,'RUNNING',NULL,?,?)").run(id, fingerprint, Date.now(), Date.now()).changes;
  const row = db.prepare('SELECT * FROM owner_actions WHERE id=?').get(id);
  if (row.fingerprint !== fingerprint) throw Error('This request ID belongs to another action. Nothing was repeated.');
  if (!inserted) return row.result ? JSON.parse(row.result) : { success: false, requestId: id, pending: true, reason: 'This request is running or was interrupted. It will not be sent again; inspect its transfer record.' };
  let result;
  try { result = await fn(); }
  catch (error) { result = { success: false, reason: error.message }; }
  result.requestId = id;
  db.prepare("UPDATE owner_actions SET state='COMPLETED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(result), Date.now(), id);
  return result;
}
function assertIdle(account, ctx = services) {
  if (require('../sell/intake-admission').busy) throw Error('A customer intake is active; wait before sweeping game money');
  const db = ctx.db.raw();
  if (db.prepare('SELECT held FROM restore_control WHERE id=1').get()?.held) throw Error('This restored database is still held for review. No sweep was sent.');
  if (db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(account) ||
      db.prepare("SELECT 1 FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get(account) ||
      db.prepare("SELECT 1 FROM transfer_queue WHERE (from_id=? OR to_id=?) AND state IN ('QUEUED','PROCESSING','NEEDS_OPERATOR')").get(account, account)) {
    throw Error(account + ' has an active or unresolved trade. Finish that trade before sweeping its funds. No new payment was sent.');
  }
}
async function money(account, recipients, amount, id, ctx = services) {
  account = canonical(account);
  const roles = await ctx.settings.get('treasury.accountRoles');
  if (!Object.hasOwn(roles || {}, account)) throw Error('Choose a configured Minecraft account.');
  if (!recipients.length || recipients.length > 32 || recipients.some(ign => !validIgn(ign)) || new Set(recipients.map(x => x.toLowerCase())).size !== recipients.length) throw Error('Enter distinct valid Minecraft recipient names.');
  const repo = new DeliveryRepository(ctx.db), orderId = 'owner-money:' + id + ':' + account;
  const prior = repo.get(orderId);
  if (prior) return receipt(repo, orderId);
  assertIdle(account, ctx);
  const policy = await ctx.settings.get('delivery.policy'), pack = await ctx.settings.get('delivery.patternPack');
  if (!(policy?.calibrated || policy?.commandCapacityObserved) || !policy.source) throw Error('No successful payment size has been captured for this server yet. No sweep was sent.');
                                                                                                 
  const nominalPolicy = { ...policy, taxMode: 'buyer', taxBasisPoints: '0' };
  const verifier = new OwnerPayments(pack, (kind, data) => repo.event(orderId, kind, data));
  repo.observe({ id: orderId, buyerIgn: recipients.join(','), amount: amount ?? 'available-balance', offerId: account, gameId: 'owner-money', serverId: account }, 'owner-capture');
  let lease, locked = false, intended = false, sent = 0n;
  try {
    lease = await (ctx.sessions || ctx.sessionManager).acquire(account, orderId, { ttlMs: 300000 }); await lease.ready();
    const raw = lease.getBot();
    if (recipients.some(ign => ign.toLowerCase() === String(raw.username).toLowerCase())) throw Error('The sweep recipient is the sending account itself. Choose a different IGN.');
    repo.event(orderId, 'CONNECTION', connectionRecord(raw, account, lease.getClient?.()));
    await verifier.exclusive(raw, async bot => {
      assertIdle(account, ctx);
      let balance = await verifier.readBalance(bot);
      const reserve = amount == null ? integer(policy.reserve || '0') : 0n;
      const total = amount == null ? (balance > reserve ? balance - reserve : 0n) : integer(amount);
      if (total > balance - reserve) throw Error('The fresh server balance is below the requested payment. No coins were sent.');
      if (!total) { repo.state(orderId, 'CANCELLED', 'No spendable coins above the configured reserve.'); return; }
      if (!repo.lock(orderId, account, orderId, total, balance)) throw Error('Another trade reserved this account. No sweep was sent.');
      locked = true;
      const base = total / BigInt(recipients.length), remainder = total % BigInt(recipients.length);
      const plan = recipients.map((ign, i) => ({ ign, amount: base + (i === recipients.length - 1 ? remainder : 0n) }));
      repo.event(orderId, 'SWEEP_PLAN', { total: String(total), reserve: String(reserve), recipients: plan.map(p => ({ ign: p.ign, amount: String(p.amount) })) });
      let index = 0;
      for (const item of plan) {
        if (!item.amount) continue;
        for (const chunk of splitAmount(item.amount, nominalPolicy)) {
          lease.extend?.(300000);
          if (index && policy.cooldownMs > 0) await new Promise(resolve => setTimeout(resolve, policy.cooldownMs));
          if (pack.recipientBalanceCalibrated) await verifier.readRecipientBalance(bot, item.ign);
          repo.intent(orderId, index, chunk, balance); intended = true;
          const result = await verifier.pay(bot, item.ign, chunk, balance, () => repo.sent(orderId, index));
          if (!result.verified) throw Error('Payment outcome needs review: ' + result.reason + '. This command will not be repeated.');
          repo.verify(orderId, index, result, null, account, () => ctx.ledger.append({ idempotencyKey: orderId + ':' + index, entryType: 'transfer_out', currency: 'donut', amount: Number(chunk.debit), referenceType: 'owner_sweep', referenceId: orderId, accountId: account, metadata: { recipient: item.ign, nominalAmount: String(chunk.command) } }));
          balance = integer(result.after); sent += chunk.command; index++;
          if (pack.recipientBalanceCalibrated) await verifier.readRecipientBalance(bot, item.ign);
        }
      }
      repo.transaction(() => {
        repo.state(orderId, 'TRANSFERRED');
        repo.db.prepare('INSERT INTO balance_observations VALUES(?,?,?,NULL) ON CONFLICT(account_id) DO UPDATE SET balance=excluded.balance,observed_ms=excluded.observed_ms,reason=NULL').run(account, String(balance), Date.now());
        repo.db.prepare('INSERT INTO account_snapshots VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET balance=excluded.balance,ledger_balance=excluded.ledger_balance,observed_ms=excluded.observed_ms').run(account, String(balance), String(ctx.ledger.balance(account, 'donut')), Date.now());
        repo.release(orderId); locked = false;
      });
      ctx.events?.emit('treasury:balance_verified', { accountId: account, balance: String(balance) });
    });
  } catch (error) {
    repo.state(orderId, intended ? 'NEEDS_OPERATOR' : 'CANCELLED', error.message);
    if (locked && !intended) repo.release(orderId);
    ctx.events?.emit('operator:alert', { component: 'sweep', orderId, reason: error.message });
  } finally { lease?.release(); }
  const result = receipt(repo, orderId);
  ctx.events?.emit('treasury:sweep_completed', result);
  if (result.success && result.amount && ctx.logger) {
    try { await ctx.logger.success('DonutFlip · Money sweep', `**${result.amount.toLocaleString('en-US')} coins** sent from **${account}** to **${recipients.join(', ')}**.\nVerified against the server receipt and sender balance.\nReference: \`${orderId}\``, undefined, 'sales'); }
    catch (error) { ctx.events?.emit('operator:alert', { component: 'sweep-notification', orderId, reason: 'The money was verified as sent, but its log-channel notification failed: ' + error.message }); }
  }
  return result;
}
function receipt(repo, id) {
  const row = repo.get(id), chunks = repo.chunks(id), amount = chunks.filter(c => c.state === 'PAY_VERIFIED').reduce((n, c) => n + BigInt(c.command_amount), 0n);
  return { success: row.state === 'TRANSFERRED' || (row.state === 'CANCELLED' && !chunks.length && row.reason?.startsWith('No spendable')), id, account: row.account_id || JSON.parse(row.payload).offerId, state: row.state, amount: Number(amount), reason: row.reason, chunks: chunks.map(chunk => ({ ...chunk })) };
}
async function sweepMoney(account, igns, id, ctx = services) {
  const recipients = igns?.length ? igns : ctx.store?.getSweepConfig()?.owners?.[0]?.igns || [];
  return once(id, { kind: 'money-sweep', account: canonical(account), recipients }, () => money(account, recipients, null, id, ctx), ctx);
}
async function consolePay(account, payment, id, ctx = services) {
  return once(id, { kind: 'console-pay', account: canonical(account), ...payment }, () => money(account, [payment.recipient], payment.amount, id, ctx), ctx);
}
module.exports = { requestId, payCommand, once, assertIdle, money, sweepMoney, consolePay };
