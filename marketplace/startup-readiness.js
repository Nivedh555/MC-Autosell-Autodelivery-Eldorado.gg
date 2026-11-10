'use strict';
const {canonical,deliveryAccount}=require('../treasury/trading-controls');
const {connectionState}=require('./connection-state');
const {reservedCoins}=require('./listing-reservations');
const FRESH_MS=90000;
const pendingChecks=new WeakMap();
const coins=value=>/^\d+$/.test(String(value))?BigInt(value):null;
const display=value=>BigInt(value).toLocaleString('en-US')+' coins';

// This is an observation of readiness, never authorization to send a payment.
// GET reads local state only. Only the explicit POST refreshes external reads.
async function startupReadiness(s,{now=Date.now()}={}) {
 const [policy,connection,paused,autoDeliver,chat]=await Promise.all(['listing.policy','eldorado.connection','general.bot.paused','eldorado.order.auto_deliver','eldorado.chat.local'].map(key=>s.settings.get(key)));
 const listing=policy||{},db=s.db.raw(),browser=s.browserBridge?.status?.()||{connected:false};
 const globalEnabled=paused===false&&!s.store?.autosellPaused?.();
 const connectionInfo=connectionState(connection,s),steps=[];
 const step=(id,label,state,detail,nextAction)=>{const value={id,label,state,detail,nextAction};steps.push(value);return value;};
 const seller=browser.sellerCheck;
 if(connectionInfo.restartRequired)step('browser','Seller browser','blocked',connectionInfo.reason,'Restart Start-Windows.cmd, then open the seller browser.');
 else if(!browser.connected)step('browser','Seller browser','blocked','The seller browser is disconnected.','Click Open seller browser, then sign in to your Eldorado account if prompted.');
 else if(!['ATTACHED_PAUSED','RUNNING'].includes(browser.state)||browser.health?.state==='COOLDOWN')step('browser','Seller browser','waiting',browser.reason||'The browser is recovering.','Finish any login prompt, then click Check startup.');
 else if(!seller?.identityMatched||!seller.compatible||listing.observedSellerHref&&seller.sellerHref!==listing.observedSellerHref)step('browser','Seller browser','blocked','Browser connected. The seller account has not been verified for this connection.','Click Check startup to verify the signed-in seller account.');
 else step('browser','Seller browser','ready','Connected and seller login verified. Offer availability is checked separately.');

 const turn=listing.offerId?s.offerQueue?.active(listing.offerId):null;
 const account=canonical(turn?.account_id||listing.holderAccount||'');
 const pair=s.pairManager?.getPairs().find(row=>deliveryAccount(row)===account);
 const client=s.gameBridge?.status?.().find(row=>row.id===account);
 const balances=account?[
  db.prepare('SELECT balance,observed_ms,0 AS net FROM balance_observations WHERE account_id=?').get(account),
  // offer_waiting is net of the configured reserve, unlike balance_observations.
  db.prepare('SELECT balance,observed_ms,1 AS net FROM offer_waiting WHERE offer_id=? AND account_id=?').get(listing.offerId||'',account),
 ].filter(Boolean).sort((a,b)=>b.observed_ms-a.observed_ms):[];
 const balanceRow=balances[0],threshold=coins(pair?.threshold),reserve=coins(listing.reserve||'0');
 let available=null;
 if(balanceRow&&coins(balanceRow.balance)!==null&&reserve!==null){
  available=coins(balanceRow.balance);
  if(!balanceRow.net)available=available>reserve?available-reserve:0n;
 }
 const lock=account&&db.prepare('SELECT order_id FROM delivery_account_locks WHERE account_id=?').get(account);
 if(!account||!pair)step('game','Minecraft and stock','blocked','No delivery pair is assigned to the linked offer.','Link your offer to a configured delivery account.');
 else if(pair.disabled)step('game','Minecraft and stock','blocked','The assigned delivery pair is switched off.','Enable this pair in AutoSell Pairs.');
 else if(!client?.connected)step('game','Minecraft and stock','blocked','The paired Minecraft client is offline.','Launch the paired Prism instance and join donutsmp.net.');
 else if(client.receiptGeometry!==1)step('game','Minecraft and stock','blocked','The connected Minecraft mod cannot capture the current receipt format.','Close Minecraft, install the bridge JAR from release, then launch the paired instance again.');
 else if(lock)step('game','Minecraft and stock','waiting','The delivery account is completing or reconciling an order.','Keep Minecraft open. Review an uncertain payment in Eldorado Orders before any manual payment.');
 else if(!balanceRow||now-balanceRow.observed_ms>FRESH_MS||now<balanceRow.observed_ms||available===null)step('game','Minecraft and stock','waiting','Minecraft is connected. Waiting for a fresh balance from the stock worker.','Keep Minecraft on donutsmp.net. The next stock check runs automatically while Global Autosell is on.');
 else if(threshold===null||available<threshold)step('game','Minecraft and stock','blocked',display(available)+' available; the pair threshold is '+(threshold===null?'not configured':display(threshold))+'.','Add stock or set the pair threshold to the amount you intend to keep available.');
 else step('game','Minecraft and stock','ready',account+' connected; '+display(available)+' available before reservations for pending orders.');

 const browserOnly=connectionInfo.activeConnection==='browser';
 const snapshot=browserOnly?s.browserBridge?.getObservedOfferSnapshot?.(listing.offerId):s.marketplace?.getOfferSnapshot?.(listing.offerId);
 const managed=s.listingManager?.status?.()||{};
 const manager=managed.offer===listing.offerId?managed:{};
 let reserveError=null;
 if(available!==null&&listing.offerId){
  try{
   const unresolved=s.offerQueue?.unresolved(listing.offerId)||[];
   const rows=db.prepare(`SELECT payload FROM marketplace_observations
     WHERE json_extract(payload,'$.offerId')=? AND coalesce(json_extract(payload,'$.apiStatus'),json_extract(payload,'$.status'))='Paid'`).all(listing.offerId);
   const paid=rows.map(row=>JSON.parse(row.payload));
   const reserved=reservedCoins(paid,unresolved,id=>{const row=s.deliveryService?.repo.get(id);return row?{state:row.state,amount:JSON.parse(row.payload).amount,chunks:s.deliveryService.repo.chunks(id)}:null;});
   available=available>reserved?available-reserved:0n;
  }catch(error){reserveError=error.message;}
 }
 const identity=snapshot&&snapshot.id===listing.offerId&&snapshot.sellerHref===listing.observedSellerHref&&(browserOnly?snapshot.gameLabel==='DonutSMP':snapshot.gameId===listing.apiBinding?.gameId&&snapshot.unitCoins===listing.apiBinding?.unitCoins);
 if(!listing.offerId&&listing.automatic?.enabled)step('offer','Eldorado offer','waiting','Waiting for the automatic offer worker.','Check automatic offer settings and the delivery pair. Enable automation when ready for the worker to create the listing.');
 else if(!listing.offerId)step('offer','Eldorado offer','blocked','No existing offer is linked.','Find your existing offers and link the one this account will deliver.');
 else if(!snapshot||snapshot.error||now-snapshot.checkedMs>FRESH_MS||now<snapshot.checkedMs)step('offer','Eldorado offer','unknown',snapshot?.error||'The offer status has not been read recently.','Click Check startup. The check reads your offer without changing it.');
 else if(!identity)step('offer','Eldorado offer','blocked','The current offer no longer matches its linked seller, game or currency units.','Check your seller account and link the correct existing offer.');
 else if(snapshot.status==='Offline')step('offer','Eldorado offer','blocked','The seller account is offline on Eldorado.','Turn off Offline mode in Eldorado Account settings, then click Check startup.');
 else if(snapshot.status==='Closed')step('offer','Eldorado offer','blocked','The linked offer is Closed on Eldorado.'+(manager.reason?' '+manager.reason:''),browserOnly?'Check this offer in Eldorado My Offers and reopen it there when stock is ready.':'With Global Autosell on, the stock worker checks whether this same offer can be reopened. If Eldorado rejects it, resume or correct that offer on Eldorado.');
 else if(snapshot.status==='Paused')step('offer','Eldorado offer','waiting',manager.reason||'The linked offer is Paused on Eldorado.','Keep Global Autosell on and Minecraft connected. The stock worker resumes the offer after its stock and account checks pass.');
 else if(snapshot.status!=='Active')step('offer','Eldorado offer','unknown','Eldorado has not confirmed an Active offer.','Click Check startup.');
 else if(reserveError)step('offer','Eldorado offer','blocked',reserveError,'Review the affected order before advertising more stock.');
 else if(available===null||coins(snapshot.quantityCoins)===null||coins(snapshot.minOrder)===null||coins(snapshot.unitCoins)===null)step('offer','Eldorado offer','waiting','Offer is Active. Waiting for verified stock and minimum purchase information.','Keep Minecraft connected and allow the next stock check to finish.');
 else if(coins(snapshot.quantityCoins)>available||coins(snapshot.quantityCoins)<coins(snapshot.minOrder)*coins(snapshot.unitCoins))step('offer','Eldorado offer','blocked','The Active offer quantity is outside the available stock or minimum purchase.','Edit this offer’s quantity on Eldorado or add stock. Autosell preserves your chosen price and quantity.');
 else step('offer','Eldorado offer','ready','Eldorado confirmed Active with '+display(snapshot.quantityCoins)+' listed.');

 if(!globalEnabled)step('automation','Automation','blocked','Global Autosell is off.','Turn on Global Autosell when your account and offer are configured.');
 else if(autoDeliver!==true)step('automation','Automation','blocked','Automatic delivery is disabled.','Enable automatic delivery in Eldorado Setup and save.');
 else if(chat?.autoSend!==true)step('automation','Automation','blocked','Automatic buyer messages are disabled.','Enable automatic buyer messages in Buyer messages.');
 else if(!s.orderPoller?.isRunning)step('automation','Automation','waiting','The order monitor is starting or stopped.','Wait for startup to finish. If it stays stopped, check Controls & Console.');
 else step('automation','Automation','ready','Global Autosell, buyer messages and incoming-order monitoring are on.');
 const first=steps.find(row=>row.state!=='ready'),ready=!first;
 return {ready,headline:ready?'Ready for incoming orders':first.detail,nextAction:ready?'Keep Autosell, the seller browser and Minecraft running. Orders are checked individually before delivery.':first.nextAction,steps,globalEnabled,generatedAt:now,offerId:listing.offerId||null,accountId:account||null};
}

function checkStartup(s){
 if(pendingChecks.has(s))return pendingChecks.get(s);
 const work=(async()=>{
  let error=null;
  try{
   if(s.marketplace?.profile&&!s.marketplace.documentedSellerApi&&s.browserBridge?.inspectOffers){
    await s.browserBridge.inspectOffers();
   }else{
    if(!s.browserBridge?.checkConnection)throw Error('Open the seller browser first.');
    const check=await s.browserBridge.checkConnection();
    if(!check.compatible||!check.identityMatched)throw Error(check.reason||'The signed-in seller account could not be verified.');
    const policy=await s.settings.get('listing.policy');
    if(policy?.offerId&&s.marketplace?.getOffer)await s.marketplace.getOffer(policy.offerId);
   }
  }catch(cause){error=cause.message;}
  const result=await startupReadiness(s);
  if(error){result.ready=false;result.headline=error;result.nextAction='Finish any seller login prompt and check the connection again. If credentials changed, restart Autosell first.';result.checkError=error;}
  return result;
 })();
 pendingChecks.set(s,work);
 work.finally(()=>{if(pendingChecks.get(s)===work)pendingChecks.delete(s);}).catch(()=>{});
 return work;
}
module.exports={startupReadiness,checkStartup,FRESH_MS};
