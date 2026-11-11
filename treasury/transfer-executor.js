'use strict';
const crypto = require('node:crypto');
const services = require('../services');
const { DeliveryRepository } = require('../db/repositories/delivery');
const { VerifiedPayments, splitAmount, integer, validIgn } = require('../minecraft/verified-payments');
class TransferExecutor {
  constructor(options = {}) { this.options = options; this.owner = crypto.randomUUID(); }
  async executeTransfer(from, to, amount, transferId) {
    if (!transferId) throw new Error('Stable transfer ID required; random retry IDs are prohibited');
    const repo = new DeliveryRepository(this.options.db || services.db);
    const id = 'transfer:' + transferId;
    const order = { id, kind: 'transfer', buyerIgn: to.username, amount: String(amount), unitSize: '1', offerId: from.id, gameId: 'internal-transfer', serverId: to.id };
    let row = repo.observe(order, this.options.mode === 'mock' ? 'mock' : 'live');
    if (row.state === 'TRANSFERRED') return { ok: true, id, amount: row.payload && JSON.parse(row.payload).amount };
    if (['NEEDS_OPERATOR','DRY_RUN'].includes(row.state) || !repo.claim(id, this.owner)) return { ok: false, id, state: row.state };
    const leases = [];
    try {
      if (row.state !== 'DETECTED') throw new Error('Interrupted transfer: reconcile both accounts; never replay');
      const settings = this.options.settings || services.settings;
      const policy = this.options.policy || await settings.get('delivery.policy');
      const pack = this.options.patternPack || await settings.get('delivery.patternPack');
      if (!(policy?.calibrated || policy?.commandCapacityObserved) || !policy.source || !validIgn(to.username, policy.bedrockPrefix)) throw new Error('Configure the holder Minecraft IGN and a captured payment size before forwarding. No money was sent.');
      const net = integer(amount);
      if (!net || net > BigInt(Number.MAX_SAFE_INTEGER) || !from.id || !to.id) throw new Error('Invalid transfer amount/accounts');
      const authorize = async () => {
        await require('./trading-controls').assertForwarding(from.id, to.id, settings);
                                                                                 
                                                                                
        if (repo.db.prepare('SELECT held FROM restore_control WHERE id=1').get()?.held) throw new Error('Restored database is held for review');
      };
      await authorize();
      const sessions = this.options.sessions || services.sessionManager;
      for (const account of from.id === to.id ? [from] : [from, to]) {
        const lease = await sessions.acquire(account.id, id); leases.push(lease); await lease.ready();
      }
      if (from.id !== to.id && String(leases[1].getBot().username || '').toLowerCase() !== to.username.toLowerCase()) throw new Error('Connected holder IGN differs from transfer recipient; no payment sent');
      await services.listingManager?.beforeDelivery(to.id);
      const sender = new VerifiedPayments(pack, (kind, data) => repo.event(id, kind, { accountId: from.id, ...data }));
      const receiver = new VerifiedPayments(pack, (kind, data) => repo.event(id, kind, { accountId: to.id, ...data }));
      await sender.exclusive(leases[0].getBot(), async fromBot => {
        const before = await sender.readBalance(fromBot);
        if (from.id === to.id) {
          if (before < net + integer(policy.reserve)) throw new Error('Insufficient same-account balance');
          repo.state(id, 'TRANSFERRED', 'Same account; no payment needed or sent'); return;
        }
        await receiver.exclusive(leases[1].getBot(), async toBot => {
          const chunks = splitAmount(net, policy);
          const debit = chunks.reduce((sum, c) => sum + c.debit, 0n);
          let receiverBalance = await receiver.readBalance(toBot), senderBalance = before;
          if (before < debit + integer(policy.reserve)) throw new Error('Insufficient verified intake balance');
          repo.transaction(() => {
            for (const [account, balance] of [[from.id, before], [to.id, receiverBalance]]) {
              if (repo.db.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(account)) throw new Error('Transfer account already reserved or uncertain');
              repo.db.prepare('INSERT INTO delivery_account_locks VALUES(?,?,?,?,?,?)').run(account, id, this.owner, String(debit), String(balance), Date.now());
            }
            repo.db.prepare('UPDATE delivery_orders SET account_id=? WHERE id=?').run(from.id, id);
            repo.state(id, 'RESERVED');
          });
          for (let i = 0; i < chunks.length; i++) {
            if (i) await new Promise(resolve => setTimeout(resolve, policy.cooldownMs));
            await authorize();
            repo.intent(id, i, chunks[i], senderBalance);
            const result = await sender.pay(fromBot, to.username, chunks[i], senderBalance, () => repo.sent(id, i));
            const after = await receiver.readBalance(toBot);
            if (!result.verified || after - receiverBalance !== chunks[i].net) throw new Error('Transfer uncertainty: ' + (result.reason || 'Holder balance delta differs from exact net'));
            const ledger = this.options.ledger || services.ledger;
            repo.verify(id, i, { ...result, holderBefore: String(receiverBalance), holderAfter: String(after) }, null, from.id, () => {
              ledger.append({ idempotencyKey: id + ':out:' + i, entryType: 'transfer_out', currency: 'donut', amount: Number(chunks[i].debit), referenceType: 'transfer', referenceId: id, accountId: from.id });
              ledger.append({ idempotencyKey: id + ':in:' + i, entryType: 'transfer_in', currency: 'donut', amount: Number(chunks[i].net), referenceType: 'transfer', referenceId: id, accountId: to.id });
            });
            receiverBalance = after; senderBalance = integer(result.after);
          }
          repo.transaction(() => { repo.state(id, 'TRANSFERRED'); repo.release(id); });
          const pair = services.pairManager?.getPairBySellerIgn(to.username);
          if (pair) services.pairManager.repo.updateAccumulatedBalance(pair.id, Number(receiverBalance));
        });
      });
      (this.options.events || services.events)?.emit('treasury:transfer_verified', { id, from: from.id, to: to.id, amount: String(net) });
      return { ok: true, id, amount: String(net) };
    } catch (error) {
      repo.state(id, 'NEEDS_OPERATOR', error.message);
      (this.options.events || services.events)?.emit('operator:alert', { component: 'transfer', orderId: id, reason: error.message });
      return { ok: false, id, state: 'NEEDS_OPERATOR', reason: error.message };
    } finally { for (const lease of leases) lease.release(); repo.unclaim(id, this.owner); }
  }
}
module.exports = new TransferExecutor();
module.exports.TransferExecutor = TransferExecutor;
