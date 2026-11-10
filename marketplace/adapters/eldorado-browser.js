'use strict';
const crypto = require('node:crypto');
const { MarketplaceAdapter } = require('../adapter-interface');
const { missing, requireProfile, operations, reads } = require('../browser/profile');
const { normalizeOrder, normalizeOffer } = require('../contract/runtime');
const services = require('../../services');
class EldoradoBrowserAdapter extends MarketplaceAdapter {
  constructor(options = {}) {
    super(); this.options = options; this.mode = options.mode || 'live';
    this.profile = structuredClone(options.profile || services.settings?.getSync('eldorado.browser.profile') || require('../browser/profile.json'));
    this.contract = this.profile.contract; this.bridge = options.bridge || services.browserBridge;
    this.db = (options.db || services.db).raw(); this.tail = Promise.resolve();
    if (this.mode === 'mock' && !options.bridge) throw new Error('Mock browser requires isolated transport');
    for (const name of operations) this.capabilities[name] = missing(this.profile, name, this.mode).length === 0;
    this.capabilities.createOffer = false;                                                      
    this.db.prepare("UPDATE browser_actions SET state='NEEDS_OPERATOR',reason='Restart during browser mutation; inspect remote state before retry' WHERE state='INTENT'").run();
  }
  status() { return { connection: 'browser', verified: this.profile.verified && !this.profile.synthetic, missing: missing(this.profile, 'listOrders', this.mode), capabilities: this.capabilities, browser: this.bridge?.status?.() || { state: this.mode === 'mock' ? 'SYNTHETIC' : 'DISCONNECTED' }, accountIdentity: this.profile.accountIdentity?.value || null }; }
  normalizeOrder(data) { return normalizeOrder(data, this.contract); }
  normalizeObservation(data) { return require('../contract/runtime').normalizeObservation(data,this.contract); }
  normalizeOffer(data) { return normalizeOffer(data, this.contract); }
  async invoke(operation, args = {}, preview = false) {
    if (preview && !reads.has(operation)) throw new Error('Setup preview permits reads only');
    if (operation === 'createOffer') throw new Error('Create the offer manually in Eldorado, then select it in Autosell');
    requireProfile(this.profile, operation, this.mode);
    const mutation = !reads.has(operation);
    const execute = async () => {
      if (this.mode !== 'mock' && !preview) await services.rollout.authorize(mutation ? operation : 'read');
      let actionId;
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, args })).digest('hex');
      if (mutation) {
        if (this.db.prepare("SELECT id FROM browser_actions WHERE state IN ('INTENT','NEEDS_OPERATOR') LIMIT 1").get()) throw new Error('Unresolved browser mutation; inspect the action journal');
        if (operation === 'markDelivered') {
          const row = this.db.prepare('SELECT state FROM delivery_orders WHERE id=?').get(args.id);
          if (!row || !['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING','DELIVERED'].includes(row.state)) throw new Error('Payment journal does not authorize marking delivered');
        }
        if (operation === 'sendMessage' && !args.messageId) throw new Error('Persisted outgoing message identifier required');
        actionId = ['createOffer','markDelivered','cancelOrder','sendMessage'].includes(operation) ? operation + ':' + (args.messageId || args.id || fingerprint) : crypto.randomUUID();
        const prior = this.db.prepare('SELECT * FROM browser_actions WHERE id=?').get(actionId);
        if (prior) {
          if (prior.fingerprint !== fingerprint || prior.state !== 'CONFIRMED') throw new Error('Browser action identity changed or outcome unresolved');
          return JSON.parse(prior.result);
        }
        this.db.prepare("INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,created_ms,updated_ms) VALUES(?,?,?,?,'INTENT',?,?,?)").run(actionId, operation, args.id || null, fingerprint, JSON.stringify(args), Date.now(), Date.now());
      }
      try {
        const result = await this.bridge.request({ operation, profile: this.profile, args, preview });
        if (!result?.observation || result.observation.operation !== operation || result.observation.identity !== this.profile.accountIdentity.value || new URL(result.observation.url).origin !== this.profile.origin) throw new Error('Browser observation identity mismatch');
        const expectedUrl = new URL(this.profile.operations[operation].url.replaceAll('{id}', encodeURIComponent(args.id || '')), this.profile.origin).href;
        if (result.observation.url !== expectedUrl) throw new Error('Browser returned a different resource URL');
        if (['getOrder','getOffer'].includes(operation) && result.data?.id !== args.id) throw new Error('Wrong order or offer page');
        if (operation === 'sendMessage' && (!result.data?.id || result.data.text !== args.message || result.data.author !== this.profile.accountIdentity.value)) throw new Error('Sent message is not confirmed by a new seller-authored message');
        if (mutation) this.db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(result.data), Date.now(), actionId);
        return result.data;
      } catch (error) {
        if (mutation) this.db.prepare("UPDATE browser_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=?").run(error.message, Date.now(), actionId);
        services.events?.emit('operator:alert', { component: 'browser', orderId: args.id, reason: error.message });
                                                                                
        throw error;
      }
    };
    const pending = this.tail.then(execute); this.tail = pending.catch(() => {}); return pending;
  }
  listOrders() { return this.invoke('listOrders'); }
  listOrdersPreview() { return this.invoke('listOrders', {}, true); }
  getOrder(id) { return this.invoke('getOrder', { id }); }
  listOffers() { return this.invoke('listOffers'); }
  listOffersPreview() { return this.invoke('listOffers', {}, true); }
  getOffer(id) { return this.invoke('getOffer', { id }); }
  createOffer(offer) { return this.invoke('createOffer', offer); }
  updateOffer(id, changes) { return this.invoke('updateOffer', { ...changes, id }); }
  setStock(id, quantity) { return this.updateOffer(id, { quantity }); }
  pauseOffer(id) { return this.invoke('pauseOffer', { id }); }
  resumeOffer(id) { return this.invoke('resumeOffer', { id }); }
  markDelivered(id) { return this.invoke('markDelivered', { id }); }
  cancelOrder(id, reason) { return this.invoke('cancelOrder', { id, reason }); }
  getMessages(id) { return this.invoke('getMessages', { id }); }
  sendMessage(id, message, messageId) { return this.invoke('sendMessage', { id, message, messageId }); }
  async authenticate() { throw new Error('Log in manually in your visible browser; Autosell never accepts the account password'); }
  async refreshAuth() { throw new Error('Browser login expired; manual sign-in required'); }
  async testConnection() { try { await this.listOrders(); return { success: true, connection: 'browser', operation: 'listOrders' }; } catch (error) { return { success: false, error: error.message }; } }
}
module.exports = { EldoradoBrowserAdapter };
