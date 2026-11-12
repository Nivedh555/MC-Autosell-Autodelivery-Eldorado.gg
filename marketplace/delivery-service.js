'use strict';
const crypto = require('node:crypto');
const services = require('../services');
const { DeliveryRepository, terminal } = require('../db/repositories/delivery');
const { VerifiedPayments, integer, validIgn, splitAmount, deliveryPolicy } = require('../minecraft/verified-payments');
const running = new Set();
const STEPS = ['policy', 'patterns', 'paused', 'lease', 'ready', 'balance', 'pay', 'cooldown', 'evidence', 'mark'];
class DeliveryService {
  constructor(sessionManager, ledger, settingsRegistry, eldoradoAdapter, options = {}) {
    this.sessionManager = sessionManager;
    this.ledger = ledger;
    this.settingsRegistry = settingsRegistry;
    this.eldoradoAdapter = eldoradoAdapter;
    this.options = options;
    this.repo = new DeliveryRepository(options.db || services.db);
    this.owner = crypto.randomUUID();
    this.dryRun = false;
    this.ownerHoldAlerts = new Map();
    this.activeOrders=new Set();this.stopping=false;
    this.context = new (require('node:async_hooks').AsyncLocalStorage)();
  }
  async _at(name, action) {
    await this.options.fault?.('before', name);
    const start = performance.now();
    try {
      const result = await action();
      services.ops?.metric(this.context.getStore(), name, performance.now() - start, 'ok');
      await this.options.fault?.('after', name);
      return result;
    } catch (error) {
      services.ops?.metric(this.context.getStore(), name, performance.now() - start, 'error');
      error.deliveryStep ||= name;
      throw error;
    }
  }
  async _get(name, key, fallback) {
    return this._at(name, async () => {
      if (!this.settingsRegistry) return fallback;
      try { return (await this.settingsRegistry.get(key)) ?? fallback; } catch { return fallback; }
    });
  }
  recover() { return this.repo.recover(); }
  async validateApiOrder(order,adapter,policy,{finalizing=false}={}) {
    const data=await adapter.getOrder(order.id);
    const observation=adapter.normalizeObservation ? adapter.normalizeObservation(data) : data;
    if(observation?.id!==order.id)throw Error('Incorrect marketplace order before delivery');
    this.repo.applyMarketplaceStatus(order.id,observation.status);
    if(this.repo.closedStatus(order.id))throw Error('Marketplace reports a closed order');
    const fresh=adapter.normalizeOrder(data);
    if(finalizing){
      if(!policy.paidStatuses?.includes(fresh.status))throw Error('Marketplace order no longer awaits delivery');
    }else this._validate(fresh,policy);
    this.repo.observe(fresh,'live');
    if(this.repo.get(order.id).state==='NEEDS_OPERATOR')throw Error('Marketplace order differs from the recorded delivery');
  }
  async processOrder(order, requestedAccountId) {
    if(this.stopping)return false;
    const work=this.context.run(order.id,()=>this._processOrder(order,requestedAccountId));this.activeOrders.add(work);
    try{return await work;}finally{this.activeOrders.delete(work);}
  }
  async stop(timeoutMs=30000){
    this.stopping=true;if(!this.activeOrders.size)return true;
    let timer;try{
      return await Promise.race([Promise.allSettled([...this.activeOrders]).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);
    }finally{clearTimeout(timer);}
  }
  async _processOrder(order, requestedAccountId) {
    if (this.ownerHeld(order.id)) return false;
    const mode = this.options.mode === 'mock' ? 'mock' : 'live';
    let row = this.repo.observe(order, mode);
    const archivedStatus=this.repo.closedStatus(order.id);
    if(archivedStatus){
      this.repo.applyMarketplaceStatus(order.id,archivedStatus);
      return this.repo.get(order.id).state==='DELIVERED';
    }
    const key = this.repo.database.dbPath + ':' + order.id;
    if (running.has(key)) return false;
    if (row.state === 'DELIVERED') return true;
    if (terminal.has(row.state)) return false;
    if (!this.repo.claim(order.id, this.owner)) return false;
    running.add(key);
    let lease, keepAlive, bot, verifier, locked = false;
    try {
      let policy = await this._at('policy', async () => this.options.policy || await this.settingsRegistry?.get('delivery.policy') || {});
      if(order.hybridWorkflow&&services.marketplace?.documentedSellerApi){
        const listing=await this.settingsRegistry.get('listing.policy'),binding=listing.apiBinding;
        if(!binding||listing.offerId!==order.offerId||binding.sellerHref!==listing.observedSellerHref||binding.gameId!==order.gameId||(binding.serverId||'default')!==order.serverId)throw Error('This delivery does not match the currently linked Seller API offer and game. No payment was sent.');
                                                                            
                                                                             
                                                                         
        policy={...policy,offerId:listing.offerId,gameId:binding.gameId,serverId:binding.serverId||'default'};
      }
      const pack = await this._at('patterns', async () => this.options.patternPack || await this.settingsRegistry?.get('delivery.patternPack') || {});
                                                                               
                                                                           
      const captureRecipientBalances = mode === 'live' || policy.captureRecipientBalances === true;
      if (await this._get('paused', 'general.bot.paused', false)) return false;
                                                                                
      this.dryRun = mode === 'mock' && this.options.dryRun === true;
      const account = row.account_id || requestedAccountId || (mode !== 'mock' && services.offerQueue ? services.offerQueue.assign(order.id,order.offerId) : policy.holderAccount);
      const completing = ['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'].includes(row.state);
      if(!completing&&this.repo.awaitingScreenshot(account,order.id)){
        this.repo.db.prepare('UPDATE delivery_orders SET next_attempt_ms=?,reason=? WHERE id=?').run(Date.now()+5000,'Waiting for the previous verified payment screenshot on this account; no new payment was sent.',order.id);
        return false;
      }
      const adapter = order.browserWorkflow ? services.browserFulfillment : this.eldoradoAdapter;
      const authorize = () => order.browserWorkflow ? adapter.authorize(order, account) : services.rollout.authorize('delivery', order, account);
      if (!completing && !(await require('../treasury/trading-controls').deliveryAllowed(account, this.settingsRegistry)).allowed) return false;
                                                                                           
      if (account && this.sessionManager && !this.dryRun && !['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'].includes(row.state)) {
        lease = await this._at('lease', () => this.sessionManager.acquire(account, 'delivery:' + order.id));
        lease.extend?.(60000);
        keepAlive = setInterval(() => lease.extend?.(60000), 15000);
        keepAlive.unref?.();
      }
      if(!completing)this._validate(order, policy);
      else {
        const paid=this.repo.chunks(order.id);
        if(!paid.length||paid.some(chunk=>chunk.state!=='PAY_VERIFIED')||paid.reduce((sum,chunk)=>sum+integer(chunk.amount),0n)!==integer(order.amount))throw Error('Completion requires the full verified payment record');
      }
      if (this.dryRun) { this.repo.state(order.id, 'DRY_RUN', 'Decisions only: no payment or marketplace write'); return false; }
      if (mode !== 'mock') {
        if (!services.rollout) throw new Error('Live rollout controller unavailable');
        await authorize();
        if(!completing && order.browserWorkflow)await adapter.assertPending(order);
        if (!completing && !order.browserWorkflow) {
          await this._at('refresh_order', () => this.validateApiOrder(order,adapter,policy));
        }
      }
      if (['RESERVED','SESSION_READY','PAY_INTENT','PAY_SENT','PAY_VERIFIED'].includes(row.state)) {
        throw new Error('Unfinished payment attempt requires operator reconciliation; no replay allowed');
      }
      if (!['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'].includes(row.state)) {
        this.repo.state(order.id, 'VALIDATED');
        if (services.listingManager) await this._at('pause_listing', () => services.listingManager.beforeDelivery(account,{order}));
        if (mode !== 'mock' && services.chatScheduler) await this._at('opening_message', () => order.browserWorkflow ? adapter.opening(order) : services.chatScheduler.ensureOpening(order.id));
        if (!lease || !account) throw new Error('No configured holder/session');
        await this._at('ready', () => lease.ready());
        bot = lease.getBot();
        this.repo.event(order.id, 'CONNECTION', require('../minecraft/connection-record').connectionRecord(bot, account, lease.getClient?.()));
        verifier = new VerifiedPayments(pack, (kind, data) => this.repo.event(order.id, kind, data), (name, fn) => this._at(name, fn));
        await verifier.exclusive(bot, async rawBot => {
          if (rawBot.transport === 'fabric' && services.gameBridge) services.gameBridge.requireReceiptClient(account);
          const before = await this._at('balance', () => verifier.readBalance(rawBot));
          if(order.hybridWorkflow&&services.listingManager)await this._at('listing_stock',()=>services.listingManager.beforeDelivery(account,{order,balance:before}));
          const taxQuote=policy.taxMode==='sender_budget'?require('../minecraft/donutsmp-tax').observedRate(this.repo.db):null;
          const chunks = splitAmount(order.amount, deliveryPolicy(policy,taxQuote?.basisPoints));
          if(taxQuote)this.repo.event(order.id,'TAX_QUOTE',{basisPoints:taxQuote.basisPoints,sourceOrderId:taxQuote.orderId,recipientAmount:chunks.reduce((sum,part)=>sum+part.command,0n).toString(),orderAmount:String(order.amount)});
          const debit = chunks.reduce((sum, c) => sum + c.debit, 0n);
          if (before < debit + integer(policy.reserve)) throw new Error('Insufficient verified holder balance after reserve');
          locked = this.repo.lock(order.id, account, this.owner, debit, before);
          if (!locked) throw new Error('Holder has an active or unresolved account lock');
          this.repo.state(order.id, 'SESSION_READY');
          let balance = before;
          if (captureRecipientBalances) await this._recipientEvidence(verifier, rawBot, order, 'before');
          for (let i = 0; i < chunks.length; i++) {
            if (this.ownerHeld(order.id)) throw new Error('Owner requested that this order must not be delivered yet.');
            if (this.repo.get(order.id).state === 'NEEDS_OPERATOR') throw new Error('Order changed or was stopped during processing');
            if (i && policy.cooldownMs > 0) await this._at('cooldown', () => new Promise(resolve => setTimeout(resolve, policy.cooldownMs)));
            const control = await require('../treasury/trading-controls').deliveryAllowed(account, this.settingsRegistry);
            if (!control.allowed) throw new Error(control.reason + '; remaining chunks stopped, reconcile before resuming');
            if (mode !== 'mock') await this._at('authorize_chunk', async () => {
              await authorize();
              if (order.browserWorkflow) {
                const fresh = await adapter.getOrder(order.id);
                this._validate(fresh, policy);
                this.repo.observe(fresh, mode);
                if (this.repo.get(order.id).state === 'NEEDS_OPERATOR') throw Error('Buyer recipient or order identity changed; remaining payments stopped');
              }
            });
            if (this.ownerHeld(order.id)) throw new Error('Owner delivery hold: no further payment will be sent.');
            if(i===0 && rawBot.transport==='fabric' && order.browserWorkflow){
              await require('./customer-messages').sendStage(services,order,'sending',authorize);
            }
            this.repo.intent(order.id, i, chunks[i], balance);
            const result = await this._at('pay', () => {
              if (this.ownerHeld(order.id)) throw new Error('Owner delivery hold: payment intent was stopped before sending.');
              return verifier.pay(rawBot, order.buyerIgn, chunks[i], balance, () => this.repo.sent(order.id, i), async () => {
                if (this.ownerHeld(order.id)) throw new Error('Owner delivery hold: no payment command was sent.');
                if(mode!=='mock'&&order.browserWorkflow)await require('./dispatch-authorization').validateRecipient(services,order,account);
                if(mode!=='mock'&&!order.browserWorkflow)await this.validateApiOrder(order,adapter,policy);
                const finalControl=await require('../treasury/trading-controls').deliveryAllowed(account,this.settingsRegistry);
                if(!finalControl.allowed||this.stopping||this.ownerHeld(order.id))throw Error('Delivery stopped before command dispatch');
                if(lease.getBot()!==bot)throw Error('Minecraft session changed before payment dispatch');
                if(this.repo.get(order.id).state!=='PAY_INTENT')throw Error('Payment intent no longer authorizes dispatch');
              });
            });
            if (!result.verified) {
              this.repo.event(order.id, 'PAY_UNCERTAIN', result);
              throw new Error(result.reason);
            }
            this.repo.verify(order.id, i, result, this.ledger, account);
            if(BigInt(result.expectedDebit||chunks[i].debit)>chunks[i].net)this.repo.event(order.id,'TAX_BUDGET_EXCEEDED',{actualDebit:result.expectedDebit,orderBudget:chunks[i].net.toString(),reason:'Server tax changed after the quote; review pricing before the next order.'});
            balance = integer(result.after);
          }
          const total = this.repo.chunks(order.id).reduce((sum, c) => sum + (c.state === 'PAY_VERIFIED' ? integer(c.amount) : 0n), 0n);
          if (total !== integer(order.amount)) throw new Error('Verified chunk total differs from order');
          if (captureRecipientBalances) await this._recipientEvidence(verifier, rawBot, order, 'after');
          if (rawBot.transport === 'fabric' && services.gameBridge) {
            try { this.repo.event(order.id, 'SCREENSHOT', await services.gameBridge.screenshot(account, order.id, order, this.repo.chunks(order.id))); }
            catch(error) { this.repo.event(order.id, 'SCREENSHOT_PENDING', {reason:error.message}); }
          }
          this.repo.transaction(() => { this.repo.state(order.id, 'ALL_VERIFIED'); this.repo.release(order.id); });
          locked = false;
        });
      }
      row = this.repo.get(order.id);
      if (!row.evidence) {
        const build = this.options.evidenceBuilder || (async data => {
          const { ProofGenerator } = require('./proof-generator');
          return new ProofGenerator(undefined, { vault: services.vault, renderPages: false }).generateDeliveryProof(data);
        });
        let screenshots = this.repo.history(order.id).filter(e => e.kind === 'SCREENSHOT').map(e => JSON.parse(e.data));
        if (mode !== 'mock' && services.gameBridge) screenshots = screenshots.filter(capture => capture.receipt?.version === 1);
        if(mode !== 'mock' && services.gameBridge && !screenshots.length) {
          try{
            const capture=await services.gameBridge.screenshot(account,order.id,order,this.repo.chunks(order.id));
            this.repo.event(order.id,'SCREENSHOT',capture);screenshots=[capture];
          }catch(error){
            this.repo.event(order.id,'SCREENSHOT_PENDING',{reason:error.message});
            const attempts=this.repo.history(order.id).filter(event=>event.kind==='SCREENSHOT_PENDING').length;
            const review=attempts>=3 || /manual evidence review required/i.test(error.message);
            const reason='Payment verified; '+(review?'manual evidence review required':'waiting for its Minecraft screenshot')+': '+error.message+'. '+(review?'Review the saved payment record.':'Only proof capture will retry.')+' No payment will be repeated.';
            this.repo.state(order.id,review?'NEEDS_OPERATOR':'ALL_VERIFIED',reason);
            if (!review) this.repo.db.prepare('UPDATE delivery_orders SET next_attempt_ms=? WHERE id=?').run(Date.now()+5000,order.id);
            if(row.reason!==reason)services.events?.emit('operator:alert',{component:'proof-capture',orderId:order.id,reason});
            return false;
          }
        }
        const chunks = this.repo.chunks(order.id);
        const connections = this.repo.history(order.id).filter(e => e.kind === 'CONNECTION').map(e => JSON.parse(e.data));
        const evidence = await this._at('evidence', () => build({
          orderId: order.id, buyerIgn: order.buyerIgn, amount: order.amount, screenshots,
          amountMeaning: policy.taxMode==='sender_budget' ? 'Funded order is the seller total debit budget; DonutSMP transfer tax is deducted from the buyer payment' : policy.orderAmountMode==='command' ? 'Exact ordered /pay command amount; no recipient-tax top-up' : 'Configured recipient amount',
          recipientNet: policy.taxMode==='sender_budget' ? chunks.reduce((sum,chunk)=>sum+BigInt(chunk.command_amount),0n).toString() : 'not captured',
          sellerIgn: bot?.username || connections.at(-1)?.holderIgn || null, state: row.state, mode,
          preBalance: chunks[0]?.before_balance ?? null, postBalance: chunks.at(-1)?.after_balance ?? null,
          chunks, history: this.repo.history(order.id),
          connection: connections,
          capturedChatLines: this.repo.history(order.id).filter(e => e.kind === 'chat').map(e => JSON.parse(e.data)),
          commands: this.repo.history(order.id).filter(e => e.kind === 'command').map(e => ({ ...JSON.parse(e.data), wallMs: e.wall_ms, monotonicNs: e.monotonic_ns })),
          transcript: this.repo.db.prepare('SELECT * FROM buyer_messages WHERE order_id=? ORDER BY created_ms,id').all(order.id),
          ledgerRows: this.ledger?.query({ referenceId: order.id }) || [],
        }));
        if (mode !== 'mock' && !evidence.signed) throw Object.assign(new Error('Owner-signed evidence required before marketplace acknowledgement'),{deliveryStep:'evidence'});
        this.repo.db.prepare('UPDATE delivery_orders SET evidence=? WHERE id=?').run(JSON.stringify(evidence), order.id);
        this.repo.state(order.id, 'EVIDENCE_BUILT');
      }
      this.repo.state(order.id, 'MARK_DELIVERED_PENDING');
      try {
        if (this.ownerHeld(order.id)) throw new Error('Owner delivery hold: marketplace acknowledgement is also stopped.');
                                                                                        
        await this._at('mark', async () => {
          if (this.ownerHeld(order.id)) throw new Error('Owner delivery hold: no delivery acknowledgement will be sent.');
          if(mode!=='mock'&&!order.browserWorkflow)await this.validateApiOrder(order,adapter,policy,{finalizing:true});
          return adapter.markDelivered(order.id);
        });
      } catch (error) {
        if (error.simulatedCrash) throw error;
        const current = this.repo.get(order.id);
        if(require('./order-status').stoppedStates.has(current.state)||current.state==='DELIVERED')return current.state==='DELIVERED';
        if (error.code === 'EVIDENCE_REVIEW') throw error;
        const delay = policy.markRetryMs * Math.min(64, 2 ** current.mark_attempts);
        const reason='Payment is already verified. Eldorado evidence/delivery acknowledgement needs attention: '+error.message+'. No payment will be repeated.';
        this.repo.db.prepare('UPDATE delivery_orders SET mark_attempts=mark_attempts+1,next_attempt_ms=?,reason=? WHERE id=?').run(Date.now() + delay, reason, order.id);
        this.repo.event(order.id,'MARK_ACK_FAILED',{reason,attempt:current.mark_attempts+1});
        services.events?.emit('operator:alert',{component:'delivery-acknowledgement',orderId:order.id,reason});
                                                                         
                                                                                 
        return false;
      }
      this.repo.state(order.id, 'DELIVERED');
      services.events?.emit('marketplace:order_delivered', { orderId: order.id, buyerIgn:order.buyerIgn, amount: order.amount, mode });
      return true;
    } catch (error) {
      if (error.simulatedCrash) throw error;
      const state=this.repo.get(order.id).state;
      if(require('./order-status').stoppedStates.has(state)||state==='DELIVERED'){
        const stopped=this.repo.get(order.id);
        if(state==='RECONCILIATION_REQUIRED')services.events?.emit('operator:alert',{component:'order-reconciliation',orderId:order.id,reason:stopped.reason});
        return state==='DELIVERED';
      }
      const chunks = this.repo.chunks(order.id);
                                                                           
                                                                              
      const reason = (error.deliveryStep ? 'Step ' + error.deliveryStep + ': ' : '') + error.message +
        (!chunks.length ? ' No payment command was issued for this order.' : '');
      this.repo.event(order.id, 'DELIVERY_FAILED', { step: error.deliveryStep || null, paymentIntentRecorded: chunks.length > 0, reason });
                                                                               
                                                                               
      const transient = !chunks.length && mode !== 'mock' && this.repo.get(order.id).state !== 'NEEDS_OPERATOR' &&
        (error.code === 'RECEIPT_CLIENT_REQUIRED' || /Holder has an active or unresolved account lock|account is checking or sending a payment|Command reply timeout|Timeout waiting for .*session|Session disconnected|net::ERR_|ECONNRESET|ETIMEDOUT|HTTP (?:429|502|503|504)/i.test(error.message));
      if(!chunks.length&&locked){this.repo.release(order.id);locked=false;}
      const fullyPaid=chunks.length&&chunks.every(chunk=>chunk.state==='PAY_VERIFIED')&&chunks.reduce((sum,chunk)=>sum+integer(chunk.amount),0n)===integer(order.amount);
      if (fullyPaid && error.code === 'EVIDENCE_REVIEW') {
        this.repo.state(order.id,'NEEDS_OPERATOR','Payment verified; manual evidence review required: '+error.message+'. No payment will be repeated.');
      } else if(fullyPaid&&this.repo.get(order.id).state!=='NEEDS_OPERATOR'&&(error.deliveryStep==='evidence'||/selected seller browser is disconnected|Minecraft client is offline|HTTP (?:429|502|503|504)|net::ERR_|ECONNRESET|ETIMEDOUT/i.test(error.message))){
        this.repo.state(order.id,this.repo.get(order.id).evidence?'EVIDENCE_BUILT':'ALL_VERIFIED','Payment verified; delivery completion will retry: '+error.message+'. No payment will be repeated.');
        this.repo.db.prepare('UPDATE delivery_orders SET next_attempt_ms=? WHERE id=?').run(Date.now()+2000,order.id);
      }else if(transient){
        this.repo.state(order.id, 'VALIDATED', reason+' Autosell will retry this pre-payment check automatically.');
        this.repo.db.prepare('UPDATE delivery_orders SET next_attempt_ms=? WHERE id=?').run(Date.now()+(error.code==='RECEIPT_CLIENT_REQUIRED'?30000:2000),order.id);
      }else this.repo.state(order.id, 'NEEDS_OPERATOR', reason);
      services.events?.emit('operator:alert', { orderId: order.id, reason:this.repo.get(order.id).reason, accountLocked: locked });
      return false;
    } finally {
      clearInterval(keepAlive);
                                                                                          
      try { lease?.release(); } catch {}
      running.delete(key);
      this.repo.unclaim(order.id, this.owner);
    }
  }
  async _recipientEvidence(verifier, bot, order, phase) {
    try {
      return await this._at('recipient_balance_' + phase, () => verifier.readRecipientBalance(bot, order.buyerIgn, {timeoutMs:Math.min(verifier.pack.timeoutMs,1500)}));
    } catch (error) {
      if (error.simulatedCrash) throw error;
                                                                              
                                                                               
                                                                          
      this.repo.event(order.id, 'RECIPIENT_BALANCE_UNAVAILABLE', { phase, recipient: order.buyerIgn, reason: error.message });
      if(phase==='before' && bot.transport==='fabric')throw error;
      return null;
    }
  }
  ownerHeld(orderId) {
    const hold=this.repo.db.prepare('SELECT reason FROM owner_delivery_holds WHERE order_id=? AND released_ms IS NULL').get(orderId);
    if(hold&&this.ownerHoldAlerts.get(orderId)!==hold.reason){
      this.ownerHoldAlerts.set(orderId,hold.reason);
      services.events?.emit('operator:alert',{component:'owner-delivery-hold',orderId,reason:hold.reason});
    }
    if(!hold)this.ownerHoldAlerts.delete(orderId);
    return Boolean(hold);
  }
  _validate(order, policy) {
    if (!(order.browserWorkflow ? policy.commandCapacityObserved === true : policy.calibrated) || !policy.source) throw new Error('UNVERIFIED delivery policy');
    if(this.options.mode!=='mock'&&policy.orderAmountMode!=='command')throw Error('Configure delivery amount as the exact ordered /pay amount; buyer receives any server-side deductions');
    if (!validIgn(order.buyerIgn, policy.bedrockPrefix)) throw new Error('Invalid buyer IGN');
    const amount = integer(order.amount);
    const unit = integer(policy.unitSize);
    if (!unit || !amount || amount > BigInt(Number.MAX_SAFE_INTEGER) || amount % unit) throw new Error('Amount is outside exact supported order/unit bounds');
    if (String(order.unitSize) !== String(policy.unitSize)) throw new Error('Order/listing unit mismatch');
    const ownOffer = this.repo.db.prepare('SELECT offer_id FROM listing_state WHERE account_id=?').get(policy.holderAccount || '')?.offer_id;
    if (![policy.offerId, ownOffer].filter(Boolean).includes(order.offerId) || order.gameId !== policy.gameId || order.serverId !== policy.serverId) throw new Error('Order does not belong to the configured offer/game/server');
    if (!Array.isArray(policy.paidStatuses) || !policy.paidStatuses.includes(order.status)) throw new Error('Order is not in a documented funded status');
    for (const key of ['cooldownMs','markRetryMs','markEscalateMs']) if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new Error('Missing policy: ' + key);
    if (order.deadlineMs && Date.now() >= order.deadlineMs) throw new Error('Delivery deadline elapsed; operator must confirm late delivery');
    splitAmount(amount, deliveryPolicy(policy, policy.taxMode==='sender_budget'?require('../minecraft/donutsmp-tax').observedRate(this.repo.db)?.basisPoints:undefined));
  }
  _splitAmount(total, maxChunk) { return splitAmount(total, { maxPay: maxChunk, taxBasisPoints: 0, taxMode: 'none' }).map(c => Number(c.net)); }
}
module.exports = { DeliveryService, STEPS };
