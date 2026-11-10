'use strict';
const services = require('../services');
function canonical(value) {
  const text = String(value ?? '');
  if (/^[1-9]\d*$/.test(text)) return 'buyer' + text;
  return text.replace(/^(buyer|seller)_([1-9]\d*)$/, '$1$2');
}
function pairFor(account) {
  const id = canonical(account);
  return services.pairManager?.getPairs().find(pair => [canonical(pair.buyerId), canonical(pair.sellerId)].includes(id));
}
function hasHolder(pair) { return Boolean(pair?.sellerEmail?.trim() || pair?.sellerIgn?.trim()); }
function deliveryAccount(pair) { return canonical(hasHolder(pair) ? pair.sellerId : pair.buyerId); }
async function globallyEnabled(settings = services.settings) {
  if(services.maintenance?.blocked())return false;
  return !(await settings?.get('general.bot.paused')) && !services.store?.autosellPaused?.();
}
async function deliveryAllowed(account, settings = services.settings) {
  if (!await globallyEnabled(settings)) return { allowed: false, reason: 'Global Autosell is disabled' };
  const pair = pairFor(account);
  if (services.pairManager && !pair) return { allowed: false, reason: 'Delivery account is not assigned to a pair' };
  if (pair?.disabled) return { allowed: false, reason: 'Autosell is disabled for pair #' + pair.pairIndex };
  if (pair && canonical(account) !== deliveryAccount(pair)) return { allowed: false, reason: 'Select ' + deliveryAccount(pair) + ' as the delivery account in Eldorado Setup' };
  if(pair&&!services.gameBridge?.tokens.has(canonical(account))&&!String(pair[canonical(account).startsWith('seller')?'sellerEmail':'buyerEmail']||'').trim())return {allowed:false,reason:'This account is not configured. Leave the optional pair stopped or add its Microsoft email.'};
  return { allowed: true, pair };
}
async function forwarding(account, settings = services.settings) {
  const pair = pairFor(account);
  const configured = await settings?.get('treasury.forwarding') || {};
  const enabled = configured[canonical(account)] === true;
  return { enabled, pair, destination: pair && hasHolder(pair) ? canonical(pair.sellerId) : null };
}
async function assertForwarding(from, to, settings = services.settings) {
                                                                              
                                                                    
  if (!services.pairManager) return;
  const choice = await forwarding(from, settings);
  if (!choice.enabled) throw new Error('Send to holder is disabled for ' + canonical(from));
  if (!choice.destination || choice.destination !== canonical(to)) throw new Error('Configured pair holder does not match transfer destination');
  if (!await globallyEnabled(settings)) throw new Error('Global Autosell is disabled');
}
function assertEditable(pair) {
  if (!pair) throw new Error('Pair not found');
  if (pair.currentOrderId || pair.lockedAt || ['DELIVERING','BUSY'].includes(pair.state)) throw new Error('Pair has an active or unresolved order');
  const db = services.db?.raw();
  if (!db) return;
  for (const account of [canonical(pair.buyerId), canonical(pair.sellerId), pair.buyerId, pair.sellerId]) {
    if (db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(account) ||
        db.prepare("SELECT 1 FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','NEEDS_OPERATOR')").get(account) ||
        db.prepare("SELECT 1 FROM transfer_queue WHERE (from_id=? OR to_id=?) AND state IN ('QUEUED','PROCESSING','NEEDS_OPERATOR')").get(account, account)) throw new Error('Account has an active or unresolved sale/transfer; retain the pair for reconciliation');
  }
}
module.exports = { canonical, pairFor, hasHolder, deliveryAccount, globallyEnabled, deliveryAllowed, forwarding, assertForwarding, assertEditable };
