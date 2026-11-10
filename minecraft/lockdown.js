'use strict';
const services = require('../services');
let current = null, starting = null;
function start(context = services) {
  if (current?.state === 'RUNNING') return Promise.resolve(current);
  if (starting) return starting;
  const task = begin(context).finally(() => { if (starting === task) starting = null; });
  starting = task;
  return task;
}
async function begin(context) {
  if (current?.state === 'RUNNING') return current;
  context.store?.setAutosellPaused?.(true);
  await context.settings.set('general.bot.paused', true, 'emergency-lockdown');
  const clients = new Map();
  for (const [id, client] of (context.sessions || context.sessionManager)?.clients || []) clients.set(id, client);
  for (const key of ['mcBot', 'buyer2Bot', 'buyer3Bot', 'verifyBot']) {
    const client = context[key];
    if (client && ![...clients.values()].includes(client)) clients.set(client.accountId || key, client);
  }
  current = { id: require('node:crypto').randomUUID(), state: 'RUNNING', startedAt: Date.now(), accounts: [...clients].map(([id]) => ({ id, state: 'PENDING' })) };
  for (const id of clients.keys()) (context.sessions || context.sessionManager)?.setManualStop?.(id, true);
  const job = current;
  try { context.listingManager?.requestSync?.({ pauseOnly: true }); }
  catch { job.marketplaceWarning = 'Offer pause could not be queued. Check its state in Eldorado.'; }
                                                                      
  context.events?.emit('security:lockdown', { timestamp: new Date().toISOString() });
  Promise.all(job.accounts.map(async item => {
    const client = clients.get(item.id);
    item.state = 'SECURING';
    let timer;
    try {
      const result = await Promise.race([
        client.emergencyLockdown(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Account shutdown did not finish within 35 seconds. Check its connection and inventory before restarting.')), 35000); }),
      ]);
      Object.assign(item, result, { state: result.secured === false || result.disconnected === false ? 'NEEDS_ATTENTION' : 'COMPLETE' });
      if (result.disconnected === false && !item.error) item.error = 'The account did not confirm logout. Check its connection before restarting.';
    } catch (error) {
      item.state = 'NEEDS_ATTENTION'; item.error = 'Could not finish securing this account: ' + error.message;
    } finally { clearTimeout(timer); }
  })).then(() => {
    job.state = job.accounts.some(item => item.state === 'NEEDS_ATTENTION') ? 'PARTIAL' : 'COMPLETED';
    job.completedAt = Date.now();
    job.message = job.state === 'COMPLETED'
      ? (job.accounts.length ? 'Accounts stopped. Global Autosell is off.' : 'Global Autosell is off. No managed accounts needed logging out.')
      : 'Autosell is off. Some accounts need attention; check the account results before restarting.';
  }).catch(error => { job.state = 'PARTIAL'; job.message = error.message; job.completedAt = Date.now(); });
  return job;
}
module.exports = { start, status: () => current || { state: 'IDLE', accounts: [] } };
