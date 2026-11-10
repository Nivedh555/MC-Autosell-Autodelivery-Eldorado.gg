'use strict';

   
                                                                                 
                                                                               
                                                                                 
  
                                                                              
                                            
   

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const services = require('../services');
const admission = require('./intake-admission');

class SellManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.queue = [];                    
    this.activeId = null;
    this._draining = false;
    this.paused = false;                                                
                                                                                                     
    this.interactions = new Map();
    this.pendingSellers = new Set();
    this.maxQueue = 25;
    admission.on('available', () => this.start());
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this._drain();
  }

  get busy() {
    return Boolean(this.activeId);
  }

                                                             
  async createOrder({ sellerDiscordId, sellerUsername, ltcAddress, requested, interaction }) {
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > services.config.buy.maxPerSell) throw Error('Enter a supported whole number of spawners');
    if (this.pendingSellers.has(sellerDiscordId) || this.hasActiveFor(sellerDiscordId)) throw Error('You already have a spawner order in progress');
    if (this.queue.length + this.pendingSellers.size >= this.maxQueue) throw Error('The spawner queue is full. Do not drop items; try again later.');
    this.pendingSellers.add(sellerDiscordId);
    try {
    const priceUsd = this.store.getPrice();
    const quote = await require('../payments/payout-policy').preflight(services, sellerDiscordId, +(requested * priceUsd).toFixed(6));
    if (quote.address !== ltcAddress) throw Error('Your payout address changed; reopen the sale form');
    const order = {
      id: uuidv4(),
      sellerDiscordId,
      sellerUsername,
      ltcAddress,
      requested,
      priceUsd,
      status: 'queued',
      count: 0,
      payout: null,
      channelId: null,
      reason: null,
      createdAt: new Date().toISOString(),
    };
    this.store.saveOrder(order);
    if (interaction) this.interactions.set(order.id, interaction);
    this.queue.push(order.id);
    const position = this.activeId ? this.queue.length : this.queue.length - 1;                 
    return { order, position };
    } finally { this.pendingSellers.delete(sellerDiscordId); }
  }

  attachChannel(orderId, channelId) {
    const o = this.store.getOrder(orderId);
    if (o) {
      o.channelId = channelId;
      this.store.saveOrder(o);
    }
  }

                                                                            
  positionOf(orderId) {
    const idx = this.queue.indexOf(orderId);
    if (idx === -1) return 0;
    return idx + (this.activeId ? 1 : 0);
  }

                                                                            
  hasActiveFor(discordId) {
    if (this.activeId) {
      const a = this.store.getOrder(this.activeId);
      if (a && a.sellerDiscordId === discordId) return true;
    }
    return this.queue.some((id) => {
      const o = this.store.getOrder(id);
      return o && o.sellerDiscordId === discordId;
    });
  }

  start() {
    this._drain();
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.queue.length) {
        if (this.paused) break;                                               
        if (admission.busy) break;
        const id = this.queue.shift();
        const order = this.store.getOrder(id);
        if (!order || order.status !== 'queued') continue;
        const ticket = admission.acquire(order.sellerDiscordId);
        this.activeId = id;
        let lease, keepAlive;
        try {
          const accountId = services.mcBot?.accountId || 'buyer1';
          lease = await services.sessions.acquire(accountId, 'spawner:' + id, {ttlMs:60000});
          await lease.ready();
          keepAlive = setInterval(() => lease.extend(60000), 30000);
          keepAlive.unref?.();
          await this._process(order);
        } catch (err) {
          order.status = 'needs_operator'; order.reason = 'Interrupted: ' + err.message;
          this.store.saveOrder(order);
          services.events?.emit('operator:alert',{component:'spawner',orderId:id,reason:order.reason});
          await services.logger.error('Order processing crashed', err, { order: id });
        } finally { clearInterval(keepAlive); lease?.release(); ticket.release(); }
        this.activeId = null;
        this.interactions.delete(id);
        await this._refreshPanel();
      }
    } finally {
      this._draining = false;
    }
  }

  async _process(order) {
    const { logger, wallet, mcBot } = services;
    const buy = require('../minecraft/buy');
    const status = require('../discord/seller-status');
    try {
      if (!await require('../treasury/trading-controls').globallyEnabled()) throw Error('Autosell is paused');
      const quote = await require('../payments/payout-policy').preflight(services, order.sellerDiscordId, +(order.requested * order.priceUsd).toFixed(6));
      if (quote.address !== order.ltcAddress) throw Error('The payout address changed while queued; reopen the sale form');
    }
    catch (error) {
      order.status = 'failed'; order.reason = error.message; this.store.saveOrder(order);
      await status.post(order.id, 'Do not drop spawners: ' + error.message);
      return;
    }

    if (!mcBot.isOnline()) {
      order.status = 'failed';
      order.reason = 'Bot is offline';
      this.store.saveOrder(order);
      await status.post(order.id, '❌ The buyer bot is offline right now. Please try again later.');
      return;
    }

                                   
    order.status = 'collecting';
    this.store.saveOrder(order);
    await status.post(order.id, '▶️ **Your turn!** Starting your order now — get online in Minecraft and watch for my teleport.');
    const result = await buy.collect(order);
    if (!result.success || !result.count) {
      order.status = result.needsReview ? 'needs_operator' : 'failed';
      order.reason = result.reason || 'No spawners collected';
      this.store.saveOrder(order);
      if (result.needsReview) services.events?.emit('operator:alert',{component:'spawner',orderId:order.id,reason:order.reason});
      await status.complete(order, { success: false, reason: order.reason });
      return;
    }
    order.count = result.count;

                                                                          
    const usd = +(order.count * order.priceUsd).toFixed(6);
    this.store.recordSale(order.sellerDiscordId, { kind: 'skelly', count: order.count, usd });
    require('../discord/roles').grantSoldRole(order.sellerDiscordId).catch(() => {});
    order.payoutUsd = usd;
    this.store.addExpectedSpawners(order.count);                                  

    const res = await require('./payout').payInstant(order.sellerDiscordId, {
      saleId: order.id,
      ltcAddress: order.ltcAddress,
      usd,
      kind: 'skelly',
      count: order.count,
    });
    order.payout = res;

    if (res.ok) {
      order.status = 'paid';
      this.store.saveOrder(order);
      await logger.success(
        '💀 Skellys bought & paid',
        `Order \`${order.id}\`: ${order.count} skeleton spawner(s) from ||${order.sellerUsername}|| → **${res.ltc} LTC** (${usd.toFixed(4)} USD).`,
        undefined,
        'sales'
      );
      await status.complete(order, { success: true });
                                                                                 
      require('../discord/identity')
        .promptAfterSale({
          discordId: order.sellerDiscordId,
          what: 'skellys',
          interaction: this.interactions.get(order.id),
          feed: res.txid ? { ltc: res.ltc, usd, txid: res.txid, pending: res.pending } : null,
        })
        .catch(() => {});
    } else {
                                                                                   
      this.store.addBalanceUsd(order.sellerDiscordId, usd);
      order.status = 'payout_failed';
      order.reason = res.message || res.reason;
      this.store.saveOrder(order);
      await logger.error('Skelly payout failed — balance parked', `Order \`${order.id}\`: collected ${order.count} spawner(s) but LTC payout failed (${order.reason}). Parked ${usd.toFixed(4)} USD for manual release.`, { order: order.id });
      await status.complete(order, {
        success: false,
        reason: `I bought your **${order.count}** spawner(s) but the automatic LTC payout failed (${order.reason}). Your **$${usd.toFixed(4)}** is safe — staff have been notified and will release it.`,
      });
    }

                                                                              
    require('../minecraft/sweep').reportHoldings().catch((err) => logger.error('Holdings report failed', err));
  }

  async _refreshPanel() {
    require('../discord/balance-monitor').check().catch(() => {});                                
    try {
      await require('../discord/panel').refresh(true);                                             
    } catch {
                       
    }
    try {
      await require('../discord/stats-channels').refresh();
    } catch {
                       
    }
  }
}

module.exports = SellManager;
