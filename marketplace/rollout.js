'use strict';
const { missing } = require('./contract/runtime');
const { integer } = require('../minecraft/verified-payments');

                                                                                  
class RolloutController {
  constructor(db, settings, events) {
    this.db = db.raw(); this.settings = settings; this.events = events;
    this.readiness = { ready: false, reason: 'Connect the seller browser and complete delivery setup.' };
  }
  status() { return { mode: 'live', ...this.readiness }; }
  record(action, reason) {
    this.db.prepare('INSERT INTO rollout_events(stage,action,reason,created_ms) VALUES(?,?,?,?)').run('LIVE', action, reason, Date.now());
  }
  async setting(key, fallback) { try { return (await this.settings.get(key)) ?? fallback; } catch { return fallback; } }
  async prerequisites(scope = 'delivery') {
    const readOnly = scope === 'read' || scope === 'S1';
    if (!readOnly && this.db.prepare('SELECT held FROM restore_control WHERE id=1').get()?.held) throw Error('Restored backup requires reconciliation before payments');
    const connection = await this.setting('eldorado.connection', 'api');
    const profile = await this.setting('eldorado.browser.profile', {});
    const contract = connection === 'browser' ? profile.contract || {} : await this.setting('eldorado.contract', {});
    if (contract.synthetic || (connection === 'browser' && profile.synthetic)) throw Error('Synthetic transport cannot authorize real marketplace actions');
    const listing = await this.setting('listing.policy', {}), services = require('../services');
    if(services.marketplace?.documentedSellerApi){await services.marketplace.prerequisites(readOnly);return;}
    if (connection === 'browser' && services.browserFulfillment) {
      if (!listing.offerId || !listing.observedSellerHref) throw Error('Select the existing offer from the correct seller account');
      if (!readOnly) await services.browserFulfillment.prerequisites();
      return;
    }
    const hybrid=services.marketplace?.hybrid || connection==='hybrid';
    const operations = ['listOrders', 'getOrder'];
    if(hybrid)operations.push('getSellerIdentity');
    if (!readOnly) operations.push('markDelivered', 'listOffers', 'getOffer', 'pauseOffer', 'resumeOffer', ...(listing.manageQuantity || listing.managePrice ? ['updateOffer'] : []));
    for (const operation of operations) {
      const absent = connection === 'browser' ? require('./browser/profile').missing(profile, operation) : missing(contract, operation);
      if (absent.length) throw Error('Seller connection needs configuration: ' + absent.join('; '));
    }
    if (readOnly) return;
    if(hybrid){
      if(!services.browserBridge?.status().connected)throw Error('Connect the seller browser for buyer chat and delivery proof.');
      if(!listing.observedSellerHref)throw Error('Connect and select the matching seller profile in Eldorado Setup.');
      if(listing.automatic?.enabled){for(const operation of ['createOffer','deleteOffer',...(listing.automatic.undercut?.enabled?['listCompetitorOffers']:[])]){
        const absent=missing(contract,operation);if(absent.length)throw Error('Seller API needs documentation for '+operation+': '+absent.join('; '));
      }}
    }
    const policy = await this.setting('delivery.policy', {}), pack = await this.setting('delivery.patternPack', {});
    if (!policy.calibrated || !pack.calibrated || /synthetic/i.test(policy.source + ' ' + pack.source)) throw Error('Configure the actual Minecraft payment reply and exact sender balance change. Balance display alone does not confirm a payment.');
    if (!hybrid && String(policy.unitSize) !== String(contract.units.coinsPerUnit)) throw Error('Delivery and marketplace amount units disagree');
    if (connection === 'browser' && (!listing.offerId || !contract.fields?.offer || !contract.offerStatuses?.verified)) throw Error('Select the existing offer and verify its displayed fields');
    if (!services.offerQueue && !(await this.setting('rollout.caps', {})).accountId) throw Error('Select the account that delivers orders.');
  }
  async authorize(action, order, account) {
    if (action === 'createOffer' && !(require('../services').marketplace?.hybrid && (await this.setting('listing.policy',{})).automatic?.enabled)) throw Error('Automatic offer creation must be enabled in Browser + API setup');
    if (action === 'pauseOffer') return;
    if (action === 'read') return this.prerequisites('read');
    if (!await require('../treasury/trading-controls').globallyEnabled(this.settings)) throw Error('Global Autosell is off. Enable it in Controls & Console.');
    if (this.db.prepare('SELECT held FROM restore_control WHERE id=1').get()?.held) throw Error('This installation was restored from a backup and needs reconciliation before payments.');
    if (action === 'intake' || action === 'payout') return;
    await this.prerequisites(action === 'sendMessage' ? 'read' : 'delivery');
    if (action !== 'delivery') return;
    const queue = require('../services').offerQueue;
    const caps = queue ? { accountId: account } : await this.setting('rollout.caps', {});
    if (queue && queue.active(order.offerId)?.account_id !== account) throw Error('This account does not own the current offer turn');
    if (!queue && account !== caps.accountId) throw Error('Delivery account differs from the configured account');
    const amount = integer(order.amount);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM rollout_budget WHERE order_id=?').get(order.id);
      if (existing) {
        if (existing.amount !== String(amount) || existing.account_id !== account) throw Error('Order reservation identity changed');
      } else {
        const day = new Date().toISOString().slice(0, 10);
                                                                               
                                                                              
        this.db.prepare('INSERT INTO rollout_budget VALUES(?,?,?,?)').run(order.id, day, account, String(amount));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async activateConfigured() {
    try {
      if (!await require('../treasury/trading-controls').globallyEnabled(this.settings)) throw Error('Global Autosell is off.');
      await this.prerequisites('delivery');
      const s = require('../services');
      if(s.marketplace?.hybrid){
        const browser=s.browserBridge?.status();
        if(!browser?.connected||!['ATTACHED_PAUSED','RUNNING'].includes(browser.state))throw Error('Connect the selected seller browser for buyer chat and proof.');
        const listing=await this.setting('listing.policy',{}),account=s.offerQueue?.active(listing.offerId)?.account_id||listing.holderAccount;
        if(s.gameBridge&&account&&!s.gameBridge.clients?.has(account))throw Error('Minecraft delivery account '+account+' is offline.');
      }
      if (await this.setting('eldorado.connection', 'api') === 'browser') {
        const browser = s.browserBridge.status();
        if (!browser.connected || !['ATTACHED_PAUSED', 'RUNNING'].includes(browser.state)) throw Error('Open the selected seller Chrome profile');
        if (s.browserFulfillment) {
          const actual = await s.browserBridge.inspectOffers(), listing = await this.setting('listing.policy', {});
          if (actual.sellerHref !== listing.observedSellerHref || !actual.offers.some(offer => offer.id === listing.offerId)) throw Error('Connected seller does not own the selected offer');
        }
      }
      this.readiness = { ready: true, reason: null, checkedMs: Date.now() };
      return true;
    } catch (error) {
      this.readiness = { ready: false, reason: error.message, checkedMs: Date.now() };
      return false;
    }
  }
}
module.exports = { RolloutController };
