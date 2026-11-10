'use strict';
const {EldoradoOfficialAdapter}=require('./eldorado-official');
const {field}=require('../contract/runtime');
const services=require('../../services');
class EldoradoHybridAdapter extends EldoradoOfficialAdapter {
  constructor(options={}){super(options);this.hybrid=true;this.services=options.services||services;}
  status(){return {...super.status(),connection:'hybrid',chat:'Playwright browser',orders:'Seller API',offers:'Seller API'};}
  async sellerHref({allowUnbound=false}={}){
    const result=await this.invoke('getSellerIdentity');
    const href=field(result.data,this.contract.fields.sellerHref),url=new URL(href);
    if(url.origin!=='https://www.eldorado.gg'||!/^\/users\/[^/]+$/.test(url.pathname)||url.search||url.hash)throw Error('Seller API identity must map to the exact public seller profile.');
    const listing=await this.services.settings.get('listing.policy');
    if((!listing.observedSellerHref&&!allowUnbound)||(listing.observedSellerHref&&href!==listing.observedSellerHref))throw Error('Seller API credentials and selected Chrome seller must belong to the same account.');
    return href;
  }
  async chatOrder(id,data){
    const raw=data??(await this.invoke('getOrder',{id})).data;
    const order=this.normalizeObservation(raw);
    if(!order.buyerName||!order.gameLabel||!order.offerId||!order.gameId||!order.serverId||!/^\d+$/.test(String(order.amount)))throw Error('Seller API order mapping needs buyer name, game, server, offer and exact amount.');
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(order.id))throw Error('Seller API order ID is not a supported Eldorado order link.');
    order.orderUrl='https://www.eldorado.gg/order/'+order.id;
    order.apiStatus=order.status;order.status=this.contract.statuses.paid.includes(order.status)?'Pending delivery':order.status;
    return {...order,marketplaceStatus:order.status,hybridApiOrder:true,marketplaceIdCaptured:true,typeDisplay:'Currency',source:'Documented Seller API response; browser used for private chat'};
  }
  async prepareOrder(data){
    const s=this.services,order=await this.chatOrder(null,data),listing=await s.settings.get('listing.policy');
    if(!this.contract.statuses.paid.includes(order.apiStatus)||order.offerId!==listing.offerId)return null;
    if(order.gameId!==(listing.gameId||listing.apiBinding?.gameId)||order.serverId!==(listing.serverId||listing.apiBinding?.serverId||'default'))throw Error('Order is for a different configured game or server.');
    await this.sellerHref();
    const reference=await s.browserBridge.inspectOrderReference(order);
    const {coins}=require('../browser/observed-offers');
    if(reference.id!==order.id||reference.buyerName!==order.buyerName||reference.gameLabel!==order.gameLabel||coins(reference.quantityDisplay)!==String(order.amount)||reference.status!=='Pending delivery')throw Error('API order and private browser conversation disagree.');
    const intents=reference.messages.filter(row=>row.peer&&row.kind!=='attachment').map(row=>require('../chat-rules').classify(row.text).intent);
    if(intents.some(intent=>['cancel','escalation','missing'].includes(intent)))throw Error('Buyer requested cancellation or reported a delivery problem.');
    const chat=await s.settings.get('eldorado.chat.local')||{};
    const flow=require('../order-chat-flow'),recipient=flow.ownerRecipient(s,order,reference)||flow.selection(reference.messages,{...chat,amount:flow.quantityForOrder(order,reference)});
    order.quantityDisplay=reference.quantityDisplay;
    new(require('../order-observations').OrderObservations)(s.db).recordReference(order,reference);
    if(!recipient.latest||recipient.requiresClarification){new(require('../order-observations').OrderObservations)(s.db).annotate(order.id,{routingReason:recipient.requiresClarification?'Buyer chat contains different Minecraft names. Ask the buyer to confirm one IGN.':'Waiting for the buyer to send a Minecraft IGN in this order chat.'});return null;}
    if(!recipient.confirmed){new(require('../order-observations').OrderObservations)(s.db).annotate(order.id,{routingReason:'Waiting for the buyer to confirm their Minecraft IGN with Y, or reply N to correct it.'});return null;}
    const policy=await s.settings.get('delivery.policy');
    return {...order,buyerIgn:recipient.latest.ign,buyerMarketplaceId:order.buyerName,unitSize:policy.unitSize,browserWorkflow:true,hybridWorkflow:true,
      orderReference:reference,browserOrder:order,browserBinding:{sellerHref:listing.observedSellerHref,offerId:order.offerId,recipientSource:recipient.latest.messageId,scope:'API order offer/amount; matching private browser conversation'}};
  }
  async getOrder(id){
    const data=(await this.invoke('getOrder',{id})).data;
    const saved=this.services.deliveryService?.repo?.get(id);
    if(saved){
      const recorded=JSON.parse(saved.payload),fresh=await this.chatOrder(id,data);
                                                                            
                                                                            
                                                            
      if(recorded.hybridWorkflow){
        if(fresh.id!==recorded.id||fresh.buyerName!==recorded.buyerMarketplaceId||fresh.offerId!==recorded.offerId||fresh.gameId!==recorded.gameId||fresh.serverId!==recorded.serverId||String(fresh.amount)!==String(recorded.amount))throw Error('The funded API order changed after recipient confirmation; remaining payments stopped.');
        this.services.deliveryService.repo.applyMarketplaceStatus(id,fresh.status);
        return {...recorded,status:fresh.status};
      }
    }
    const result=await this.prepareOrder(data);if(!result)throw Error('This funded order still needs a clear Minecraft IGN and confirmation in its buyer chat.');return result;
  }
  async acknowledgeDelivered(id){
    const db=this.services.db.raw(),key='markDelivered:'+id,states=this.contract.statuses.delivered;
    if(!Array.isArray(states)||!states.length)throw Error('The API documentation must identify delivered order statuses before automatic acknowledgement.');
    const read=async()=>{const result=this.normalizeObservation((await this.invoke('getOrder',{id})).data);if(result.id!==id)throw Error('API returned a different order during delivery confirmation');this.services.deliveryService?.repo?.applyMarketplaceStatus(id,result.status);return result.status;};
    const prior=db.prepare('SELECT * FROM seller_api_actions WHERE id=?').get(key);
    const status=await read();
    if(states.includes(status)){
      if(!prior)throw Error('Marketplace reports delivery without a local acknowledgement action. Review the recorded order.');
      const receipt={orderId:id,status,source:'Seller API delivered status readback',capturedAt:new Date().toISOString()};
      if(prior)db.prepare("UPDATE seller_api_actions SET state='CONFIRMED',result=?,reason=NULL,updated_ms=? WHERE id=?").run(JSON.stringify(receipt),Date.now(),key);
      return receipt;
    }
    if(prior)throw Error('The previous delivered request has no confirmed result. Its status will be read again; the request and payment will not be repeated.');
    if(!this.contract.statuses.paid.includes(status))throw Error('This order is no longer awaiting delivery (API status: '+status+').');
    db.prepare("INSERT INTO seller_api_actions(id,operation,resource_id,state,created_ms,updated_ms) VALUES(?,?,?,'INTENT',?,?)").run(key,'markDelivered',id,Date.now(),Date.now());
    try{
      await super.markDelivered(id);
      const result=await read();if(!states.includes(result))throw Error('Eldorado accepted the request but has not yet shown a delivered status.');
      const receipt={orderId:id,status:result,source:'Seller API delivered status readback',capturedAt:new Date().toISOString()};
      db.prepare("UPDATE seller_api_actions SET state='CONFIRMED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(receipt),Date.now(),key);return receipt;
    }catch(error){db.prepare("UPDATE seller_api_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=?").run(error.message,Date.now(),key);throw error;}
  }
  async cancelConversation(order,reference){
    const s=this.services,db=s.db.raw(),listing=await s.settings.get('listing.policy');
    if(!await require('../../treasury/trading-controls').globallyEnabled(s.settings)||order.ownerDeliveryHold)throw Error('This order is held or Autosell is stopped');
    if(reference?.id!==order.id||!reference.messages.some(message=>message.peer===true&&require('../chat-rules').classify(message.text).intent==='cancel'))throw Error('A captured buyer cancellation request is required');
    if(db.prepare('SELECT id FROM delivery_orders WHERE id=?').get(order.id)||db.prepare('SELECT order_id FROM delivery_chunks WHERE order_id=?').get(order.id))throw Error('Delivery has already been admitted; use its recorded cancellation state');
    if(order.offerId!==listing.offerId||await this.sellerHref()!==listing.observedSellerHref)throw Error('Cancellation belongs to another offer or seller');
    const read=async()=>{const fresh=await this.chatOrder(order.id);if(fresh.id!==order.id||fresh.offerId!==order.offerId||fresh.buyerName!==order.buyerName||String(fresh.amount)!==String(order.amount))throw Error('The order changed before cancellation');return fresh;};
    const key='cancelOrder:'+order.id,prior=db.prepare('SELECT * FROM seller_api_actions WHERE id=?').get(key);
    const accept=fresh=>{
      const receipt={orderId:order.id,status:fresh.apiStatus,capturedAt:new Date().toISOString(),source:'Seller API cancellation status readback'};
      db.prepare("UPDATE seller_api_actions SET state='CONFIRMED',result=?,reason=NULL,updated_ms=? WHERE id=?").run(JSON.stringify(receipt),Date.now(),key);
      new(require('../order-observations').OrderObservations)(s.db).observe(fresh);
      db.prepare('UPDATE observed_order_holds SET status=?,resolved_ms=? WHERE order_id=?').run(fresh.apiStatus,Date.now(),order.id);return receipt;
    };
    let fresh=await read();
    if(prior&&/^cancelled$|^canceled$/i.test(fresh.apiStatus))return accept(fresh);
    if(prior)throw Error('Previous cancellation is unconfirmed; no second request or payment was sent');
    if(!this.contract.statuses.paid.includes(fresh.apiStatus))throw Error('The order is no longer awaiting delivery');
    db.prepare("INSERT INTO seller_api_actions(id,operation,resource_id,state,created_ms,updated_ms) VALUES(?,?,?,'INTENT',?,?)").run(key,'cancelOrder',order.id,Date.now(),Date.now());
    try{
      await this.cancelOrder(order.id,'Buyer explicitly requested cancellation');fresh=await read();
      if(!/^cancelled$|^canceled$/i.test(fresh.apiStatus))throw Error('Eldorado has not confirmed cancellation yet');
      return accept(fresh);
    }catch(error){db.prepare("UPDATE seller_api_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=?").run(error.message,Date.now(),key);throw error;}
  }
}
module.exports={EldoradoHybridAdapter};
