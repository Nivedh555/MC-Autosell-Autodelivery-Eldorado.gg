'use strict';
const services = require('../services');
const { once, assertIdle } = require('./owner-actions');
const { DeliveryRepository } = require('../db/repositories/delivery');
const { validIgn, reserveCommandChannel } = require('../minecraft/verified-payments');
const { canonical } = require('./trading-controls');
const { connectionRecord } = require('../minecraft/connection-record');

async function sweep(account, recipient, count, requestId, ctx = services, execute = require('../minecraft/sweep').sweepSkelly) {
  account = canonical(account);
  if (!validIgn(recipient) || (count !== 'all' && (!Number.isSafeInteger(count) || count < 1))) throw Error('Enter a valid Minecraft IGN and a positive whole spawner count, or all.');
  const roles = await ctx.settings.get('treasury.accountRoles');
  if (!Object.hasOwn(roles || {}, account)) throw Error('Choose a configured Minecraft account.');
  return once(requestId, { kind: 'spawner-sweep', account, recipient, count }, async () => {
    assertIdle(account, ctx);
    const repo = new DeliveryRepository(ctx.db), id = 'owner-spawners:' + requestId;
    repo.observe({ id, buyerIgn: recipient, amount: String(count), offerId: account, gameId: 'owner-spawners', serverId: account }, 'owner-capture');
    let lease, releaseChannel, index = 0, intent = false;
    try {
      lease = await (ctx.sessions || ctx.sessionManager).acquire(account, id, { ttlMs: 300000 }); await lease.ready();
      const bot = lease.getBot();
      assertIdle(account, ctx);
      if (String(bot.username).toLowerCase() === recipient.toLowerCase()) throw Error('Choose an admin IGN different from the sending bot.');
      if (!repo.lock(id, account, id, '0', '0')) throw Error('Another trade reserved this account. No spawners were dropped.');
      releaseChannel = reserveCommandChannel(bot);
      repo.event(id, 'CONNECTION', connectionRecord(bot, account, lease.getClient?.()));
      const result = await execute(recipient, count, account, {
        beforeToss: quantity => {
          lease.extend?.(300000); intent = true;
          repo.intent(id, index, { net: quantity, command: quantity, debit: quantity }, 0);
          repo.event(id, 'SPAWNER_DROP_INTENT', { recipient, quantity, index });
        },
        afterToss: quantity => {
          repo.sent(id, index);
          repo.event(id, 'SPAWNER_DROP_CAPTURED', { quantity, index }); index++;
        }
      });
                                                                               
                                            
      if (!result.success) throw Error(result.reason || 'No completed spawner drop was captured.');
      const drops = repo.chunks(id);
      const capturedCount = drops.reduce((sum, drop) => sum + Number(drop.amount), 0);
      if (!intent || result.withdrawn < 1 || result.withdrawn !== capturedCount || drops.some(drop => drop.state !== 'PAY_SENT')) throw Error('The reported sweep count does not match its captured drops. Inspect the bot inventory before retrying.');
      repo.transaction(() => { repo.state(id, 'TRANSFERRED', 'Client item drops captured; recipient pickup is not independently verified.'); repo.release(id); });
      return { ...result, id, pickupVerified: false, message: `Dropped ${result.withdrawn}${result.partial ? ' of the requested ' + count : ''} skeleton spawners for ${recipient}. Check the pickup in-game.` };
    } catch (error) {
      repo.state(id, intent ? 'NEEDS_OPERATOR' : 'CANCELLED', error.message);
      if (!intent) repo.release(id);
      ctx.events?.emit('operator:alert', { component: 'sweep', orderId: id, reason: error.message });
      return { success: false, id, reason: error.message };
    } finally { releaseChannel?.(); lease?.release(); }
  }, ctx);
}
module.exports = { sweep };
