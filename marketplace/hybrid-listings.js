'use strict';
const crypto=require('node:crypto');
const {VerifiedPayments,integer}=require('../minecraft/verified-payments');
const controls=require('../treasury/trading-controls');
const p=require('./seller-protocol');
class HybridListings {
 constructor(manager){this.m=manager;this.s=manager.adapter.services;this.a=manager.adapter;this.db=manager.db;}
 async balances(policy,key){
  const eligible=[],balances=new Map(),pack=await this.m.setting('delivery.patternPack',{});
  for(const pair of this.s.pairManager.getPairs()){
   const account=controls.deliveryAccount(pair);if(!(await controls.deliveryAllowed(account,this.m.settings)).allowed)continue;
   if(this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(account))continue;
   const sessionId=this.s.gameBridge?.status?.().find(client=>client.id===account)?.sessionId;
   let lease;try{
    lease=await this.m.sessions.acquire(account,'api-offer-stock');await lease.ready();const v=new VerifiedPayments(pack,undefined,undefined,{readOnly:true});
    const balance=await v.readIdleBalance(lease.getBot()),reserve=integer(policy.reserve||'0'),available=balance>reserve?balance-reserve:0n;
    balances.set(account,{balance,available,threshold:integer(pair.threshold),observedMs:Date.now(),sessionId});eligible.push(account);this.s.offerQueue.observe(key,account,available,pair.threshold);
   }catch(error){this.m.alert(Error('Pair #'+pair.pairIndex+' balance check: '+error.message));}
   finally{lease?.release();}
  }return {eligible,balances};
 }
 async freshOrders(){if(!this.s.orderPoller)throw Error('The order monitor is still starting. The next stock check will continue.');return this.s.orderPoller.captureApiOrders();}
 async price(policy){const config=policy.automatic;if(!config.undercutEnabled)return p.undercut([],config);
  const own=new Set((await this.a.listOffers()).map(row=>row.id||row.offer?.id));
  const rows=await this.a.listCompetitorOffers(policy.apiBinding);return p.undercut(rows,config,own);
 }
 async sync(){
  let policy=await this.m.setting('listing.policy',{});
  let run=this.db.prepare("SELECT * FROM automatic_offer_runs WHERE state NOT IN ('DELETED','REJECTED') ORDER BY created_ms LIMIT 1").get();
  if(policy.automatic?.enabled&&policy.automatic.source==='direct'&&!run&&policy.apiBinding?.source!=='direct'){
   if(policy.offerId&&p.bindingKey(policy.apiBinding)){
    await this.a.sellerHref();await this.a.pauseOffer(policy.offerId);const fresh=await this.freshOrders();
    if(fresh.orders.some(order=>order.offerId===policy.offerId&&!this.a.contract.statuses.terminal.includes(order.apiStatus))||this.s.offerQueue.unresolved(policy.offerId).length)throw Error('The previous offer has an unfinished order. It keeps its account until delivery finishes; automatic creation will continue afterwards.');
    const account=this.s.offerQueue.active(policy.offerId)?.account_id;if(account)this.s.offerQueue.release(policy.offerId,account,'Switching to automatic creation after confirmed pause');
   }
   const linked=await this.a.inspectAutomaticSetup();policy={...policy,...linked,observedSellerHref:linked.sellerHref,offerId:null};delete policy.sellerHref;
   await this.m.settings.set('listing.policy',policy,'automatic-offer-link');
  }
  if(!p.bindingKey(policy.apiBinding))throw Error('Connect the seller Chrome profile and check its connection to link the API account. Automatic offers do not need a manually created offer.');
  await this.a.sellerHref();
  if(!policy.automatic?.enabled){if(run){if(run.state==='CREATE_INTENT'){run=await this.reconcileCreate(run,policy);if(!run)return false;}return this.retire(run,policy,'Automatic offer creation was turned off.');}return this.manual(policy);}
  p.automaticSettings(policy.automatic);
  const binding=policy.apiBinding,bindingId=p.bindingKey(binding),key=bindingId+':automatic',queue=this.s.offerQueue;
  if(run&&run.template_id!==bindingId)throw Error('A previous automatic offer still exists for another seller configuration. Finish its pending orders before switching sellers.');
                                                                            
  if(binding.templateId)await this.a.pauseOffer(binding.templateId);
  if(!await controls.globallyEnabled(this.m.settings)){
   if(run?.offer_id)await this.a.pauseOffer(run.offer_id);
   this.m.last={state:'PAUSED',offer:run?.offer_id||binding.templateId,reason:'Global Autosell is off.'};return false;
  }
  const current=await this.balances(policy,key);
  await this.freshOrders();
  if(run?.state==='CREATE_INTENT'){run=await this.reconcileCreate(run,policy);if(!run)return false;}
  if(!run){
   if(policy.offerId&&queue.unresolved(policy.offerId).length)throw Error('An existing offer still has an unfinished order. It will keep its account until that order finishes.');
   const prior=queue.active(key)?.account_id,priorStock=current.balances.get(prior);
   if(prior&&(!current.eligible.includes(prior)||!priorStock||priorStock.available<priorStock.threshold))queue.release(key,prior,'Account no longer eligible before offer creation');
   const account=queue.select(key,current.eligible);if(!account){this.m.last={state:'WAITING_FOR_STOCK',offer:binding.templateId,reason:'Waiting for an enabled account to reach its threshold.'};return false;}
   const stock=current.balances.get(account);if(!stock||stock.available<stock.threshold)throw Error('The selected pair needs a fresh balance at or above its threshold.');
   p.automaticQuantities(binding,policy.automatic,stock.threshold);
   const unit=integer(binding.unitCoins),listedStock=stock.available/unit*unit;
   const template=p.automaticDraft(binding,policy.automatic,listedStock,await this.price(policy));
   const before=(await this.a.listOffers()).map(row=>row.id||row.offer?.id),id=crypto.randomUUID();
   if(!(await controls.deliveryAllowed(account,this.m.settings)).allowed)throw Error('This pair was switched off before offer creation.');
                                                                                  
   this.db.prepare("INSERT INTO automatic_offer_runs(id,template_id,account_id,state,request,before_ids,initial_coins,created_ms,updated_ms) VALUES(?,?,?,'CREATE_INTENT',?,?,?,?,?)").run(id,bindingId,account,JSON.stringify(template),JSON.stringify(before),String(listedStock),Date.now(),Date.now());
   run=this.db.prepare('SELECT * FROM automatic_offer_runs WHERE id=?').get(id);
   try{const response=await this.a.createOffer(template),createdId=p.createdOfferId(response);if(createdId){this.db.prepare('UPDATE automatic_offer_runs SET offer_id=?,updated_ms=? WHERE id=?').run(createdId,Date.now(),id);run={...run,offer_id:createdId};}}catch(error){
                                                                                        
    if(error.requestNotSent||[400,401,403,404,405,409,422,429].includes(error.status)){this.db.prepare("UPDATE automatic_offer_runs SET state='REJECTED',reason=?,updated_ms=? WHERE id=?").run(error.message,Date.now(),id);queue.release(key,account,'API rejected creation');}
    throw error;
   }
   run=await this.reconcileCreate(run,policy);if(!run)return false;
   policy=await this.m.setting('listing.policy',{});
  }
  await this.bind(run,policy);
  if(run.state==='DELETE_INTENT')return this.retire(run,policy,'Finishing previous offer deletion');
  const captured=await this.freshOrders();
  const pending=captured.orders.filter(order=>order.offerId===run.offer_id&&!this.a.contract.statuses.terminal.includes(order.apiStatus));
  if(pending.length||queue.unresolved(run.offer_id).length){await this.a.pauseOffer(run.offer_id);this.m.save(run.account_id,run.offer_id,'PAUSED',{reason:'An order is waiting for its IGN, delivery, or a payment result. Other pairs keep their queue positions.'});return false;}
  const choice=await controls.deliveryAllowed(run.account_id,this.m.settings),stock=current.balances.get(run.account_id);
  if(choice.allowed&&!stock){await this.a.pauseOffer(run.offer_id);throw Error('The active account balance could not be refreshed. Its offer is paused until the next successful balance read.');}
  let offer;
  try{offer=this.a.normalizeOffer(await this.a.getOffer(run.offer_id));}catch(error){if(error.status===404)return this.retire(run,policy,'Offer was removed remotely');throw error;}
                                                                              
                                                                                   
  const min=BigInt(JSON.parse(run.request).details.pricing.minQuantity)*integer(binding.unitCoins),remaining=stock?stock.available:0n,unit=integer(binding.unitCoins);
  if(!choice.allowed||offer.closed||remaining<min)return this.retire(run,policy,!choice.allowed?choice.reason:'Automatic offer stock is exhausted or below its minimum purchase.');
  if(!stock)throw Error('The active delivery account has no fresh balance yet.');
  const quantity=remaining/unit;
                                                                        
  if(integer(offer.quantity)!==quantity){await this.a.pauseOffer(run.offer_id);await this.a.setStock(run.offer_id,quantity);offer=this.a.normalizeOffer(await this.a.getOffer(run.offer_id));if(integer(offer.quantity)!==quantity)throw Error('Eldorado has not confirmed the updated stock yet.');}
  const price=p.priceForUnit(await this.price(policy),unit);
  if(offer.price!==price){await this.a.pauseOffer(run.offer_id);await this.a.setPrice(run.offer_id,price);offer=this.a.normalizeOffer(await this.a.getOffer(run.offer_id));if(offer.price!==price)throw Error('Eldorado has not confirmed the updated price yet.');}
  if(!(await controls.deliveryAllowed(run.account_id,this.m.settings)).allowed)throw Error('Autosell was turned off during this offer check.');
  await this.a.resumeOffer(run.offer_id);this.m.save(run.account_id,run.offer_id,'ACTIVE',{balance:String(stock.balance),available:String(stock.available),threshold:String(stock.threshold),remaining:String(remaining),pricePerBillion:p.fixed(p.perBillion(price,unit)),automatic:true});return true;
 }
 async bind(run,policy){
  const queue=this.s.offerQueue,prior=queue.active(run.offer_id);if(prior?.account_id&&prior.account_id!==run.account_id)throw Error('The automatic offer belongs to a different recorded delivery account.');
  if(!prior?.account_id)this.db.prepare('INSERT INTO offer_turns(offer_id,account_id,activated_ms,completed) VALUES(?,?,?,0) ON CONFLICT(offer_id) DO UPDATE SET account_id=excluded.account_id,activated_ms=excluded.activated_ms,completed=0').run(run.offer_id,run.account_id,Date.now());
  if(policy.offerId!==run.offer_id)await this.m.settings.set('listing.policy',{...policy,offerId:run.offer_id,gameId:policy.apiBinding.gameId,serverId:policy.apiBinding.serverId},'automatic-offer');
 }
 async reconcileCreate(run,policy,rows){
  const before=new Set(JSON.parse(run.before_ids)),requested=JSON.parse(run.request);
  let candidates=[];
  if(run.offer_id){
   try{const offer=this.a.normalizeOffer(await this.a.getOffer(run.offer_id));if(offer.id!==run.offer_id||offer.gameId!==policy.apiBinding.gameId)throw Error('The created offer ID returned a different game or offer. Check the seller connection.');candidates=[offer];}
   catch(error){if(error.status!==404)throw error;}
  }else candidates=(rows||await this.a.listOffers()).filter(row=>!before.has(row.id||row.offer?.id)).filter(row=>{const game=(row.offer||row).gameId;return !game||game===policy.apiBinding.gameId;}).map(row=>this.a.normalizeOffer(row)).filter(offer=>p.sameAutomaticOffer(offer.template,requested));
  if(candidates.length!==1){const reason=candidates.length?'Several new offers match this creation request. Check the seller offers before retrying; no duplicate was submitted.':'Autosell could not find the offer from its previous creation attempt. It will keep checking. If you deleted it, use Check and retry missing offer in Eldorado Setup; restarting alone does not reset this attempt.';this.db.prepare('UPDATE automatic_offer_runs SET reason=?,updated_ms=? WHERE id=?').run(reason,Date.now(),run.id);this.m.last={state:'CHECK_PENDING',account:run.account_id,reason};return null;}
  const id=candidates[0].id;this.db.prepare("UPDATE automatic_offer_runs SET offer_id=?,state='ACTIVE',reason=NULL,updated_ms=? WHERE id=?").run(id,Date.now(),run.id);
  run={...run,offer_id:id,state:'ACTIVE'};await this.bind(run,policy);return run;
 }
 async recoverPendingCreation(){
  const policy=await this.m.setting('listing.policy',{}),run=this.db.prepare("SELECT * FROM automatic_offer_runs WHERE state='CREATE_INTENT' ORDER BY created_ms LIMIT 1").get();
  if(!run)return {message:'No pending offer creation needs recovery.'};
  if(run.template_id!==p.bindingKey(policy.apiBinding))throw Error('Reconnect the seller configuration that owns this pending creation first.');
  await this.a.sellerHref();
  const rows=await this.a.listOffers(),adopted=await this.reconcileCreate(run,policy,rows);
  if(adopted)return {message:'Found and linked the existing offer. Its normal stock check is queued; no replacement was created.'};
  const before=new Set(JSON.parse(run.before_ids)),newOffers=rows.filter(row=>!before.has(row.id||row.offer?.id)).filter(row=>{const game=(row.offer||row).gameId;return !game||game===policy.apiBinding.gameId;}).map(row=>this.a.normalizeOffer(row)).filter(offer=>offer.gameId===policy.apiBinding.gameId);
  if(newOffers.length)throw Error('A new offer still exists in Eldorado but could not be matched to this attempt. Check its details before retrying; no new offer was submitted.');
  if(!this.a.creationRecoveryOrders)throw Error('The Seller API order check is unavailable. Restart the updated Autosell before retrying.');
  const orders=await this.a.creationRecoveryOrders(run.created_ms-120000);
  if(orders.some(order=>!before.has(order.offerId)&&!this.a.contract.statuses.terminal.includes(order.apiStatus)))throw Error('An order from a new offer still needs delivery or review. Finish it before replacing the missing offer.');
  const locked=this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(run.account_id);
  const held=this.db.prepare('SELECT 1 FROM observed_order_holds WHERE account_id=? AND resolved_ms IS NULL').get(run.account_id);
  const unresolved=this.db.prepare(`SELECT 1 FROM delivery_orders WHERE account_id=? AND ${require('./listing-reservations').reservesStockSql}`).get(run.account_id);
  if(locked||held||unresolved)throw Error('This account still has a pending delivery or transfer. Finish it before retrying offer creation.');
                                                                                
  this.db.prepare("UPDATE automatic_offer_runs SET state='REJECTED',reason=?,updated_ms=? WHERE id=? AND state='CREATE_INTENT'").run('Owner retried after the offer was absent and new orders were checked',Date.now(),run.id);
  this.s.offerQueue.release(run.template_id+':automatic',run.account_id,'Missing creation recovered');
  if(policy.offerId===run.offer_id)await this.m.settings.set('listing.policy',{...policy,offerId:policy.apiBinding.templateId||null},'automatic-offer-recovery');
  this.m.last={state:'WAITING_FOR_STOCK',account:run.account_id,reason:'Missing offer attempt cleared. A fresh balance check and offer creation are queued.'};
  return {message:this.m.last.reason};
 }
 async retire(run,policy,reason){
  try{await this.a.pauseOffer(run.offer_id);}catch(error){if(error.status!==404)throw error;}
  const fresh=await this.freshOrders();if(fresh.orders.some(order=>order.offerId===run.offer_id&&!this.a.contract.statuses.terminal.includes(order.apiStatus))||this.s.offerQueue.unresolved(run.offer_id).length)throw Error('An order arrived before offer removal. The account stays assigned until it finishes.');
  this.db.prepare("UPDATE automatic_offer_runs SET state='DELETE_INTENT',reason=?,updated_ms=? WHERE id=?").run(reason,Date.now(),run.id);
  try{await this.a.getOffer(run.offer_id);await this.a.deleteOffer(run.offer_id);}catch(error){if(error.status!==404)throw error;}
  try{await this.a.getOffer(run.offer_id);throw Error('Eldorado has not confirmed offer removal yet.');}catch(error){if(error.status!==404)throw error;}
  this.db.prepare("UPDATE automatic_offer_runs SET state='DELETED',updated_ms=? WHERE id=?").run(Date.now(),run.id);
  this.s.offerQueue.release(run.offer_id,run.account_id,reason);this.s.offerQueue.release(run.template_id+':automatic',run.account_id,reason);
  await this.m.settings.set('listing.policy',{...policy,offerId:policy.apiBinding.templateId||null},'automatic-offer');
  this.m.save(run.account_id,null,'PAUSED',null,reason);this.m.requestSync();return false;
 }
 async manual(policy){
  const queue=this.s.offerQueue,key=policy.offerId;
  if(!key)throw Error('Automatic offer creation is off. Select an existing offer in Eldorado Setup to use manual-offer mode.');
  if(!await controls.globallyEnabled(this.m.settings)){await this.a.pauseOffer(key);this.m.last={state:'PAUSED',offer:key,reason:'Global Autosell is off.'};return false;}
  const current=await this.balances(policy,key),captured=await this.freshOrders();
  const unresolved=queue.unresolved(key),pending=captured.orders.filter(order=>order.offerId===key&&this.a.contract.statuses.paid.includes(order.apiStatus));
  if(unresolved.length||pending.length){
   const account=queue.active(key)?.account_id,stock=current.balances.get(account);
   try{
    if(!account||!stock)throw Error('Waiting for a fresh balance from the assigned delivery account.');
    const reserved=require('./listing-reservations').reservedCoins(pending,unresolved,id=>{
     const row=this.s.deliveryService.repo.get(id);return row?{state:row.state,amount:JSON.parse(row.payload).amount,chunks:this.s.deliveryService.repo.chunks(id)}:null;
    });
    const offer=this.a.normalizeOffer(await this.a.getOffer(key));
    if(offer.id!==key||offer.sellerHref!==policy.observedSellerHref||offer.gameId!==policy.apiBinding.gameId||offer.unitCoins!==policy.apiBinding.unitCoins)throw Error('The offer identity or currency units changed.');
    if(offer.offline)throw Error('The seller is offline on Eldorado. Turn off Offline mode in Eldorado Account settings.');
    const available=stock.available>reserved?stock.available-reserved:0n;
    if(BigInt(offer.quantityCoins)>available||BigInt(offer.quantityCoins)<BigInt(offer.minOrder)*BigInt(offer.unitCoins))throw Error('Remaining balance cannot cover accepted orders plus the advertised stock, or the offer quantity is below its minimum purchase.');
    if(!(await controls.deliveryAllowed(account,this.m.settings)).allowed)throw Error('The delivery account was disabled during the stock check.');
    if(!await this.resumeManual(policy,account,stock,offer))return false;
    this.m.save(account,key,'ACTIVE',{balance:String(stock.balance),available:String(available),reserved:String(reserved),availabilityOnly:true,acceptingWhileDelivering:true,observedOffer:{paused:false,status:'Active'}});return true;
   }catch(error){await this.a.pauseOffer(key);this.m.last={state:'BLOCKED',offer:key,reason:error.message};return false;}
  }
  let account=queue.active(key)?.account_id;
  if(account&&(!current.balances.has(account)||current.balances.get(account).available<current.balances.get(account).threshold||queue.active(key).completed)){
   await this.a.pauseOffer(key);queue.release(key,account,'Turn completed or balance below threshold');account=null;
  }
  account=account||queue.select(key,current.eligible);
  if(!account){await this.a.pauseOffer(key);this.m.last={state:'WAITING_FOR_STOCK',offer:key,reason:'Waiting for an enabled account to reach its threshold.'};return false;}
  const stock=current.balances.get(account),offer=this.a.normalizeOffer(await this.a.getOffer(key));
  const valid=offer.id===key&&offer.sellerHref===policy.observedSellerHref&&offer.gameId===policy.apiBinding.gameId&&offer.unitCoins===policy.apiBinding.unitCoins;
  if(!valid||offer.offline||BigInt(offer.quantityCoins)>stock.available||BigInt(offer.quantityCoins)<BigInt(offer.minOrder)*BigInt(offer.unitCoins)){
   await this.a.pauseOffer(key);this.m.last={state:offer.closed?'CLOSED':offer.offline?'OFFLINE':'BLOCKED',offer:key,reason:!valid?'The linked offer identity changed.':offer.offline?'The seller is offline on Eldorado. Turn off Offline mode in Eldorado Account settings.':'Advertised stock must fit the fresh available balance and meet the minimum purchase. Edit the Eldorado quantity or add stock.'};return false;
  }
  if(!(await controls.deliveryAllowed(account,this.m.settings)).allowed)throw Error('The delivery account was disabled before offer resume.');
  if(!await this.resumeManual(policy,account,stock,offer))return false;
  this.m.save(account,key,'ACTIVE',{balance:String(stock.balance),available:String(stock.available),threshold:String(stock.threshold),availabilityOnly:true,observedOffer:{paused:false,status:'Active'}});return true;
 }
 async assertPublishReady(policy,account,stock,offer){
  if(!(await controls.deliveryAllowed(account,this.m.settings)).allowed)throw Error('Global Autosell or the delivery pair is off.');
  const latest=await this.m.setting('listing.policy',{});
  if(latest.automatic?.enabled||latest.offerId!==offer.id||latest.observedSellerHref!==policy.observedSellerHref||JSON.stringify(latest.apiBinding)!==JSON.stringify(policy.apiBinding))throw Error('The linked manual offer settings changed. Recheck the offer before reopening.');
  if(offer.id!==policy.offerId||offer.sellerHref!==policy.observedSellerHref||['sellerId','gameId','serverId','unitCoins'].some(key=>!policy.apiBinding[key]||offer[key]!==policy.apiBinding[key]))throw Error('The closed offer no longer matches its linked seller, game, server or currency units.');
  if(await this.m.setting('eldorado.order.auto_deliver',false)!==true||(await this.m.setting('eldorado.chat.local',{})).autoSend!==true)throw Error('Enable automatic delivery and buyer messages before reopening the offer.');
  const browser=this.s.browserBridge?.status?.(),seller=browser?.sellerCheck;
  if(!browser?.connected||!['ATTACHED_PAUSED','RUNNING'].includes(browser.state)||browser.health?.state==='COOLDOWN'||!seller?.compatible||!seller.identityMatched||seller.sellerHref!==policy.observedSellerHref)throw Error('Verify the connected seller browser with Check startup before reopening the offer.');
  const client=this.s.gameBridge?.status?.().find(row=>row.id===account),pair=this.s.pairManager?.getPairs().find(row=>controls.deliveryAccount(row)===account);
  if(!pair||pair.disabled||!client?.connected||client.receiptGeometry!==1||!client.sessionId||client.sessionId!==stock.sessionId)throw Error('The assigned paired Minecraft client must remain connected with the current receipt-capable bridge.');
  const age=Date.now()-stock.observedMs;
  if(!Number.isFinite(age)||age<0||age>90000||stock.available<integer(pair.threshold)||stock.threshold!==integer(pair.threshold))throw Error('Wait for a fresh balance at or above the delivery pair threshold before reopening.');
  if(this.s.offerQueue.active(offer.id)?.account_id!==account||this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(account))throw Error('The delivery account changed or is processing a payment. The next stock check will continue.');
  const pending=this.db.prepare('SELECT payload FROM marketplace_observations').all().map(row=>JSON.parse(row.payload)).filter(row=>row.offerId===offer.id&&this.a.contract.statuses.paid.includes(row.apiStatus||row.status));
  const reserved=require('./listing-reservations').reservedCoins(pending,this.s.offerQueue.unresolved(offer.id),id=>{
   const row=this.s.deliveryService.repo.get(id);return row?{state:row.state,amount:JSON.parse(row.payload).amount,chunks:this.s.deliveryService.repo.chunks(id)}:null;
  });
  if(BigInt(offer.quantityCoins)+reserved>stock.available||BigInt(offer.quantityCoins)<BigInt(offer.minOrder)*BigInt(offer.unitCoins))throw Error('Advertised stock and accepted orders exceed the fresh available balance, or stock is below the minimum purchase.');
 }
 async resumeManual(policy,account,stock,offer){
  let prior=this.db.prepare('SELECT * FROM offer_reopen_attempts WHERE offer_id=? AND resolved_ms IS NULL').get(offer.id);
  // Only an independent read of the same linked identity ends a Closed episode.
  if(prior&&['Active','Paused'].includes(offer.status)){
   const expected=JSON.parse(prior.expected_offer);
   if(['id','sellerHref','sellerId','gameId','serverId','unitCoins'].some(key=>offer[key]!==expected[key]))throw Error('The reopened offer identity changed. Review its original recovery attempt.');
   this.db.prepare('UPDATE offer_reopen_attempts SET resolved_ms=?,updated_ms=? WHERE id=? AND resolved_ms IS NULL').run(Date.now(),Date.now(),prior.id);
   prior=null;
  }
  if(!offer.closed){
   try{
    if(offer.paused)await this.assertPublishReady(policy,account,stock,offer);
    await this.a.resumeOffer(offer.id,{expectedOffer:offer,beforeDispatch:()=>this.assertPublishReady(policy,account,stock,offer)});return true;
   }catch(error){this.m.save(account,offer.id,'BLOCKED',null,error.message);return false;}
  }
  if(prior){
   const reason=(prior.reason||'A reopen request was recorded but its result is not confirmed.')+' Autosell will only reread this offer. Resume or correct the same offer on Eldorado if it remains Closed.';
   this.m.save(account,offer.id,'CLOSED',{reopenAttemptId:prior.id},reason);return false;
  }
  try{await this.assertPublishReady(policy,account,stock,offer);}catch(error){this.m.save(account,offer.id,'CLOSED',null,error.message);return false;}
  const id=crypto.randomUUID(),now=Date.now();
  this.db.prepare("INSERT INTO offer_reopen_attempts(id,offer_id,account_id,state,expected_offer,created_ms,updated_ms) VALUES(?,?,?,'INTENT',?,?,?)").run(id,offer.id,account,JSON.stringify(offer),now,now);
  try{
   await this.a.reopenClosedOffer(offer.id,offer,{beforeDispatch:()=>this.assertPublishReady(policy,account,stock,offer)});
   this.db.prepare("UPDATE offer_reopen_attempts SET state='CONFIRMED',updated_ms=?,resolved_ms=?,reason=NULL WHERE id=?").run(Date.now(),Date.now(),id);
   return true;
  }catch(error){
   if(error.requestNotSent){
    this.db.prepare("UPDATE offer_reopen_attempts SET state='NOT_SENT',reason=?,http_status=?,updated_ms=?,resolved_ms=? WHERE id=?").run(error.message,error.status||null,Date.now(),Date.now(),id);
    this.m.save(account,offer.id,'CLOSED',{reopenAttemptId:id},error.message+' No reopen request was sent. A later stock check can retry after this condition is corrected.');return false;
   }
   const rejected=Number.isInteger(error.status)&&error.status>=400&&error.status<500;
   this.db.prepare('UPDATE offer_reopen_attempts SET state=?,reason=?,http_status=?,updated_ms=? WHERE id=?').run(rejected?'REJECTED':'UNKNOWN',error.message,error.status||null,Date.now(),id);
   this.m.save(account,offer.id,'CHECK_PENDING',{reopenAttemptId:id},error.message+' No second reopen request will be sent. Autosell will reread the result; resume or correct the same offer on Eldorado if it remains Closed.');return false;
  }
 }
}
module.exports={HybridListings};
