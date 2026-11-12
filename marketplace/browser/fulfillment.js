'use strict';
const crypto=require('node:crypto'),path=require('node:path');
const deliveredStatuses=new Set(['order delivered','order marked as delivered','delivered','received','order received','completed']);
                                                                          
                                                                            
class BrowserFulfillment {
  constructor(services){this.services=services;this.source='Owner-captured seller workflow (2026-10-04/05); docs/VERIFICATION-REPORT.md; https://support.eldorado.gg/en/articles/8408993-how-do-i-receive-my-order';}
  async prerequisites(){
    const s=this.services,[policy,pack,listing]=await Promise.all(['delivery.policy','delivery.patternPack','listing.policy'].map(key=>s.settings.get(key)));
    if(!pack.calibrated||!pack.paymentSource||!policy.commandCapacityObserved||!policy.source)throw Error('A matching captured server payment and exact sender debit are required');
    if(policy.orderAmountMode!=='command'||policy.unitSize!=='1000000'||policy.maxPay!=='100000000')throw Error('Use the captured million-coin units and tested 100M command size');
    if(!listing.offerId||!listing.observedSellerHref)throw Error('Select the existing offer from the correct seller profile');
    if(!s.marketplace?.hybrid&&(listing.managePrice||listing.manageQuantity))throw Error('Observed browser delivery keeps the seller’s manually configured price and quantity');
    return {policy,pack,listing};
  }
  async authorize(order,account){
    const s=this.services;await this.prerequisites();
    const browser=s.browserBridge.status();
    if(!browser.connected||!['ATTACHED_PAUSED','RUNNING'].includes(browser.state))throw Error('The selected seller browser is disconnected');
    if(s.db.raw().prepare('SELECT held FROM restore_control WHERE id=1').get()?.held)throw Error('Restored records require external reconciliation');
    const controls=await require('../../treasury/trading-controls').deliveryAllowed(account,s.settings);
    if(!controls.allowed)throw Error(controls.reason);
    if(s.offerQueue.active(order.offerId)?.account_id!==account)throw Error('The order’s account does not own this offer turn');
    if(s.deliveryService.ownerHeld(order.id))throw Error('The owner placed this order on hold');
    if(require('../order-status').stoppedStates.has(s.deliveryService.repo.get(order.id)?.state))throw Error('The marketplace order is closed; review its recorded state.');
  }
  async assertPending(order) {
    const s=this.services, repo=s.deliveryService.repo;
    let remote;
    if (order.hybridWorkflow) {
      remote=await s.marketplace.chatOrder(order.id);
      if (remote?.offerId!==order.offerId || String(remote.amount)!==String(order.amount)) throw Error('Seller API offer or amount changed');
    } else {
      const history=await s.browserBridge.inspectOrders();
      if(history.sellerHref!==order.browserBinding.sellerHref)throw Error('Seller changed during order verification');
      remote=history.orders.find(row=>row.id===order.id);
      if(!remote || require('./observed-offers').coins(remote.quantityDisplay)!==String(order.amount))throw Error('Seller history no longer matches this order');
    }
    if(remote.id!==order.id||remote.buyerName!==order.buyerMarketplaceId||remote.gameLabel!==order.browserOrder.gameLabel)throw Error('Marketplace order identity changed');
    repo.applyMarketplaceStatus(order.id,remote.status);
    if(remote.status!=='Pending delivery'||repo.closedStatus(order.id))throw Error('Marketplace order '+order.id+' is '+(repo.closedStatus(order.id)||remote.status)+'.');
  }
  async normalize(order,reference,offers){
    const {listing,policy}=await this.prerequisites();
    return require('./fulfillment-order').normalize(order,reference,offers,listing,{...policy,chat:await this.services.settings.get('eldorado.chat.local')||{}});
  }
  async getOrder(id){
    if(this.services.marketplace?.hybrid)return this.services.marketplace.getOrder(id);
    const s=this.services,history=await s.browserBridge.inspectOrders(),order=history.orders.find(row=>row.id===id);
    if(!order)throw Error('The order is no longer in the actual seller history');
    const saved=s.deliveryService.repo.get(id);
    if(saved && JSON.parse(saved.payload).browserBinding?.sellerHref!==history.sellerHref)throw Error('Seller history no longer matches the recorded seller');
    if(order.status!=='Pending delivery'){
      s.deliveryService.repo.applyMarketplaceStatus(id,order.status);
      throw Error('Marketplace order '+id+' is '+order.status+'.');
    }
    const reference=await s.browserBridge.inspectOrderReference(order),offers=await s.browserBridge.inspectOffers();
    const result=await this.normalize(order,reference,offers);
    if(!result)throw Error('The buyer IGN is missing or has conflicting corrections');
    return result;
  }
  normalizeOrder(order){if(!order.browserWorkflow)throw Error('Captured browser order required');return order;}
  async opening(order){
    const s=this.services,config=await s.settings.get('eldorado.chat.local');
    if(!config.autoSend||config.openingEnabled===false)return;
    const agent=new(require('../ai-chat-agent'))({services:s,db:s.db,repo:s.deliveryService.repo});
    const opening=await agent.sendOpeningMessage(order.id);
    if(opening.skippedKnownRecipient)return;
    s.chatScheduler.recoverObservedDrafts?.(order.id);
    const pending=s.db.raw().prepare("SELECT * FROM buyer_messages WHERE order_id=? AND direction='out' AND intent='opening' ORDER BY created_ms LIMIT 1").get(order.id);
    if(!pending)throw Error('The opening reply was not prepared; no payment was authorized');
    const guide=()=>s.gameBridge?require('../customer-messages').sendNameGuide(s,order.browserOrder,order.browserBinding.sellerHref):undefined;
    if(pending.state==='browser-confirmed-sent')return guide();
    if(s.chatScheduler.sends?.has(pending.id)){
      await s.chatScheduler.sends.get(pending.id);
      if(s.db.raw().prepare('SELECT state FROM buyer_messages WHERE id=?').get(pending.id)?.state!=='browser-confirmed-sent')throw Error('The opening reply has no confirmed receipt; no payment was authorized');
      return guide();
    }
    if(pending.state!=='draft')throw Error('The opening reply has an unknown send outcome');
    const wait=Math.max(0,pending.due_ms-Date.now());if(wait>60000)throw Error('Opening delay exceeds the bounded schedule');
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
    const current={...order.browserOrder,marketplaceStatus:order.status};
    await s.chatScheduler.sendObservedDraft(current,pending,order.browserBinding.sellerHref);
    if(s.db.raw().prepare('SELECT state FROM buyer_messages WHERE id=?').get(pending.id)?.state!=='browser-confirmed-sent')throw Error('The opening reply has no confirmed receipt; no payment was authorized');
    await guide();
  }
  async uploadEvidence(order,evidence){
    const s=this.services;
    if(!evidence.signed)throw Error('A signed captured delivery record is required');
    const pinned=crypto.createPublicKey(await s.vault.retrieve('evidence.signing.privateKey'));
    const base=path.resolve(s.evidenceRoot||path.join(process.cwd(),'data','proofs'),evidence.artifactId);
    if(!/^[a-f0-9-]{36}$/.test(evidence.artifactId)||path.resolve(evidence.directory)!==base)throw Error('Unexpected proof directory');
    const {receiptSpec,cropReceipt,forEvidenceReview}=require('../receipt-crop');
    const fs=require('node:fs');
    try {
      const manifest=require('../proof-generator').verifyPack(base,pinned);
      if (!manifest.artifacts['delivery-logs.txt']) throw Error('This older proof has no customer-safe export');
      if(s.gameBridge && !evidence.screenshotCaptured)throw Error('A real Minecraft screenshot is required for V3 delivery');
      if(evidence.screenshotCaptured) {
        if(evidence.chatImage!=='receipt-'+evidence.artifactId+'.png' ||
            evidence.screenshotName!=='delivery-'+evidence.artifactId+'.png' ||
            ![evidence.chatImage,evidence.screenshotName,'evidence.json'].every(name=>manifest.artifacts[name]))
          throw Error('A cropped receipt is required for customer privacy. The full screenshot stays private.');
        const record=JSON.parse(fs.readFileSync(path.join(base,'evidence.json'),'utf8'));
        if (record.orderId!==order.id || record.buyerIgn!==order.buyerIgn || String(record.amount)!==String(order.amount))
          throw Error('Signed payment evidence belongs to a different order or recipient');
        const verifiedCrop=cropReceipt(fs.readFileSync(path.join(base,evidence.screenshotName)),
          record.screenshot?.[0]?.receipt,receiptSpec(order,s.deliveryService.repo.chunks(order.id)));
        if (!verifiedCrop.equals(fs.readFileSync(path.join(base,evidence.chatImage))))
          throw Error('Receipt differs from the verified framebuffer crop');
      }
    } catch (error) { throw forEvidenceReview(error); }
    const authorize=()=>this.authorize(order,s.deliveryService.repo.get(order.id).account_id);
    if(evidence.screenshotCaptured){
      const uploaded=await s.browserBridge.uploadOrderEvidenceObserved(order.browserOrder,path.join(base,evidence.chatImage),order.browserBinding.sellerHref,authorize);
      await require('../customer-messages').sendStage(s,order,'proof',authorize);
      return uploaded;
    }
    return s.browserBridge.uploadOrderEvidenceObserved(order.browserOrder,path.join(base,'delivery-logs.txt'),order.browserBinding.sellerHref,authorize);
  }
  async markDelivered(id){
    const s=this.services,row=s.deliveryService.repo.get(id);
    if(!row||!['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'].includes(row.state))throw Error('All payment chunks must be verified before delivery acknowledgement');
    const order=JSON.parse(row.payload),chunks=s.deliveryService.repo.chunks(id);
    if(chunks.some(chunk=>chunk.state!=='PAY_VERIFIED')||chunks.reduce((n,chunk)=>n+BigInt(chunk.amount),0n)!==BigInt(order.amount))throw Error('Verified payment total does not equal this order');
    await this.authorize(order,row.account_id);
    await this.assertPending(order);
    const evidence=JSON.parse(row.evidence);
    await this.uploadEvidence(order,evidence);
    if(order.hybridWorkflow)return s.marketplace.acknowledgeDelivered(id);
    return s.browserBridge.markOrderDeliveredObserved(order.browserOrder,order.browserBinding.sellerHref,()=>this.authorize(order,row.account_id));
  }
}
module.exports={BrowserFulfillment,deliveredStatuses};
