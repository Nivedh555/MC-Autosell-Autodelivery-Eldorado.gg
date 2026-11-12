'use strict';
const services = require('../services');
const { VerifiedPayments, integer, splitAmount, deliveryPolicy } = require('../minecraft/verified-payments');
const { field, normalizeOffer } = require('./contract/runtime');
class ListingManager {
  constructor(adapter, pricingEngine, options = {}) {
    this.adapter = adapter; this.pricingEngine = pricingEngine; this.options = options;
    this.db = (options.db || services.db).raw(); this.settings = options.settings || services.settings;
    this.sessions = options.sessions || services.sessions; this.events = options.events || services.events;
    this.busy = false; this.timer = null; this.last = { state: 'not synchronized' };
    this.onStock = () => this.requestSync();
    this.onDelivered = ({orderId}) => {
      const row = this.db.prepare('SELECT account_id,payload FROM delivery_orders WHERE id=?').get(orderId);
      if (row) {
        const order = JSON.parse(row.payload);
        const listing = this.db.prepare('SELECT state FROM listing_state WHERE account_id=? AND offer_id=?').get(row.account_id, order.offerId);
        if (listing?.state === 'PAUSED') services.offerQueue?.completed(order.offerId, row.account_id);
      }
      this.requestSync();
    };
    this.pendingControl = null; this.controlTask = null; this.idleWaiters = [];
    this.controlResult = { state: 'idle' };
  }
  status() { const policy=this.settings.getSync?.('listing.policy'),offer = this.last.offer || policy?.offerId,waitingKey=this.adapter.documentedSellerApi&&policy?.automatic?.enabled?require('./seller-protocol').bindingKey(policy.apiBinding)+':automatic':offer; return { ...this.last, automaticCreation:this.adapter.documentedSellerApi?this.db.prepare("SELECT id,state,offer_id,account_id,reason,created_ms FROM automatic_offer_runs WHERE state='CREATE_INTENT' ORDER BY created_ms LIMIT 1").get()||null:null, control: this.controlResult, records: this.db.prepare('SELECT * FROM listing_state').all(), turn: offer ? services.offerQueue?.active(offer) : null, waiting: waitingKey ? services.offerQueue?.waiting(waitingKey) || [] : [] }; }
  async recoverAutomaticCreation() {
    if(!this.adapter.documentedSellerApi)throw Error('Choose Browser + API and restart Autosell before recovering an automatic offer.');
    const recover=async()=>{
      if(this.busy||this.stopping)throw Error('An offer check is running or Autosell is shutting down. Retry when it finishes.');
      this.busy=true;
      try{this.hybridListings||=new(require('./hybrid-listings').HybridListings)(this);return await this.hybridListings.recoverPendingCreation();}
      finally{this.busy=false;for(const resolve of this.idleWaiters.splice(0))resolve();}
    };
    const queue=this.adapter.services.offerQueue||services.offerQueue;
    const result=queue?await queue.exclusive(recover):await recover();
    this.requestSync();return result;
  }
  requestSync({ pauseOnly = false, notify = false } = {}) {
    if (this.stopping) return { state: 'stopped', reason: 'Autosell is shutting down; no new browser work is accepted.' };
                                                                               
                                                                                       
    this.pendingControl = { pauseOnly, notify };
    this.controlResult = { state: 'pending', operation: pauseOnly ? 'pause' : 'check', requestedMs: Date.now() };
    if (!this.controlTask) this.controlTask = new Promise(resolve => setImmediate(resolve)).then(async () => {
      while (this.pendingControl) {
        if (this.busy) await new Promise(resolve => this.idleWaiters.push(resolve));
        const request = this.pendingControl; this.pendingControl = null;
        this.controlResult = { ...this.controlResult, state: 'running' };
        try {
          const result = request.pauseOnly ? await this.pauseAll() : await this.syncListing();
          this.controlResult = { ...this.controlResult, state: !request.pauseOnly && result === false ? 'blocked' : 'complete', reason: this.last.reason || null, completedMs: Date.now() };
          if (!request.pauseOnly && this.last.reason) this.alert(new Error(this.last.reason));
          if (request.notify && result === true && this.last.state === 'ACTIVE' && (this.last.availabilityOnly ? this.last.availabilityChanged === false : this.last.observedOffer?.paused === false)) this.events?.emit('operator:alert', {
            component: 'listing-success', reason: `Your selected Eldorado offer ${this.last.offer} is already active. Account ${this.last.account}: ${this.last.balance} captured coins, ${this.last.available} available, threshold ${this.last.threshold}. No resume click or buyer payment was needed.`,
          });
        } catch (error) {
          this.controlResult = { ...this.controlResult, state: 'failed', reason: error.message, completedMs: Date.now() };
          this.alert(new Error('Autosell stopped locally; Eldorado offer pause could not be confirmed: ' + error.message));
        }
      }
    }).finally(() => {
      this.controlTask = null;
                                                                                 
      if (this.pendingControl && !this.stopping) this.requestSync(this.pendingControl);
    });
    return { ...this.controlResult };
  }
  alert(error) { this.events?.emit('operator:alert', { component: 'listing', reason: error.message }); }
  async setting(key, fallback) { try { return (await this.settings.get(key)) ?? fallback; } catch { return fallback; } }
  async authorizeControls(account) {
    const choice = await require('../treasury/trading-controls').deliveryAllowed(account, this.settings);
    if (!choice.allowed) throw new Error(choice.reason);
  }
  async start() {
    this.events?.on('marketplace:order_delivered', this.onDelivered);
    for (const name of ['treasury:ready','treasury:transfer_verified','treasury:balance_verified']) this.events?.on(name, this.onStock);
    const policy = await this.setting('listing.policy', {});
    const syncMs = policy.syncMs ?? 30000;                                                                    
    if (Number.isSafeInteger(syncMs) && syncMs >= 1000) {
      this.timer = setInterval(this.onStock, syncMs); this.timer.unref?.();
    }
    await this.syncListing();
  }
  save(account, offer, state, payload = null, reason = null) {
    this.db.prepare('INSERT INTO listing_state VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET offer_id=excluded.offer_id,state=excluded.state,payload=excluded.payload,reason=excluded.reason,updated_ms=excluded.updated_ms')
      .run(account, offer || null, state, payload ? JSON.stringify(payload) : null, reason, Date.now());
    this.last = { state, account, offer, reason, ...payload };
  }
  costBasis(account) {
    const lots = this.db.prepare('SELECT * FROM inventory_cost_lots WHERE account_id=?').all(account);
    if (!lots.length) throw new Error('No recorded acquisition cost for holder stock');
                                                                                                                       
    const worst = lots.reduce((a, b) => (integer(a.fiat_micros) + integer(a.fee_fiat_micros)) * integer(b.net_coins) >= (integer(b.fiat_micros) + integer(b.fee_fiat_micros)) * integer(a.net_coins) ? a : b);
    if (lots.some(l => l.currency !== worst.currency || !integer(l.net_coins))) throw new Error('Invalid/mixed acquisition cost currency');
    return { coins: worst.net_coins, fiatMicros: worst.fiat_micros, feeFiatMicros: worst.fee_fiat_micros, currency: worst.currency,
      timestamp: Math.min(...lots.map(l => l.quoted_ms)), source: worst.source,
      coveredCoins: lots.reduce((sum, l) => sum + integer(l.net_coins), 0n).toString() };
  }
  async beforeDelivery(account,context={}) {
    const row = this.db.prepare('SELECT * FROM listing_state WHERE account_id=?').get(account);
    if (row?.state === 'WRITE_INTENT' || row?.state === 'NEEDS_OPERATOR') throw new Error('Listing outcome unresolved; reconcile before delivering');
    const policy=await this.setting('listing.policy',{});
    if(this.adapter.documentedSellerApi&&context.order?.hybridWorkflow&&!policy.automatic?.enabled){
      if(policy.offerId!==context.order.offerId||services.offerQueue.active(policy.offerId)?.account_id!==account)throw Error('Delivery account or linked offer changed.');
      // Verify stock after the game balance read, before issuing any /pay.
      if(context.balance==null)return;
      const captured=await services.orderPoller.captureApiOrders();
      const pending=captured.orders.filter(o=>o.offerId===policy.offerId&&this.adapter.contract.statuses.paid.includes(o.apiStatus));
      const reserved=require('./listing-reservations').reservedCoins(pending,services.offerQueue.unresolved(policy.offerId),id=>{
        const execution=services.deliveryService.repo.get(id);return execution?{state:execution.state,amount:JSON.parse(execution.payload).amount,chunks:services.deliveryService.repo.chunks(id)}:null;
      });
      const offer=this.adapter.normalizeOffer(await this.adapter.getOffer(policy.offerId));
      if(offer.id!==policy.offerId||offer.sellerHref!==policy.observedSellerHref||offer.unitCoins!==policy.apiBinding?.unitCoins)throw Error('Linked offer identity or currency units changed.');
      const advertised=offer.paused||offer.closed?0n:BigInt(offer.quantityCoins);
      if(BigInt(context.balance)<reserved+advertised+BigInt(policy.reserve||'0')){
        await this.adapter.pauseOffer(policy.offerId);
        this.save(account,policy.offerId,'PAUSED');
        if(BigInt(context.balance)<reserved+BigInt(policy.reserve||'0'))throw Error('Balance cannot cover accepted orders after reserve.');
      }
      return;
    }
    if (row?.offer_id && row.state !== 'PAUSED') {
      if (this.adapter.profile && services.browserBridge?.setOfferAvailability) await this.pauseBrowserOffer(row);
      else await this.adapter.pauseOffer(row.offer_id);
      this.save(account, row.offer_id, 'PAUSED');
    }
  }
  async syncListing() {
    if (services.offerQueue && this.options.mode !== 'mock') return services.offerQueue.exclusive(() => this._syncListing());
    return this._syncListing();
  }
  async selectPair(policy) {
    const queue = services.offerQueue;
    if (!queue || !services.pairManager) return policy;
    if (!policy.offerId) throw Error('Select your manually created Eldorado offer first.');
    const current = queue.active(policy.offerId);
    if (current?.completed) await this.retireTurn(policy.offerId,current.account_id,'Delivery completed');
    const unresolvedListing = this.db.prepare("SELECT account_id FROM listing_state WHERE offer_id=? AND state IN ('WRITE_INTENT','NEEDS_OPERATOR')").get(policy.offerId);
    if (unresolvedListing) throw Error('An earlier offer action is unresolved. The existing account assignment is retained until the remote result is checked.');
    const choices = [];
    const pack = this.options.patternPack || await this.setting('delivery.patternPack', {});
    const pairs = services.pairManager.getPairs();
                                                                               
                                                                           
    if (current?.completed) pairs.sort((a,b)=>Number(require('../treasury/trading-controls').deliveryAccount(a)===current.account_id)-Number(require('../treasury/trading-controls').deliveryAccount(b)===current.account_id));
    for (const pair of pairs) {
      const account = require('../treasury/trading-controls').deliveryAccount(pair);
      if (!(await require('../treasury/trading-controls').deliveryAllowed(account, this.settings)).allowed) continue;
      choices.push(account);
      if (this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(account)) continue;
      let lease;
      try {
        lease = await this.sessions.acquire(account, 'offer-stock-check'); await lease.ready();
        const verifier = new VerifiedPayments(pack, undefined, undefined, {readOnly:true});
        const balance = await verifier.readIdleBalance(lease.getBot());
        const available = balance > integer(policy.reserve || '0') ? balance - integer(policy.reserve || '0') : 0n;
        const waiting = queue.waiting(policy.offerId).some(row=>row.account_id===account);
        queue.observe(policy.offerId, account, available, pair.threshold);
        if (!waiting && available >= integer(pair.threshold) && queue.active(policy.offerId)?.account_id && queue.active(policy.offerId).account_id !== account) this.events?.emit('operator:alert', {component:'listing-queue',reason:`Pair #${pair.pairIndex} (${account}) reached its threshold: ${available} captured available coins. It is waiting for the current offer account to finish.`});
      } catch (error) { this.alert(new Error(`Pair #${pair.pairIndex} (${account}) balance could not be read: ${error.message}`)); }
      finally { lease?.release(); }
    }
    if (queue.unresolved(policy.offerId).length) throw Error('An order for this offer is pending or needs review. Waiting pairs retain their place.');
    const account = queue.select(policy.offerId, choices);
    if (!account) { await this.pauseAll(); this.last = {state:'WAITING_FOR_STOCK',offer:policy.offerId,reason:'No enabled pair has reached its own threshold with a fresh balance.'}; return null; }
    const control = await require('../treasury/trading-controls').deliveryAllowed(account, this.settings);
    if (!control.allowed) { await this.pauseAll(); await this.retireTurn(policy.offerId, account, control.reason); return null; }
    return {...policy,holderAccount:account,threshold:String(control.pair.threshold)};
  }
  async retireTurn(offerId, account, reason) {
    const queue = services.offerQueue;
    if (!queue) return false;
    const raw = await this.adapter.getOffer(offerId);
    const offer = this.adapter.normalizeOffer ? this.adapter.normalizeOffer(raw) : normalizeOffer(raw,this.adapter.contract);
    if (offer.id !== offerId || !offer.paused) throw Error('Offer handoff requires a confirmed marketplace pause. Current pair retained.');
    if (!services.orderPoller) throw Error('Order monitor is not ready for an account handoff.');
    const orders = await this.adapter.listOrders();
    if (!Array.isArray(orders)) throw Error('Complete Sold Orders read is required before switching accounts.');
    for (const data of orders) await services.orderPoller.processDiscoveredOrder(data,{execute:false});
    return queue.release(offerId,account,reason+'; paused offer and fresh orders checked');
  }
  async _syncListing() {
    if (this.busy) return false;
    this.busy = true; let lease, account;
    try {
      if(this.adapter.documentedSellerApi){this.hybridListings||=new(require('./hybrid-listings').HybridListings)(this);return await this.hybridListings.sync();}
      if (this.options.mode !== 'mock' && this.adapter.profile && services.browserBridge?.setOfferAvailability) return await this.syncBrowserAvailability();
      if (this.options.mode !== 'mock' && services.rollout && !await services.rollout.activateConfigured()) {
        throw new Error(services.rollout.status().reason || 'Autosell is switched off. Turn it on in Controls & Console.');
      }
      let policy = {...await this.setting('listing.policy', {})};
      if (services.offerQueue && services.pairManager && this.options.mode !== 'mock') {
        policy = await this.selectPair(policy); if (!policy) return false;
      }
      const control = await require('../treasury/trading-controls').deliveryAllowed(policy.holderAccount, this.settings);
      if (!control.allowed) { await this.pauseAll(); this.last = { state: 'PAUSED', reason: control.reason }; return false; }
      if (control.pair) policy.threshold = String(control.pair.threshold);
      if (this.options.mode !== 'mock' || this.adapter.profile || policy.manualOffer === true) return await this.syncManualOffer(policy);
      account = policy.holderAccount;
      if (!account) { this.last = { state: 'blocked', reason: 'Holder/listing policy not configured' }; return false; }
      const row = this.db.prepare('SELECT * FROM listing_state WHERE account_id=?').get(account);
      if (row && ['WRITE_INTENT','NEEDS_OPERATOR'].includes(row.state)) throw new Error('Unresolved listing mutation; operator reconciliation required');
      if (!await require('../treasury/trading-controls').globallyEnabled(this.settings)) {
        await this.pauseAll(); this.last = { state: 'paused', reason: 'Global Autosell is off' }; return false;
      }
      const rules = this.adapter.contract.listingRules;
      if (!policy.calibrated || !policy.source || !rules?.verified || !rules.source) throw new Error('UNVERIFIED listing rules or policy');
      if (!Number.isSafeInteger(rules.maxOffers) || rules.maxOffers < 1 || !integer(rules.minOrderCoins) || integer(rules.maxOrderCoins) < integer(rules.minOrderCoins)) throw new Error('Invalid documented offer limits');
      const listingUnit = integer(this.adapter.contract.units.coinsPerUnit);
      if (!listingUnit || integer(rules.minOrderCoins) % listingUnit || integer(rules.maxOrderCoins) % listingUnit) throw new Error('Offer bounds must use whole documented units');
      if (this.options.mode !== 'mock') await services.rollout.authorize('createOffer');
      if (this.db.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(account)) throw new Error('Holder has reserved or uncertain payments');
      lease = await this.sessions.acquire(account, 'listing');
      await lease.ready();
      const pack = this.options.patternPack || await this.setting('delivery.patternPack', {});
      const verifier = new VerifiedPayments(pack);
      await verifier.exclusive(lease.getBot(), async bot => {
        const balance = await verifier.readBalance(bot);
        const reserved = this.db.prepare(`SELECT payload FROM delivery_orders WHERE ${require('./listing-reservations').reservesStockSql}`).all()
          .reduce((sum, row) => sum + integer(JSON.parse(row.payload).amount), 0n);
        const reserve = integer(policy.reserve) + reserved;
        const available = balance > reserve ? balance - reserve : 0n;
        if (available < integer(policy.threshold) || available < integer(rules.minOrderCoins)) {
          if (row?.offer_id) { await this.adapter.pauseOffer(row.offer_id); this.save(account, row.offer_id, 'PAUSED'); }
          this.last = { state: 'below threshold', balance: String(balance), available: String(available) }; return;
        }
        const cost = this.options.costProvider ? await this.options.costProvider(account) : this.costBasis(account);
        if (available > integer(cost.coveredCoins)) throw new Error('Holder balance includes stock without a recorded purchase cost');
        const pricing = await this.pricingEngine.calculatePrice(cost, await this.setting('pricing.policy', {}), this.adapter.contract.units);
        const unit = integer(this.adapter.contract.units.coinsPerUnit);
        const quantity = available / unit;
        if (!quantity) throw new Error('Insufficient whole listing units');
        const offer = { quantity: String(quantity), price: pricing.price, gameId: policy.gameId, serverId: policy.serverId,
          minOrder: String(integer(rules.minOrderCoins) / unit), maxOrder: String((available < integer(rules.maxOrderCoins) ? available : integer(rules.maxOrderCoins)) / unit),
          deliveryTime: policy.deliveryTime, description: policy.description };
        if (!row?.offer_id) {
          const offers = await this.adapter.listOffers();
          if (!Array.isArray(offers) || offers.length >= Number(rules.maxOffers)) throw new Error('Documented offer count limit or response mismatch');
        }
        this.save(account, row?.offer_id, 'WRITE_INTENT', { offer, pricing, balance: String(balance), reserved: String(reserve) });
        await this.authorizeControls(account);
        let id = row?.offer_id;
        if (id) {
          await this.adapter.updateOffer(id, offer);
          if (row.state === 'PAUSED') { await this.authorizeControls(account); await this.adapter.resumeOffer(id); }
        }
        else {
          const response = await this.adapter.createOffer(offer);
          id = field(response, rules.offerIdPointer);
          if (typeof id !== 'string' || !id) throw new Error('Create response lacks documented offer identifier');
        }
        this.save(account, id, 'ACTIVE', { offer, pricing, balance: String(balance), reserved: String(reserve) });
      });
      return this.last.state === 'ACTIVE';
    } catch (error) {
      if (account) {
        const row = this.db.prepare('SELECT * FROM listing_state WHERE account_id=?').get(account);
        const uncertain = row && ['WRITE_INTENT', 'NEEDS_OPERATOR'].includes(row.state);
        this.save(account, row?.offer_id, uncertain ? 'NEEDS_OPERATOR' : 'BLOCKED', row?.payload ? JSON.parse(row.payload) : null, error.message);
                                                                       
        if (row?.offer_id) { try { await this.adapter.pauseOffer(row.offer_id); } catch (pauseError) { this.alert(pauseError); } }
      }
      if (!account) this.last = {state:'BLOCKED',reason:error.message};
      this.alert(error); return false;
    } finally { lease?.release(); this.busy = false; for (const resolve of this.idleWaiters.splice(0)) resolve(); }
  }
  async inspectManualOffer(policy) {
    if (!policy.offerId) return { state: 'OFFER_REQUIRED', reason: 'Create a DonutSMP currency offer in Eldorado, leave it paused, then select it here.', offers: [] };
    const offers = await this.adapter.listOffers();
    if (!Array.isArray(offers)) throw new Error('Offer list is not complete or valid');
    const normalize = raw => this.adapter.normalizeOffer ? this.adapter.normalizeOffer(raw) : normalizeOffer(raw, this.adapter.contract);
    const matches = offers.map(normalize).filter(offer => offer.id === policy.offerId);
    if (!matches.length) return { state: 'OFFER_REQUIRED', reason: 'The selected offer was not found. Create it manually or select the correct existing offer.', offers: [] };
    if (matches.length !== 1) throw new Error('Offer identity is ambiguous');
    const offer = normalize(await this.adapter.getOffer(policy.offerId));
    if (offer.id !== policy.offerId || offer.gameId !== policy.gameId || offer.serverId !== policy.serverId) throw new Error('Selected offer does not match the configured game/server identity');
    const used = this.db.prepare("SELECT account_id FROM listing_state WHERE offer_id=? AND account_id!=? AND state NOT IN ('PAUSED','BLOCKED','OFFER_REQUIRED')").get(offer.id, policy.holderAccount);
    if (used) throw new Error('The selected offer is already assigned to another holder');
    return { state: 'OFFER_FOUND', offer };
  }
  async syncManualOffer(policy) {
    const account = policy.holderAccount; let lease, offer;
    try {
      if (!account) { this.last = { state: 'BLOCKED', reason: 'Choose the holder account for this offer.' }; return false; }
      const previous = this.db.prepare('SELECT * FROM listing_state WHERE account_id=?').get(account);
      if (previous && ['WRITE_INTENT','NEEDS_OPERATOR'].includes(previous.state)) throw new Error('Listing action outcome unresolved; inspect the offer before proceeding');
      if (!policy.offerId) { this.save(account, null, 'OFFER_REQUIRED', null, 'Create your offer manually in Eldorado, then choose it in Autosell.'); this.alert(new Error(this.last.reason)); return false; }
      if (!await require('../treasury/trading-controls').globallyEnabled(this.settings)) {
        await this.pauseAll(); this.last = { state: 'PAUSED', reason: 'Global Autosell is off; existing offers require a confirmed pause.' }; return false;
      }
      const found = await this.inspectManualOffer(policy);
      if (!found.offer) { this.save(account, null, found.state, null, found.reason); this.alert(new Error(found.reason)); return false; }
      offer = found.offer;
      this.save(account, offer.id, offer.paused ? 'PAUSED' : 'ACTIVE', { observedOffer: offer });
      if (this.options.mode !== 'mock') await services.rollout.authorize('resumeOffer');
      const rules = this.adapter.contract.listingRules;
      if (!policy.calibrated || !policy.source || !rules?.verified || !rules.source) throw new Error('Offer limits and holder policy need review');
      if (this.db.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(account)) throw new Error('Holder has reserved or uncertain payments');
      lease = await this.sessions.acquire(account, 'listing'); await lease.ready();
      const verifier = new VerifiedPayments(this.options.patternPack || await this.setting('delivery.patternPack', {}));
      return await verifier.exclusive(lease.getBot(), async bot => {
        const balance = await verifier.readBalance(bot);
        const delivery = await this.setting('delivery.policy', {});
        if (!delivery.calibrated || !delivery.source) throw new Error('Calibrate payment limits and tax before resuming an offer');
        const outstanding = this.db.prepare(`SELECT payload,account_id FROM delivery_orders WHERE ${require('./listing-reservations').reservesStockSql}`).all()
          .filter(row => { const data = JSON.parse(row.payload); return data.kind !== 'transfer' && (row.account_id === account || data.offerId === offer.id); })
          .reduce((total, row) => total + splitAmount(JSON.parse(row.payload).amount, deliveryPolicy(delivery, delivery.taxMode==='sender_budget'?require('../minecraft/donutsmp-tax').observedRate(this.db)?.basisPoints:undefined)).reduce((sum, chunk) => sum + chunk.debit, 0n), 0n);
        const reserve = integer(policy.reserve) + outstanding, spendable = balance > reserve ? balance - reserve : 0n;
        const unit = integer(this.adapter.contract.units.coinsPerUnit);
        const available = this.deliverableStock(spendable, delivery, unit);
        const details = { observedOffer: offer, balance: String(balance), reserved: String(reserve), available: String(available), threshold: String(policy.threshold), spendableDebit: String(spendable) };
        if (available < integer(policy.threshold) || available < integer(offer.minOrderCoins) || available < integer(rules.minOrderCoins)) {
          if (!offer.paused) { this.save(account, offer.id, 'WRITE_INTENT', details); await this.adapter.pauseOffer(offer.id); }
          this.save(account, offer.id, 'PAUSED', details, `Offer remains paused: ${available} available coins (${balance} balance, ${reserve} reserved); resume threshold ${policy.threshold}, offer minimum ${offer.minOrderCoins}.`);
          await this.retireTurn(offer.id, account, 'Stock below threshold'); return false;
        }
        const price = await this.manualOfferPricing(policy, account, available);
        if (integer(offer.minOrderCoins) < integer(rules.minOrderCoins) || integer(offer.minOrderCoins) > integer(rules.maxOrderCoins)) throw new Error('Offer minimum quantity conflicts with reviewed order bounds');
        const changes = {};
        if (integer(offer.quantityCoins) > available && !policy.manageQuantity) throw new Error('Your offer quantity exceeds verified available stock. Reduce it manually or enable quantity management.');
        if (policy.manageQuantity && integer(offer.quantityCoins) !== available) changes.quantity = String(available / integer(this.adapter.contract.units.coinsPerUnit));
        if (policy.managePrice && integer(offer.priceMinor) !== integer(price.priceMinor)) changes.price = price.price;
                                                                                          
        await this.authorizeControls(account);
        this.save(account, offer.id, 'WRITE_INTENT', { ...details, pricing: price, changes });
        if (Object.keys(changes).length) {
          if (!offer.paused) await this.adapter.pauseOffer(offer.id);
          await this.adapter.updateOffer(offer.id, changes);
        }
        if (offer.paused || Object.keys(changes).length) { await this.authorizeControls(account); await this.adapter.resumeOffer(offer.id); }
        this.save(account, offer.id, 'ACTIVE', { ...details, pricing: price, changes });
        if (offer.paused) this.events?.emit('operator:alert', { component: 'listing-success', reason: `Eldorado offer resumed: ${offer.id}. Account ${account}: ${balance} captured coins, ${available} available, threshold ${policy.threshold}. The marketplace acknowledged resume; no buyer payment was sent by this check.` });
        return true;
      });
    } catch (error) {
      if (account) {
        const row = this.db.prepare('SELECT * FROM listing_state WHERE account_id=?').get(account);
        const uncertain = row && ['WRITE_INTENT','NEEDS_OPERATOR'].includes(row.state);
        this.save(account, row?.offer_id || offer?.id, uncertain ? 'NEEDS_OPERATOR' : 'BLOCKED', row?.payload ? JSON.parse(row.payload) : null, error.message);
        if (offer && !offer.paused && !uncertain) { try { await this.adapter.pauseOffer(offer.id); } catch (e) { this.alert(e); } }
      }
      this.alert(error); return false;
    } finally { lease?.release(); }
  }
  deliverableStock(balance, policy, unit) {
    if (!unit || !Number.isSafeInteger(policy.maxChunks) || policy.maxChunks < 1 || policy.maxChunks > 1000) throw new Error('Bounded calibrated chunk count required');
                                                                                
                                                                                    
    let low = 0n, high = balance / unit;
    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      let debit;
      try { debit = splitAmount(mid * unit, deliveryPolicy(policy, policy.taxMode==='sender_budget'?require('../minecraft/donutsmp-tax').observedRate(this.db)?.basisPoints:undefined)).reduce((total, chunk) => total + chunk.debit, 0n); }
      catch (error) { if (!/Chunk count limit/.test(error.message)) throw error; debit = balance + 1n; }
      if (debit <= balance) low = mid; else high = mid - 1n;
    }
    return low * unit;
  }
  async manualOfferPricing(policy, account, available) {
                                                                               
                                                                            
    if (policy.managePrice !== true) return null;
    const cost = this.options.costProvider ? await this.options.costProvider(account) : this.costBasis(account);
    if (available > integer(cost.coveredCoins)) throw new Error('Automatic pricing needs a captured acquisition cost for this stock. Disable price management to keep your manually chosen Eldorado price.');
    return this.pricingEngine.calculatePrice(cost, await this.setting('pricing.policy', {}), this.adapter.contract.units);
  }
  async syncBrowserAvailability() {
    const bridge=services.browserBridge,queue=services.offerQueue;
    const policy={...await this.setting('listing.policy',{})};
    if(!policy.offerId)throw Error('Select your existing offer in Eldorado Setup.');
    const globalEnabled=await require('../treasury/trading-controls').globallyEnabled(this.settings);
    if(!globalEnabled){
      await this.pauseAll();this.last={state:'PAUSED',availabilityOnly:true,reason:'Global Autosell is off.'};return false;
    }
    if(this.db.prepare('SELECT held FROM restore_control WHERE id=1').get()?.held)throw Error('Restored backup requires reconciliation before making an offer available.');
                                                                                 
                                                                                  
    const orders=await services.orderPoller?.captureBrowserOrders?.();
    const history=await bridge.inspectOffers();
    if(orders?.sellerHref && orders.sellerHref!==history.sellerHref)throw Error('Sold Orders and Offers belong to different seller accounts.');
    const pack=require('./browser/availability-pack.json'),helper=require('./browser/offer-availability');
    const observed=history.offers.find(offer=>offer.id===policy.offerId);
    if(!observed)throw Error('Your selected offer is not shown in this seller account. Select the existing offer from Eldorado Setup.');
    if(policy.observedSellerHref&&history.sellerHref!==policy.observedSellerHref)throw Error('The connected seller differs from the account where this offer was selected.');
    if(observed.gameLabel!=='DonutSMP')throw Error('The selected offer is not the observed DonutSMP currency offer.');
    const observedState=helper.state(observed,pack);
    if(this.db.prepare("SELECT account_id FROM listing_state WHERE offer_id=? AND state IN ('WRITE_INTENT','NEEDS_OPERATOR')").get(policy.offerId))throw Error('An earlier offer change has an unknown result. Inspect the actual offer before another automatic resume.');
    if(!policy.observedSellerHref){policy.observedSellerHref=history.sellerHref;await this.settings.set('listing.policy',policy,'observed selected offer identity');}
                                                                               
                                                                                 
    const current=queue.active(policy.offerId);
    const held=this.db.prepare('SELECT order_id,status FROM observed_order_holds WHERE offer_id=? AND resolved_ms IS NULL').get(policy.offerId);
    if(queue.unresolved(policy.offerId).length||held){
      await bridge.setOfferAvailability(policy.offerId,true,history.sellerHref,async()=>{});
      if(current?.account_id)this.save(current.account_id,policy.offerId,'PAUSED',{availabilityOnly:true,sellerHref:history.sellerHref},'A detected or unresolved order keeps this offer paused.');
      this.last={state:'ORDER_PENDING',offer:policy.offerId,availabilityOnly:true,reason:'Offer is paused for unfinished order '+(held?.order_id||queue.unresolved(policy.offerId)[0].id)+(held?.status?' ('+held.status+')':'')+'. Threshold is not the blocker. '+(current?.account_id?'Account '+current.account_id+' remains assigned until this order is resolved.':'Order details and its account assignment still need review.')+' Price and listing quantity do not affect this hold.'};return false;
    }
    if(observedState==='closed'){
                                                                                  
                                                                                 
      if(services.orderPoller)await services.orderPoller.captureBrowserOrders();
      this.last={state:'CLOSED',offer:policy.offerId,availabilityOnly:true,reason:'Eldorado shows this offer as Closed. Check the detected order in Eldorado Orders; after it is resolved, replenish/edit the existing offer in Eldorado.'};return false;
    }
    const balances=new Map(),accounts=[],stockErrors=[],pairChecks=[];
    const captureStock=async(pair)=>{
      const account=require('../treasury/trading-controls').deliveryAccount(pair);
      if(this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(account))throw Error('Account has an unresolved payment lock.');
      let lease;
      try{
        lease=await this.sessions.acquire(account,'offer-stock-check');await lease.ready();
        const verifier=new VerifiedPayments(await this.setting('delivery.patternPack',{}),undefined,undefined,{readOnly:true});
        const balance=await verifier.readIdleBalance(lease.getBot());
        const details=helper.stockDecision(observed,balance,pair.threshold,policy.reserve||'0');
        this.db.prepare('INSERT INTO balance_observations VALUES(?,?,?,NULL) ON CONFLICT(account_id) DO UPDATE SET balance=excluded.balance,observed_ms=excluded.observed_ms,reason=NULL').run(account,String(balance),verifier.lastBalanceObservation.observedMs);
        return {...details,capturedMs:verifier.lastBalanceObservation.observedMs,pair};
      }finally{lease?.release();}
    };
    for(const pair of services.pairManager.getPairs()){
      const account=require('../treasury/trading-controls').deliveryAccount(pair);
      const control=await require('../treasury/trading-controls').deliveryAllowed(account,this.settings);
      if(!control.allowed){pairChecks.push({account,pairIndex:pair.pairIndex,eligible:false,reason:control.reason});continue;}
      try{
        const details=await captureStock(pair);
        balances.set(account,details);accounts.push(account);
        pairChecks.push({account,pairIndex:pair.pairIndex,...details,pair:undefined,reason:details.eligible?null:`Pair #${pair.pairIndex}: fresh balance ${details.balance}, reserve ${policy.reserve||'0'}, available ${details.available}; threshold ${pair.threshold}. Add ${integer(pair.threshold)-integer(details.available)} coins to available stock.`});
        queue.observe(policy.offerId,account,details.available,pair.threshold);
      }catch(error){const message=`Pair #${pair.pairIndex}: ${error.message}`;pairChecks.push({account,pairIndex:pair.pairIndex,eligible:false,reason:message});stockErrors.push(message);this.alert(new Error(message));}
    }
    if(current?.account_id&&(!balances.get(current.account_id)?.eligible||current.completed)){
      await bridge.setOfferAvailability(policy.offerId,true,history.sellerHref,async()=>{});
      this.save(current.account_id,policy.offerId,'PAUSED',{availabilityOnly:true,sellerHref:history.sellerHref});
      if(services.orderPoller){await services.orderPoller.captureBrowserOrders();}
      if(services.orderPoller&&!this.db.prepare('SELECT order_id FROM observed_order_holds WHERE offer_id=? AND resolved_ms IS NULL').get(policy.offerId))queue.release(policy.offerId,current.account_id,'Observed pause and fresh Sold Orders checked');
    }
    const account=queue.select(policy.offerId,accounts);let stock=balances.get(account);
    if(!account||!stock?.eligible){
      // Transient grace: if no pair balance could be read at all (session or
      // browser hiccup) but the last verified observation is recent and above
      // threshold, keep the current offer availability instead of flapping it.
      if(!accounts.length&&stockErrors.length){
        const fresh=pairChecks.some(check=>{
          if(!check.account)return false;
          const row=this.db.prepare('SELECT balance,observed_ms FROM balance_observations WHERE account_id=?').get(check.account);
          const pair=services.pairManager.getPairs().find(p=>p.pairIndex===check.pairIndex);
          return Boolean(row&&pair&&Date.now()-row.observed_ms<=120000&&integer(row.balance)>=integer(pair.threshold));
        });
        if(fresh){this.last={state:'STOCK_UNVERIFIED',offer:policy.offerId,availabilityOnly:true,pairChecks,reason:'A transient balance-read failure occurred ('+stockErrors[0]+'). Keeping the current offer availability; the next check retries.'};return false;}
      }
      await bridge.setOfferAvailability(policy.offerId,true,history.sellerHref,async()=>{});
      for(const row of this.db.prepare("SELECT * FROM listing_state WHERE offer_id=? AND state NOT IN ('WRITE_INTENT','NEEDS_OPERATOR')").all(policy.offerId))this.save(row.account_id,policy.offerId,'PAUSED',{availabilityOnly:true,sellerHref:history.sellerHref});
      const reasons=pairChecks.filter(check=>!services.pairManager.getPairs().find(pair=>pair.pairIndex===check.pairIndex)?.disabled).map(check=>check.reason).filter(Boolean);
      this.last={state:'WAITING_FOR_STOCK',offer:policy.offerId,availabilityOnly:true,pairChecks,reason:reasons.length?reasons.join('; '):stockErrors.length?stockErrors.join('; '):'Enable at least one pair in AutoSell Pairs to supply this offer.'};return false;
    }
    if(Date.now()-stock.capturedMs>20000){stock=await captureStock(stock.pair);balances.set(account,stock);}
    const authorize=async actual=>{
      const control=await require('../treasury/trading-controls').deliveryAllowed(account,this.settings);
      if(!control.allowed)throw Error('Autosell was switched off during the offer check.');
      if(Date.now()-stock.capturedMs>30000)throw Error('Stock read became stale before resume; the next stock check will reread it.');
      if(queue.active(policy.offerId)?.account_id!==account||queue.unresolved(policy.offerId).length||this.db.prepare('SELECT order_id FROM observed_order_holds WHERE offer_id=? AND resolved_ms IS NULL').get(policy.offerId))throw Error('Account assignment or order state changed before resume.');
      if(!helper.stockDecision(actual,stock.balance,control.pair.threshold,policy.reserve||'0').eligible)throw Error('Stock is below this pair’s current threshold.');
    };
                                                                            
                                                                  
    await authorize(observed);
    try{
      const result=await bridge.setOfferAvailability(policy.offerId,false,history.sellerHref,async actual=>{
        await authorize(actual);
        this.save(account,policy.offerId,'WRITE_INTENT',{...stock,pair:undefined,availabilityOnly:true,sellerHref:history.sellerHref});
      });
      this.save(account,policy.offerId,'ACTIVE',{balance:stock.balance,available:stock.available,threshold:stock.threshold,observedOffer:result.offer,availabilityOnly:true,availabilityChanged:result.changed,sellerHref:history.sellerHref});
                                                                           
                                                                                 
      if(services.rollout)await services.rollout.activateConfigured();
      if(result.changed)this.events?.emit('operator:alert',{component:'listing-success',reason:`Offer resumed and Active was captured: ${policy.offerId}. Pair #${stock.pair.pairIndex}: ${stock.balance} coins; threshold ${stock.threshold}. Orders are monitored independently of delivery setup.`});
      return true;
    }catch(error){const prior=this.db.prepare('SELECT state FROM listing_state WHERE account_id=?').get(account);this.save(account,policy.offerId,prior?.state==='WRITE_INTENT'?'NEEDS_OPERATOR':'BLOCKED',null,'Offer resume did not complete: '+error.message);throw error;}
  }
  async pauseBrowserOffer(row){
    const payload=row.payload?JSON.parse(row.payload):{};
    const policy=await this.setting('listing.policy',{});
    const seller=payload.sellerHref||policy.observedSellerHref;
    if(!seller)throw Error('Seller identity for this offer has not been captured; pause it manually in Eldorado.');
    await services.browserBridge.setOfferAvailability(row.offer_id,true,seller,async()=>{});
  }
  async pauseAll() {
    if(this.adapter.documentedSellerApi){const policy=await this.setting('listing.policy',{});const ids=new Set([policy.offerId,policy.apiBinding?.templateId,...this.db.prepare("SELECT offer_id FROM automatic_offer_runs WHERE state NOT IN ('DELETED','REJECTED')").all().map(row=>row.offer_id)].filter(Boolean));for(const id of ids){try{await this.adapter.pauseOffer(id);}catch(error){if(error.status!==404)throw error;}}for(const row of this.db.prepare("SELECT * FROM listing_state WHERE offer_id IS NOT NULL").all())this.save(row.account_id,row.offer_id,'PAUSED');return;}
    const processed=new Set();
    for (const row of this.db.prepare("SELECT * FROM listing_state WHERE offer_id IS NOT NULL AND state!='PAUSED'").all()) {
      if(this.adapter.profile&&services.browserBridge?.setOfferAvailability)await this.pauseBrowserOffer(row);
      else await this.adapter.pauseOffer(row.offer_id);
      processed.add(row.offer_id);
                                                                          
      if (!['WRITE_INTENT','NEEDS_OPERATOR'].includes(row.state)) this.save(row.account_id, row.offer_id, 'PAUSED');
    }
                                                                            
                                                                         
    if(this.adapter.profile&&services.browserBridge?.setOfferAvailability){
      const policy=await this.setting('listing.policy',{});
      if(policy.offerId&&!processed.has(policy.offerId)){
        const captured=await services.browserBridge.inspectOffers();
        const helper=require('./browser/offer-availability');
        const seller=policy.observedSellerHref||captured.sellerHref;
        helper.select(captured,policy.offerId,seller);
        await services.browserBridge.setOfferAvailability(policy.offerId,true,seller,async()=>{});
      }
    }
  }
  async stop() {
    this.stopping = true; this.pendingControl = null;
    clearInterval(this.timer);
    this.events?.off('marketplace:order_delivered', this.onDelivered);
    for (const name of ['treasury:ready','treasury:transfer_verified','treasury:balance_verified']) this.events?.off(name, this.onStock);
    if (this.controlTask) await this.controlTask;
    await this.pauseAll();
  }
}
module.exports = { ListingManager };
