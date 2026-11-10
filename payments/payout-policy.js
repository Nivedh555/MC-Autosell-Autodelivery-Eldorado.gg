'use strict';
const { integer } = require('../minecraft/verified-payments');
function validate(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw Error('Payout policy must be an object');
  if (typeof policy.enabled !== 'boolean') throw Error('Choose whether automatic seller payouts are enabled');
  const addressMode = policy.addressMode || 'allowlist';
  if (!['allowlist','linked-seller'].includes(addressMode)) throw Error('Choose explicit addresses or linked Discord sellers');
  const perTx = integer(policy.maxPerTxFiatMicros || '0'), perDay = integer(policy.maxPerDayFiatMicros || '0');
  if (policy.enabled && (!perTx || perDay < perTx)) throw Error('Set positive payout caps; daily cap must cover the transaction cap');
  if (perTx > BigInt(Number.MAX_SAFE_INTEGER) || perDay > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Payout caps exceed supported precision');
  if (policy.allowedAddresses !== undefined && (!Array.isArray(policy.allowedAddresses) || policy.allowedAddresses.some(a => typeof a !== 'string'))) throw Error('Payout address allow-list must be a list of Litecoin addresses');
  if (policy.enabled && addressMode === 'allowlist' && !policy.allowedAddresses?.length) throw Error('Add a payout address or choose linked Discord sellers');
  return { ...policy, addressMode, allowedAddresses: policy.allowedAddresses || [], maxPerTxFiatMicros: String(perTx), maxPerDayFiatMicros: String(perDay) };
}
function recipientAllowed(policy, discordId, address, context) {
  if (policy.allowedAddresses?.includes(address)) return true;
  if (policy.addressMode !== 'linked-seller') return false;
  const seller = context.store?.getSeller(discordId);
  return Boolean(seller && seller.ltcAddress === address && context.wallet?.isValidAddress(address));
}
async function preflight(context, discordId, usd) {
  if (!context.wallet?.enabled) throw Error('The owner has not configured the Litecoin payout wallet');
  if (!(context.store?.sendEnabled?.() ?? context.config?.wallet?.sendEnabled)) throw Error('The owner must enable Send LTC before accepting a sale');
  await require('./automatic-intake').configure(context.settings);
  const policy = validate(await context.settings.get('payout.policy'));
  if (!policy.enabled) throw Error('Automatic seller payouts are disabled by the owner');
  const seller = context.store.getSeller(discordId);
  if (!recipientAllowed(policy, discordId, seller?.ltcAddress, context)) throw Error('Your saved Litecoin address is not permitted by the owner payout policy');
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isSafeInteger(Math.round(usd * 1e6))) throw Error('The configured buy rate does not produce a positive supported payout');
  const fiat = integer(Math.round(usd * 1e6));
  if (fiat > integer(policy.maxPerTxFiatMicros)) throw Error('This sale exceeds the owner transaction payout limit');
  const db = context.db.raw();
  if (db.prepare("SELECT 1 FROM payout_intents WHERE state!='BROADCAST'").get()) throw Error('An earlier customer payout needs review before accepting another sale');
  if (db.prepare("SELECT 1 FROM intake_sales WHERE state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get()) throw Error('An earlier money intake is active or unresolved; do not send coins or items');
  if (db.prepare("SELECT 1 FROM orders WHERE status IN ('collecting','payout_failed','needs_operator')").get()) throw Error('An earlier spawner collection or payout needs review before accepting another sale');
  const since = new Date(); since.setUTCHours(0,0,0,0);
  const used = db.prepare('SELECT fiat_micros FROM payout_intents WHERE created_ms>=?').all(since.getTime()).reduce((n,r) => n + integer(r.fiat_micros), 0n);
  if (used + fiat > integer(policy.maxPerDayFiatMicros)) throw Error('The owner daily payout limit is exhausted');
  if (db.prepare("SELECT 1 FROM wallet_withdrawals WHERE state!='BROADCAST'").get()) throw Error('An owner withdrawal needs review before new sales');
  const litoshi = await context.wallet.usdToLitoshi(usd);
  const globalTx = Number(await context.settings.get('wallet.maxPerTxUsd'));
  const globalDay = Number(await context.settings.get('wallet.maxPerDayUsd'));
  if (globalTx > 0 && usd > globalTx) throw Error('This sale exceeds the global wallet payout limit');
  if (globalDay > 0) {
    const spent = context.ledger.query({entryType:'payout',currency:'ltc',since:since.toISOString()}).reduce((n,r)=>n+r.amount,0);
    if ((spent+litoshi)/1e8 * context.wallet.cachedRate() > globalDay) throw Error('The global wallet daily payout limit is exhausted');
  }
  const available = await context.wallet._availableUtxos(false);
  const balance = available.reduce((n,u) => n+u.value,0);
  const feeRate = await context.wallet._feeRate();
  const feeReserve = Math.ceil((12 + Math.max(1, available.length) * (context.wallet.type === 'legacy' ? 149 : 69) + 90) * feeRate);
  if (litoshi < 546 || balance < litoshi + feeReserve) throw Error('The wallet cannot currently cover this payout and its network fee; do not send items or coins');
  return { usd, litoshi, address:seller.ltcAddress };
}
module.exports = { validate, recipientAllowed, preflight };
