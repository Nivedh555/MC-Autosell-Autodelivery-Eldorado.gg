'use strict';
const normalized = value => value === 'api' ? 'hybrid' : value;
function connectionState(configured, context = require('../services')) {
  configured = normalized(configured || 'browser');
  const adapter = context.marketplace;
  const active = adapter?.documentedSellerApi ? 'hybrid' : adapter?.profile ? 'browser' : null;
  const pending = context.marketplacePendingRestart?.adapter === adapter ? context.marketplacePendingRestart : null;
  const mismatch = configured === 'hybrid' ? active !== 'hybrid' : configured === 'browser' ? active !== 'browser' : true;
  const restartRequired = Boolean(mismatch || pending);
  const reason = !restartRequired ? null : pending?.reason || (configured === 'hybrid'
    ? 'Browser + API is saved, but the running marketplace worker has not loaded the Seller API adapter. Stop Autosell with Ctrl+C, start it again from this installation folder, then reconnect the matching seller Chrome profile. Your saved credentials will be kept.'
    : 'The saved seller connection is not loaded by the running marketplace worker. Restart Autosell from this installation folder and reconnect the seller browser.');
  return { configuredConnection: configured, activeConnection: active, restartRequired, reason };
}
module.exports = { connectionState, normalized };
