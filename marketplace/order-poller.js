'use strict';
const services = require('../services');
const { DeliveryRepository } = require('../db/repositories/delivery');
class OrderPoller {
  constructor(adapter, deliveryService, options = {}) {
    this.adapter = adapter;
    this.deliveryService = deliveryService;
    this.options = options;
    this.repo = deliveryService?.repo || new DeliveryRepository(options.db || services.db);
    this.observations = new (require('./order-observations').OrderObservations)(options.db || this.repo.database || services.db);
    this.isRunning = false; this.busy = false; this.errorCount = 0; this.timeout = null;
  }
  start() { if (this.isRunning) return; this.isRunning = true; void this.poll();if(this.adapter.hybrid)this.scheduleDiscovery(); }
  stop() { this.isRunning = false; clearTimeout(this.timeout);clearTimeout(this.discoveryTimer);clearImmediate(this.wake);this.wake=null;this.pollRequested=false; }
  scheduleDiscovery(){
    if(!this.isRunning)return;
    this.discoveryTimer=setTimeout(async()=>{try{await this.discoveryTick();}finally{this.scheduleDiscovery();}},5000);
    this.discoveryTimer.unref?.();
  }
  async discoveryTick(){
    // API-only admission can continue while the delivery worker is waiting for
    // Minecraft/proof. captureApiOrders is singleflight and persists observations
    // and stock holds. It never dispatches money or takes the browser queue.
    if(!this.isRunning||!this.busy||!this.adapter.hybrid)return;
    try{await this.captureApiOrders();this.discoveryError=null;}
    catch(error){this.discoveryError=error.message;}
  }
  requestPoll() {
    if(!this.isRunning)return;
    if(this.busy){this.pollRequested=true;return;}
    if(this.wake)return;
    clearTimeout(this.timeout);
    this.wake=setImmediate(()=>{this.wake=null;if(this.isRunning)void this.poll();});
    this.wake.unref?.();
  }
  async setting(key, fallback) {
    try { return (await (this.options.settings || services.settings)?.get(key)) ?? fallback; } catch { return fallback; }
  }
  succeeded(result) {
    this.lastPollMs=Date.now();this.lastError=null;this.blockedReason=null;this.errorCount=0;
    return result;
  }
  async poll({ inspect = false } = {}) {
    if (this.busy) return {success:false,message:'An order check is already running. Wait for it to finish.'};
    this.busy = true;
    try {
      {
        let enabled = await require('../treasury/trading-controls').globallyEnabled(this.options.settings || services.settings);
                                                                                
                                                                               
                                                                                 
        this.repo.recoverCompletionHolds();
        if(this.adapter.hybrid)this.repo.recoverListingHolds();
        const processed=new Set();
        const browserReady=()=>{const status=services.browserBridge?.status();return Boolean(status?.connected&&['ATTACHED_PAUSED','RUNNING'].includes(status.state));};
        const drain=async(limit)=>{
          if(this.adapter.hybrid&&this.options.mode!=='mock'&&!browserReady())return;
          this.fairWork||=new(require('./fair-batch').FairBatch)();
          const pending=this.repo.pending().filter(row=>!processed.has(row.id)&&JSON.parse(row.payload).kind!=='transfer'&&!this.deliveryService.ownerHeld(row.id));
          for(const row of this.fairWork.take(pending,Math.max(0,limit-processed.size))){
            processed.add(row.id);await this.deliveryService.processOrder(JSON.parse(row.payload),row.account_id||undefined);
          }
        };
        if(enabled&&!inspect&&this.deliveryService&&await this.setting('eldorado.order.auto_deliver',false)){
          const complete=()=>drain(2);
          if(services.offerQueue&&this.options.mode!=='mock')await services.offerQueue.exclusive(complete);else await complete();
        }
        let captured;
        if(this.adapter.hybrid&&this.options.mode!=='mock'){
          captured=await this.captureApiOrders();
          if(inspect||!enabled)return this.succeeded({success:true,count:captured.orders.length,message:`Read ${captured.orders.length} monitored orders since setup; no payment sent by this refresh.`});
          if(!browserReady())return this.succeeded({success:true,count:captured.orders.length,message:'Orders recorded. Waiting for the seller browser to reconnect before processing deliveries.'});
        }else if (services.browserBridge?.inspectOrders && this.adapter.profile && this.options.mode !== 'mock') {
          const result = await this.captureBrowserOrders();
          captured = result;
                                                                              
          if (!inspect && services.browserFulfillment) await services.rollout?.activateConfigured();
          if(inspect || !enabled || (!services.browserFulfillment && !this.adapter.capabilities?.listOrders)) return this.succeeded({success:true,count:result.orders.length,message:`Read ${result.orders.length} Sold Orders for ${new URL(result.sellerHref).pathname.split('/').at(-1)}. New orders are recorded and reported. No buyer payment was sent by this history read.`});
        }
        if (!enabled && !inspect) return {success:false,message:'Automatic fulfillment is stopped. Use Check orders now for a read-only Sold Orders refresh.'};
        let orders;
        if(this.adapter.hybrid&&captured){
          orders=await this.prepareHybridBatch(captured.raw);
        }else if (captured && services.browserFulfillment) {
          orders=[];
          const offers=await services.browserBridge.inspectOffers();
          for (const {order,reference} of captured.references || []) {
            if (this.deliveryService.ownerHeld(order.id)) continue;
            try {
              const normalized=await services.browserFulfillment.normalize(order,reference,offers);
              if(normalized)orders.push(normalized);
            } catch(error) { services.events?.emit('operator:alert',{component:'order-routing',orderId:order.id,reason:error.message}); }
          }
        } else orders = inspect && this.adapter.listOrdersPreview ? await this.adapter.listOrdersPreview() : await this.adapter.listOrders();
        if (!Array.isArray(orders)) throw new Error('Order-list response violates contract');
        const process = async () => {
                                                                            
                                                                             
        for (const order of orders) await this.processDiscoveredOrder(order, {execute:false,admit:enabled && !inspect});
        if (enabled && !inspect && await this.setting('eldorado.order.auto_deliver', false)) {
          await drain(4);
        }
        };
        if (services.offerQueue && this.options.mode !== 'mock') await services.offerQueue.exclusive(process); else await process();
        return this.succeeded({success:true,count:orders.length,message:`Read ${orders.length} Sold Orders. ${inspect ? 'Read-only refresh; no payment or marketplace change was sent.' : 'Eligible funded orders are processed separately.'}`});
      }
    } catch (error) {
      const changed = this.lastError !== error.message;
      this.lastError = error.message;
      if (error.code === 'MARKETPLACE_SETUP_UNVERIFIED') {
        this.blockedReason = error.message;
        this.errorCount = 0;
        if (changed) services.events?.emit('operator:alert', { component: 'marketplace-setup', reason: error.message });
      } else {
        this.blockedReason = null;
        this.errorCount++;
        if (changed) services.events?.emit('operator:alert', { component: 'poller', reason: error.message });

      }
      return {success:false,message:'Could not read Sold Orders: '+error.message};
    } finally {
      try {
      if (this.isRunning) {
        const interval = await this.setting('eldorado.poll_interval_seconds', 60);
        if(this.isRunning){
        clearTimeout(this.timeout);
        const followUp=this.pollRequested&&!this.errorCount;this.pollRequested=false;
        let delay=Math.min(600000, interval * 1000 * 2 ** Math.min(this.errorCount, 8)) * (this.errorCount ? 1 + Math.random() * 0.1 : 1);
        const due=this.repo.db.prepare("SELECT min(next_attempt_ms) due FROM delivery_orders WHERE state IN ('ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'"+(!this.errorCount?",'VALIDATED'":"")+") AND next_attempt_ms>?").get(Date.now())?.due;
        if(due)delay=Math.min(delay,Math.max(0,due-Date.now()));
        this.timeout = setTimeout(() => this.poll(), followUp?0:delay);
        this.timeout.unref?.();
        }
      }
      } finally {this.busy=false;}
    }
  }
  async prepareHybridBatch(raw) {
    const listing = await this.setting('listing.policy', {});
    const fresh = new Map(), waiting = new Map();
    const previouslyChecked = this.repo.db.prepare(`SELECT 1 FROM marketplace_observations WHERE id=?
      AND (json_type(payload,'$.orderReference.messages')='array' OR json_extract(payload,'$.routingReason') IS NOT NULL)`);
    for (const data of raw) {
      const {id, status, offerId} = this.adapter.normalizeObservation(data);
      if (!this.adapter.contract.statuses.paid.includes(status) ||
          (listing.offerId && listing.offerId !== offerId) || this.deliveryService.ownerHeld(id) || this.repo.closedStatus(id)) continue;
      const existing = this.repo.get(id);
      const needsCorrection = existing?.state === 'NEEDS_OPERATOR' &&
        existing.reason === 'Buyer changed their recipient or confirmation before payment No payment command was issued for this order.';
      if (!existing || needsCorrection) {
        const group=needsCorrection || previouslyChecked.get(id) ? waiting : fresh;
        group.set(id,{id,data,needsCorrection});
      }
    }
    const {FairBatch}=require('./fair-batch');
    this.fairRouting ||= new FairBatch();
    this.fairWaiting ||= new FairBatch();
    // API checks can overlap. inspectOrderReference itself acquires the shared
    // browser queue. Money is dispatched later, under the delivery account lock.
    // Reserve half the reads for new rooms when there is a backlog. Rotate
    // the other half through waiting buyers so late replies still get checked.
    const newSlots = Math.max(2,4-waiting.size);
    const selected = this.fairRouting.take([...fresh.values()],newSlots);
    selected.push(...this.fairWaiting.take([...waiting.values()],4-selected.length));
    const results = await Promise.all(selected.map(async ({id, data, needsCorrection}) => {
      try {
        const order = await this.adapter.prepareOrder(data);
        if (!order) return null;
        if (needsCorrection) {
          this.repo.correctUnpaidRecipient(order);
          return null;
        }
        this.observations.annotate(id, {routingReason:null});
        return order;
      } catch (error) {
        this.observations.annotate(id, {routingReason:error.message});
        services.events?.emit('operator:alert', {component:'order-routing',orderId:id,reason:error.message});
        return null;
      }
    }));
    return results.filter(Boolean);
  }
  async captureBrowserOrders() {
    if(this.adapter.hybrid)return this.captureApiOrders();
    if(this.captureTask)return this.captureTask;
    const work=this.captureBrowserOrdersObserved();this.captureTask=work;
    try{return await work;}finally{if(this.captureTask===work)this.captureTask=null;}
  }
  async captureApiOrders(){
    const taskKey='apiCapture';
    if(this[taskKey])return this[taskKey];
    const work=(async()=>{
      const policy=await this.setting('listing.policy',{}),monitor=require('./order-monitor').monitoring(this.repo.database,policy);
      const sellerHref=await this.adapter.sellerHref(),raw=await (this.adapter.listMonitoringOrders?this.adapter.listMonitoringOrders(monitor):this.adapter.listActiveOrders?this.adapter.listActiveOrders():this.adapter.listOrders()),orders=[];
      const db=this.repo.db;
      for(const data of raw){
        const order={...await this.adapter.chatOrder(null,data),...(monitor?{monitorScope:monitor.scope}:{})};orders.push(order);this.observations.observe(order);
        if(this.repo.closedStatus(order.id))continue;
        else if(order.offerId===policy.offerId&&this.adapter.contract.statuses.paid.includes(order.apiStatus)&&!this.repo.get(order.id)){
          let account=services.offerQueue?.active(order.offerId)?.account_id||null;
          if(!account&&services.offerQueue){const run=db.prepare("SELECT account_id FROM automatic_offer_runs WHERE offer_id=? AND state NOT IN ('DELETED','REJECTED')").get(order.offerId);if(run){db.prepare('INSERT INTO offer_turns(offer_id,account_id,activated_ms,completed) VALUES(?,?,?,0) ON CONFLICT(offer_id) DO UPDATE SET account_id=excluded.account_id WHERE offer_turns.account_id IS NULL').run(order.offerId,run.account_id,Date.now());account=services.offerQueue.active(order.offerId)?.account_id||null;}}
          db.prepare('INSERT INTO observed_order_holds(order_id,offer_id,account_id,status,reason,created_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET account_id=COALESCE(observed_order_holds.account_id,excluded.account_id),status=excluded.status').run(order.id,order.offerId,account,order.status,'Funded Seller API order; waiting for its buyer chat IGN',Date.now());
          if(!account)this.observations.annotate(order.id,{routingReason:'This order has no account recorded for its offer. Check the current offer account in Pairs; no payment has been sent.'});
        }else if(this.adapter.contract.statuses.paid.includes(order.apiStatus)&&order.offerId!==policy.offerId){
          this.observations.annotate(order.id,{routingReason:'This order belongs to another offer, not the offer managed by Autosell. It will not be delivered from this pair.'});
        }
      }
      if(raw.monitorState)db.prepare('UPDATE marketplace_monitoring SET scan_state=? WHERE scope=?').run(JSON.stringify(raw.monitorState.state),raw.monitorState.scope);
      if(orders.some(order=>order.offerId===policy.offerId&&order.status==='Pending delivery'))services.chatScheduler?.requestTick?.();
      return {raw,orders,sellerHref};
    })();this[taskKey]=work;
    try{return await work;}finally{this[taskKey]=null;}
  }
  async captureBrowserOrdersObserved() {
    const bridge=services.browserBridge,browser=bridge.status();
    if(!browser.connected||!['ATTACHED_PAUSED','RUNNING'].includes(browser.state)){
      const error=Error('Open your selected seller Chrome profile in Eldorado Setup to read incoming orders.');error.code='MARKETPLACE_SETUP_UNVERIFIED';throw error;
    }
    const result=await bridge.inspectOrders(),policy=await this.setting('listing.policy',{});
    result.references=[];
    if(policy.observedSellerHref&&result.sellerHref!==policy.observedSellerHref)throw Error('Sold Orders belongs to a different seller than the selected offer.');
    const db=this.repo.db,turn=services.offerQueue?.active(policy.offerId),pack=require('./browser/availability-pack.json');
    for(const order of result.orders){
      const isNew=!db.prepare('SELECT id FROM marketplace_observations WHERE id=?').get(order.id);
      this.observations.observe(order,order.source);
      const execution=this.repo.get(order.id);
      const complete=this.repo.closedStatus(order.id)||pack.nonExecutableStatuses.includes(order.status)||require('../db/repositories/delivery').terminal.has(execution?.state);
      if(complete){db.prepare('UPDATE observed_order_holds SET status=?,resolved_ms=? WHERE order_id=? AND resolved_ms IS NULL').run(order.status,Date.now(),order.id);continue;}
      if(order.status==='Pending delivery'&&order.gameLabel==='DonutSMP'&&policy.offerId&&!execution){
        const reason=`Sold Order ${order.id}: ${order.quantityDisplay}, buyer ${order.buyerName}, status ${order.status}. Detected in the real seller page. Its funded state, order recipient and selected-offer identity still need detail verification; no coins have been sent.`+(turn?.account_id?` Offer account: ${turn.account_id}.`:' No automatic offer account was assigned when this order was detected.');
        const created=db.prepare('INSERT OR IGNORE INTO observed_order_holds(order_id,offer_id,account_id,status,reason,created_ms) VALUES(?,?,?,?,?,?)').run(order.id,policy.offerId,turn?.account_id||null,order.status,reason,Date.now()).changes;
        db.prepare('UPDATE observed_order_holds SET status=? WHERE order_id=? AND resolved_ms IS NULL').run(order.status,order.id);
        if(created){services.events?.emit('operator:alert',{component:'order-detected',orderId:order.id,reason});services.listingManager?.requestSync({pauseOnly:true});}
      }
      if(isNew)services.events?.emit('marketplace:order_observed',{order});
    }
    if(result.orders.some(order=>order.status==='Pending delivery'))services.chatScheduler?.requestTick?.();
    if(typeof bridge.inspectOrderReference==='function'){
                                                                              
                                                                           
      const saved=new Map(this.observations.list().map(order=>[order.id,order]));
      const lastCapture=order=>Date.parse(saved.get(order.id)?.orderReference?.capturedAt)||0;
      const candidate=result.orders.filter(order=>order.status==='Pending delivery'&&order.orderUrl&&order.gameLabel==='DonutSMP'&&!saved.get(order.id)?.ownerDeliveryHold&&!this.repo.closedStatus(order.id)&&!this.repo.get(order.id)).sort((a,b)=>lastCapture(a)-lastCapture(b))[0];
      if(candidate){
        try{
          const reference=await bridge.inspectOrderReference(candidate);
          this.observations.recordReference(candidate,reference);
          result.references.push({order:candidate,reference});
        }catch(error){
          const reason='Order detected, but its detail/chat page could not be read: '+error.message+'. Open the order directly in Eldorado to review its chat. No payment or message was sent by this reader.';
          this.observations.observe({...candidate,orderReferenceError:reason},candidate.source);
          if(this.referenceError!==candidate.id+reason)services.events?.emit('operator:alert',{component:'order-reference',orderId:candidate.id,reason});
          this.referenceError=candidate.id+reason;
        }
      }
    }
    return result;
  }
  async processDiscoveredOrder(data, {execute = true, admit = true} = {}) {
                                                                                                             
    let order = data.browserWorkflow ? data : this.adapter.normalizeObservation ? this.adapter.normalizeObservation(data) : this.adapter.normalizeOrder ? this.adapter.normalizeOrder(data) : {
      ...data, id: String(data.id || ''), buyerIgn: data.buyerIgn ?? data.buyer_ign,
      amount: data.amount, price: data.price, status: data.status,
    };
    this.observations.observe(order);
    if (this.repo.closedStatus(order.id)) return false;
    const paid = order.browserWorkflow && services.browserFulfillment ? ['Pending delivery'] : this.adapter.contract?.statuses?.paid;
                                                                             
                                                              
    if (Array.isArray(paid) && !paid.includes(order.status) || !admit) return false;
    if (this.options.mode !== 'mock' && !Array.isArray(paid)) return false;
    const listing = await this.setting('listing.policy', {});
    if (services.offerQueue && listing.offerId !== order.offerId) return false;
    if (!order.browserWorkflow && this.adapter.normalizeOrder) order = this.adapter.normalizeOrder(data);
    const existed = this.repo.get(order.id);
    const row = this.repo.observe(order, this.options.mode === 'mock' ? 'mock' : 'live');
    if (services.offerQueue && this.options.mode !== 'mock' && !row.account_id) {
      try { services.offerQueue.assign(order.id, order.offerId); }
      catch(error) { this.repo.state(order.id,'NEEDS_OPERATOR',error.message); services.events?.emit('operator:alert',{component:'order-assignment',orderId:order.id,reason:error.message}); return false; }
    }
    if (!existed) services.events?.emit('marketplace:new_order', { order, mode: row.mode });
    if (execute && row.next_attempt_ms <= Date.now() && await this.setting('eldorado.order.auto_deliver', false) && this.deliveryService) {
                                                                                                             
      return this.deliveryService.processOrder(order, this.repo.get(order.id).account_id || undefined);
    }
    return false;
  }
}
module.exports = { OrderPoller };
