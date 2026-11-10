'use strict';
const {EldoradoHybridAdapter}=require('./eldorado-hybrid');
const {SellerAuth}=require('../seller-auth');
const p=require('../seller-protocol');
const BASE='/api/v1/currency-management';
const ORDERS='/api/v1/orders/me';
const routes={listOffers:['GET',BASE+'/me/offers'],getOffer:['GET',BASE+'/me/offers/{id}'],createOffer:['POST',BASE+'/me/offers'],updateOffer:['PUT',BASE+'/me/offers/{id}'],deleteOffer:['DELETE',BASE+'/me/offers/{id}'],pauseOffer:['PUT',BASE+'/me/offers/{id}/pause'],resumeOffer:['PUT',BASE+'/me/offers/{id}/resume'],changePrice:['PUT',BASE+'/me/offers/{id}/change-price'],changeQuantity:['PUT',BASE+'/me/offers/{id}/change-quantity'],listCompetitorOffers:['GET',BASE+'/offers/groups'],listOrders:['GET',ORDERS+'/seller/orders'],markDelivered:['PUT',ORDERS+'/{orderId}/deliver'],cancelOrder:['POST',ORDERS+'/{orderId}/cancel']};
const statuses={paid:['Paid'],delivered:['Delivered','Received','Completed'],terminal:['Canceled','Delivered','Received','Completed']};
                                                                              
                                                                         
class EldoradoSellerAdapter extends EldoradoHybridAdapter {
 constructor(options={}){
  super(options);this.documentedSellerApi=true;
  this.contract={source:p.source,baseUrl:'https://www.eldorado.gg',statuses};
  this.auth=new SellerAuth({baseUrl:'https://www.eldorado.gg',auth:{kind:'clientCredentials',tokenPath:'/api/authentication/seller/token',tokenPointer:'/accessToken',expiresInPointer:'/expiresIn',requestFormat:'json',body:{clientId:'clientId',clientSecret:'clientSecret'}}},this.vault,this.transport);
  this.capabilities={...this.capabilities,listOrders:true,getOrder:true,listOffers:true,getOffer:true,createOffer:true,updateOffer:true,deleteOffer:true,pauseOffer:true,resumeOffer:true,markDelivered:true,cancelOrder:true,getMessages:false,sendMessage:false};
 }
 status(){return {connection:'hybrid',source:p.source,synthetic:false,capabilities:this.capabilities,chat:'Seller browser',orders:'Seller API',offers:'Seller API',missing:{}};}
 async authenticate(){await this.auth.credential();return {credentialPresent:true,remotelyValidated:true};}
 async refreshAuth(){this.auth.token=null;return this.authenticate();}
 async prerequisites(readOnly=false){
  if(!await this.vault?.retrieve('eldorado.api.clientId')||!await this.vault?.retrieve('eldorado.api.clientSecret'))throw Error('Save your Seller API Client ID and Client secret in Eldorado Setup.');
  if(!readOnly){const listing=await this.services.settings.get('listing.policy');if(!p.bindingKey(listing.apiBinding))throw Error('Connect the seller Chrome profile and check its connection to link your Seller API account.');await this.services.browserFulfillment?.prerequisites();}
 }
 async invoke(name,input={}){
  if(name==='getOrder')return {data:await this.rawOrder(input.id)};
  const route=routes[name];if(!route)throw Error('Unsupported Seller API operation: '+name);
  const [method,template]=route,op=p.operation(template,method),read=method==='GET';
  if(['record','read-only'].includes(this.mode)&&!read)throw Error('Read-only adapter refuses marketplace changes.');
  let body=input.body;
  if(name==='cancelOrder')body={reason:input.reason,...(input.message?{message:input.message}:{})};
  p.requestBody(template,method,body);
  const url=new URL(template.replace(/\{(id|orderId)\}/g,()=>{if(!p.UUID.test(input.id))throw Error('A valid Eldorado offer or order ID is required.');return input.id;}),this.contract.baseUrl);
  for(const [key,value]of Object.entries(input.query||{})){
   const parameter=op.parameters?.find(row=>row.in==='query'&&row.name===key);if(!parameter)throw Error('Unsupported API query field: '+key);
   p.validate(value,parameter.schema,key);url.searchParams.set(key,String(value));
  }
  for(const parameter of op.parameters||[])if(parameter.in==='query'&&parameter.required&&!url.searchParams.has(parameter.name))throw Error('Required API query field: '+parameter.name);
  const execute=async()=>{
   const wait=Math.max(this.nextRequest,this.cooldownUntil||0)-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));this.nextRequest=Date.now()+(this.options.minIntervalMs??500);
                                                                               
   if(!read&&name!=='pauseOffer'){
    if(this.options.authorize)await this.options.authorize(name);
    else if(!await require('../../treasury/trading-controls').globallyEnabled(this.services.settings))throw Error('Global Autosell is off.');
   }
   let token=await this.auth.credential();
   const headers={Authorization:'Bearer '+token,swagger:'Swager request',Accept:'application/json'};
   if(body!==undefined){headers['Content-Type']='application/json';headers['Content-Length']=String(Buffer.byteLength(JSON.stringify(body)));}
   const request=async()=>{await input.beforeDispatch?.();input.onDispatch?.();return this.transport.request(url.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});};
   let response=await request();
   if(read&&response.status===401){this.auth.invalidate(token);headers.Authorization='Bearer '+await this.auth.credential();response=await request();}
   if(response.status===429)this.cooldownUntil=Date.now()+require('../retry-after').retryAfterMs(response.headers);
   if(!op.responses[String(response.status)]||response.status>=300){const reasons={400:'Eldorado rejected the request details. Check the minimum purchase, price, stock and seller offer limit.',401:'Your API credentials may have expired. Update them in Eldorado Setup.',403:'This seller account does not have permission for that API action.',404:'The offer or order is no longer present in this API seller account.',409:'Eldorado reported a conflict with an existing offer or order state.',429:'Requests are temporarily limited; the next check will retry.'};const error=Error('Eldorado could not '+({listOffers:'read offers',listOrders:'read orders',createOffer:'create the offer',deleteOffer:'remove the offer',resumeOffer:'resume the offer',pauseOffer:'pause the offer',markDelivered:'mark the order delivered',changePrice:'update the price',changeQuantity:'update the stock'}[name]||name)+' (HTTP '+response.status+'). '+(reasons[response.status]||'The marketplace is unavailable. The result will be checked before another change.'));error.status=response.status;throw error;}
                                                                  
   const text=await response.text();let data=null;
   if(text.trim()){try{data=JSON.parse(text);}catch{throw Error('Eldorado returned an unreadable '+name+' response. Its result will be checked before another change.');}}
   this.orderCache=null;return {data,headers:response.headers,status:response.status};
  };
  const task=this.tail.then(execute);this.tail=task.catch(()=>{});return task;
 }
 async pages(name,query={},body){
  const rows=[];for(let pageIndex=1;pageIndex<=1000;pageIndex++){
   const {data}=await this.invoke(name,{query:{...query,pageIndex,pageSize:50},body});
   if(!data||!Array.isArray(data.results)||!Number.isInteger(data.totalPages)||data.totalPages<0||data.totalPages>1000)throw Error('Eldorado returned an incomplete paginated offer list.');
   rows.push(...data.results);if(pageIndex>=data.totalPages)return rows;if(!data.results.length)throw Error('Offer pagination stopped before its last page.');
  }throw Error('Eldorado offer list exceeded its documented page range.');
 }
 async listOffers(){const offers=new Map();for(const offerState of ['Active','Paused','Closed','Offline'])for(const row of await this.pages('listOffers',{}, {augmentedGameFilter:{category:'Currency'},offerState}))offers.set(row.id,row);return [...offers.values()];}
 async listOrders(){
  if(this.orderTask)return this.orderTask;
  this.orderTask=this.readOrders();try{return await this.orderTask;}finally{this.orderTask=null;}
 }
 async readOrders(filter={}){
  const orders=new Map();
  for(const orderGroup of ['Regular','Historical']){
   let cursor;const seen=new Set();let complete=false;
   for(let page=0;page<1000;page++){
    const {data}=await this.invoke('listOrders',{query:{displayFilter:'DisplaySellingOrders',orderGroup,pageDirection:'Next',pageSize:50,...filter,...(cursor?{cursorValue:cursor}:{} )}});
    if(!data||!Array.isArray(data.results))throw Error('Eldorado returned an invalid Sold Orders page.');
    for(const row of data.results){if(!p.UUID.test(row.id))throw Error('Sold Orders contains a missing order ID.');const previous=orders.get(row.id);if(previous&&['offerId','buyerId','purchaseQuantity'].some(key=>previous[key]!==row[key]))throw Error('The same order returned contradictory buyer, offer or amount details.');orders.set(row.id,row);}
    cursor=data.nextPageCursor;
    if(cursor===null||cursor===''||cursor===undefined){complete=true;break;}
    if(typeof cursor!=='string'||seen.has(cursor))throw Error('Eldorado repeated its Sold Orders cursor; history is incomplete.');seen.add(cursor);
   }
   if(!complete)throw Error('Sold Orders pagination did not finish.');
  }return [...orders.values()];
 }
 async listActiveOrders(){const rows=new Map();for(const orderState of ['Paid','Disputed','PendingReview'])for(const row of await this.readOrders({orderState}))rows.set(row.id,row);
  const tracked=this.services.db?.raw().prepare("SELECT order_id id FROM observed_order_holds WHERE resolved_ms IS NULL UNION SELECT id FROM delivery_orders WHERE COALESCE(json_extract(payload,'$.kind'),'')!='transfer' AND state NOT IN ('DELIVERED','CANCELLED','EXPIRED','TRANSFERRED','DRY_RUN','MARKETPLACE_CLOSED','RECONCILIATION_REQUIRED')").all()||[];
  for(const {id}of tracked)if(p.UUID.test(id)&&!rows.has(id))rows.set(id,await this.rawOrder(id));return [...rows.values()];
 }
 async listMonitoringOrders(monitor){
  if(!monitor)throw Error('Connect and save the seller profile before monitoring new orders.');
  const rows=new Map(),state=structuredClone(monitor.scanState||{}),budget=this.options.orderPageBudget??4;
  for(const orderGroup of ['Regular','Historical']){
   const scan=state[orderGroup]||{},cutoff=Math.max(monitor.sinceMs,(scan.throughMs||0)-120000);
   let cursor=scan.cursor,latest=scan.latest||0,complete=false;const seen=new Set();
   for(let page=0;page<budget;page++){
    const {data}=await this.invoke('listOrders',{query:{displayFilter:'DisplaySellingOrders',orderGroup,isAscendingDateOrder:false,pageDirection:'Next',pageSize:50,...(cursor?{cursorValue:cursor}:{})}});
    if(!data||!Array.isArray(data.results))throw Error('Eldorado returned an invalid new-orders page.');
    let older=false,previous=Infinity;
    for(const order of data.results){
     const time=Date.parse(order.createdDate||'');
     if(!p.UUID.test(order.id)||!Number.isFinite(time))throw Error('Eldorado returned an order without a valid ID or creation date.');
     if(time>previous)throw Error('Eldorado did not return newest orders first; the monitoring cursor cannot advance.');previous=time;
     latest=Math.max(latest,time);if(time<cutoff){older=true;continue;}
     const previousOrder=rows.get(order.id);
     if(previousOrder&&['offerId','buyerId','purchaseQuantity'].some(key=>previousOrder[key]!==order[key]))throw Error('Seller API returned contradictory order identities.');
     const closed=require('../order-status').closedStatus(order.state?.state,previousOrder?.state?.state);
     if(!closed||closed===order.state?.state)rows.set(order.id,order);
    }
    const next=data.nextPageCursor;
    if(older||next===null||next===''||next===undefined){complete=true;cursor=null;break;}
    if(typeof next!=='string'||next===cursor||seen.has(next))throw Error('Eldorado repeated its new-orders cursor.');seen.add(next);cursor=next;
   }
   state[orderGroup]=complete?{throughMs:Math.max(scan.throughMs||0,latest)}:{...scan,cursor,latest};
  }
  const db=this.services.db.raw();
  const tracked=db.prepare("SELECT order_id id FROM observed_order_holds WHERE resolved_ms IS NULL UNION SELECT id FROM delivery_orders WHERE COALESCE(json_extract(payload,'$.kind'),'')!='transfer' AND state NOT IN ('DELIVERED','CANCELLED','EXPIRED','TRANSFERRED','DRY_RUN','MARKETPLACE_CLOSED','RECONCILIATION_REQUIRED') ORDER BY id").all().filter(({id})=>{
   const stored=db.prepare('SELECT payload FROM marketplace_observations WHERE id=?').get(id);
   if(!stored)return true;const order=JSON.parse(stored.payload);
   return (!order.monitorScope||order.monitorScope===monitor.scope)&&require('../order-monitor').withinMonitoring(order,monitor);
  });
                                                                           
                                                                              
  const offset=tracked.length?(state.trackedOffset||0)%tracked.length:0;
  for(let i=0;i<Math.min(tracked.length,10);i++){
   const {id}=tracked[(offset+i)%tracked.length];if(!p.UUID.test(id)||rows.has(id))continue;
   const stored=db.prepare('SELECT payload FROM marketplace_observations WHERE id=?').get(id);
   if(stored&&!require('../order-monitor').withinMonitoring(JSON.parse(stored.payload),monitor))continue;
   rows.set(id,await this.rawOrder(id));
  }
  state.trackedOffset=tracked.length?(offset+10)%tracked.length:0;
                                                                               
                                                                               
  const result=[...rows.values()];
  Object.defineProperty(result,'monitorState',{value:{scope:monitor.scope,state}});
  return result;
 }
 async rawOrder(id){
  if(!p.UUID.test(id))throw Error('Invalid order ID');
                                                                              
                                                                              
  for(const orderGroup of ['Regular','Historical']){
   let cursor;const seen=new Set();
   for(let page=0;page<4;page++){
    const {data}=await this.invoke('listOrders',{query:{displayFilter:'DisplaySellingOrders',orderGroup,pageDirection:'Next',pageSize:50,query:id,...(cursor?{cursorValue:cursor}:{})}});
    if(!data||!Array.isArray(data.results))throw Error('Eldorado returned an invalid targeted order search.');
    const matches=data.results.filter(row=>row.id===id);
    if(matches.length>1)throw Error('Targeted order search returned duplicate identities.');
    if(matches.length===1)return matches[0];
    const next=data.nextPageCursor;if(next===null||next===''||next===undefined)break;
    if(typeof next!=='string'||next===cursor||seen.has(next))throw Error('Eldorado repeated its targeted order cursor.');
    if(page===3)throw Error('Eldorado did not finish the targeted order search. No full seller-history scan was started.');
    seen.add(next);cursor=next;
   }
  }
  throw Error('This order is not present in this API seller account.');
 }
 normalizeObservation(raw){
  const details=raw.orderOfferDetails||{},pricing=details.orderPricing||{},state=raw.state?.state;
  if(!p.UUID.test(raw.id)||typeof state!=='string')throw Error('Seller API order is missing its ID or status.');
  let amount=null;const currency=details.category==='Currency';
  if(currency&&Number.isSafeInteger(raw.purchaseQuantity)&&raw.purchaseQuantity>=0&&pricing.unitSystem)amount=String(BigInt(raw.purchaseQuantity)*p.unitCoins(pricing.unitSystem));
  const listing=this.services.settings.getSync?.('listing.policy')||{};
  return {id:raw.id,offerId:raw.offerId,buyerName:raw.buyerUsername||'',buyerMarketplaceId:raw.buyerUsername||raw.buyerId||'',status:state,amount,price:raw.totalPrice?.amount,currency:raw.totalPrice?.currency,
   gameId:details.gameId,serverId:details.tradeEnvironmentId||'default',gameLabel:currency&&details.gameId===listing.apiBinding?.gameId?'DonutSMP':details.gameCategoryTitle||details.offerTitle||details.category||'Unknown game',
   quantityDisplay:amount?amount+' coins':String(raw.purchaseQuantity??''),orderedAt:raw.createdDate,unitSystem:pricing.unitSystem,isCurrency:currency,source:'Eldorado Seller API',rawApiState:state};
 }
 async chatOrder(id,data){
  const order=this.normalizeObservation(data||await this.rawOrder(id));
  return {...order,apiStatus:order.status,status:order.status==='Paid'?'Pending delivery':order.status,marketplaceStatus:order.status==='Paid'?'Pending delivery':order.status,orderUrl:'https://www.eldorado.gg/order/'+order.id,typeDisplay:order.isCurrency?'Currency':undefined,hybridApiOrder:true,marketplaceIdCaptured:true};
 }
 async prepareOrder(raw){const order=this.normalizeObservation(raw),listing=await this.services.settings.get('listing.policy');
  if(order.status!=='Paid'||order.offerId!==listing.offerId)return null;
  if(!order.isCurrency||order.gameLabel!=='DonutSMP'||!order.buyerName||!/^\d+$/.test(order.amount||'')||BigInt(order.amount)<1n)throw Error('This funded order is missing a valid currency amount or buyer identity. No payment was started.');
  return super.prepareOrder(raw);
 }
 normalizeOffer(raw){
                                                                           
                                                                             
  const flat=raw.offer||raw;
  if(p.UUID.test(flat.id)&&flat.unitSystem&&flat.pricePerUnit){
   if(flat.category!=='Currency'||flat.tradeEnvironmentValues?.length)throw Error('Only the selected currency game without an additional server selector is currently supported.');
   const unit=p.unitCoins(flat.unitSystem),template=p.dto({details:{description:flat.description,guaranteedDeliveryTime:flat.guaranteedDeliveryTime,deliveryMethod:flat.deliveryMethod,pricing:{quantity:flat.quantity,minQuantity:flat.minQuantity,pricePerUnit:flat.pricePerUnit,volumeDiscounts:flat.volumeDiscounts}},augmentedGame:{gameId:flat.gameId,category:flat.category,tradeEnvironmentId:null}});
   if(!['Active','Paused','Closed','Offline'].includes(flat.offerState)||!Number.isSafeInteger(flat.quantity)||flat.quantity<0||!Number.isSafeInteger(flat.minQuantity)||flat.minQuantity<1)throw Error('Eldorado returned an invalid offer state, stock or minimum purchase.');
   return {id:flat.id,sellerId:flat.userId,sellerHref:raw.user?.username?'https://www.eldorado.gg/users/'+encodeURIComponent(raw.user.username):undefined,gameId:flat.gameId,serverId:'default',paused:flat.offerState==='Paused',closed:flat.offerState==='Closed',offline:flat.offerState==='Offline',status:flat.offerState,quantity:String(flat.quantity),minOrder:String(flat.minQuantity),price:flat.pricePerUnit.amount,currency:flat.pricePerUnit.currency,unitCoins:String(unit),quantityCoins:String(BigInt(flat.quantity)*unit),pricePerBillion:p.fixed(p.perBillion(flat.pricePerUnit.amount,unit)),template};
  }
  const candidates=[];
  const visit=(node,id,depth=0)=>{if(!node||typeof node!=='object'||depth>5)return;if(p.UUID.test(node.id))id=node.id;if(node.details?.pricing&&node.augmentedGame)candidates.push({node,id});for(const value of Object.values(node))if(value&&typeof value==='object')visit(value,id,depth+1);};
  visit(raw);if(candidates.length!==1||!candidates[0].id)throw Error('The API offer response does not contain one identifiable currency offer. Run Find my existing offers to inspect the current API format.');
  const {node,id}=candidates[0],template=p.dto(node),pricing=template.details.pricing;
  const states=[raw.offerState,raw.state?.state,typeof raw.state==='string'?raw.state:undefined,node.offerState,node.state?.state,typeof node.state==='string'?node.state:undefined].filter(Boolean);
  const unique=[...new Set(states)];if(unique.length!==1||!['Active','Paused','Closed','Offline'].includes(unique[0]))throw Error('Eldorado returned an unknown offer availability state. No toggle was sent.');
  if(!Number.isSafeInteger(pricing.quantity)||pricing.quantity<0||!Number.isSafeInteger(pricing.minQuantity)||pricing.minQuantity<1)throw Error('The API offer has an invalid stock or minimum purchase.');
  return {id,gameId:template.augmentedGame.gameId,serverId:template.augmentedGame.tradeEnvironmentId||'default',paused:unique[0]==='Paused',closed:unique[0]==='Closed',offline:unique[0]==='Offline',status:unique[0],quantity:String(pricing.quantity),minOrder:String(pricing.minQuantity),price:pricing.pricePerUnit.amount,currency:pricing.pricePerUnit.currency,template};
 }
 async getOffer(id){
  this.offerSnapshots ||= new Map();
  try {
   const raw=(await this.invoke('getOffer',{id})).data;
   // Cached observations drive the dashboard without competing with chat for a tab.
   // Keep the original API response contract for all existing callers.
   let observation;
   try {const offer=this.normalizeOffer(raw);observation={id:offer.id,status:offer.status,sellerHref:offer.sellerHref,gameId:offer.gameId,unitCoins:offer.unitCoins,quantityCoins:offer.quantityCoins,minOrder:offer.minOrder};}
   catch {observation={id,error:'Offer details could not be verified. Check the seller connection.'};}
   this.offerSnapshots.set(id,{...observation,checkedMs:Date.now()});
   while(this.offerSnapshots.size>32)this.offerSnapshots.delete(this.offerSnapshots.keys().next().value);
   return raw;
  } catch(error) {this.offerSnapshots.set(id,{id,checkedMs:Date.now(),error:'The latest offer read failed. Run Check startup to see the connection result.'});while(this.offerSnapshots.size>32)this.offerSnapshots.delete(this.offerSnapshots.keys().next().value);throw error;}
 }
 getOfferSnapshot(id){const value=this.offerSnapshots?.get(id);return value?{...value}:null;}
 async inspectOffersForSetup(){
  const browser=await this.services.browserBridge.inspectOffers(),raw=await this.listOffers(),offers=[];
  if(raw.length){
   const owner=await this.getOffer(raw[0].id||raw[0].offer?.id),username=owner.user?.username;
   if(username&&browser.sellerHref!=='https://www.eldorado.gg/users/'+encodeURIComponent(username)){
    throw Error('These API keys belong to '+String(username).slice(0,100)+', but Chrome is signed into another seller account. Generate Seller API keys in the account open in Chrome, save them here and restart Autosell. No offer was changed.');
   }
  }
  for(const row of raw){const view=browser.offers.find(o=>o.id===(row.id||row.offer?.id));if(!view||view.gameLabel!=='DonutSMP')continue;const api=this.normalizeOffer(row);
   const quantity=BigInt(api.quantity),minimum=BigInt(api.minOrder);
   if(!/^[1-9][0-9]*$/.test(String(view.minimumCoins))||minimum<1n)throw Error('The API and browser minimum purchase disagree.');
   const minimumCoins=BigInt(view.minimumCoins);
   if(minimumCoins%minimum)throw Error('The API and browser minimum purchase disagree.');
   const unit=minimumCoins/minimum;
   const hasQuantity=view.quantityCoins!==undefined&&view.quantityCoins!==null&&view.quantityCoins!=='';
   if(hasQuantity&&!/^[0-9]+$/.test(String(view.quantityCoins)))throw Error('The browser offer quantity is invalid.');
   // Closed offers may omit the stock display. Their positive minimum and the
   // private owner response still independently verify the currency unit.
   if(!hasQuantity&&!api.closed)throw Error('The browser offer quantity is missing.');
   if(hasQuantity&&BigInt(view.quantityCoins)!==quantity*unit)throw Error('The API and browser offer units disagree.');
   const privateOffer=this.normalizeOffer(await this.getOffer(api.id));
   if(privateOffer.id!==api.id||privateOffer.sellerHref!==browser.sellerHref||privateOffer.unitCoins!==String(unit)||api.unitCoins!==String(unit)||privateOffer.gameId!==api.gameId||privateOffer.serverId!==api.serverId||privateOffer.minOrder!==api.minOrder||privateOffer.quantity!==api.quantity||privateOffer.status!==api.status||privateOffer.sellerId!==api.sellerId)throw Error('The API seller, offer or currency units differ from the selected Chrome profile. Refresh existing offers to retry.');
   offers.push({...api,quantityDisplay:view.quantityDisplay,quantityCoins:String(quantity*unit),gameLabel:view.gameLabel,sellerHref:browser.sellerHref,apiBinding:{templateId:api.id,gameId:api.gameId,serverId:api.serverId,unitCoins:String(unit),sellerHref:browser.sellerHref,sellerId:privateOffer.sellerId,template:api.template}});
  }return {offers,sellerHref:browser.sellerHref};
 }
 async apiSellerIdentity(){
  for(const orderGroup of ['Regular','Historical']){
   const {data}=await this.invoke('listOrders',{query:{displayFilter:'DisplaySellingOrders',orderGroup,pageDirection:'Next',pageSize:50}});
   if(!data||!Array.isArray(data.results))throw Error('Eldorado returned an unreadable seller account response.');
   if(!data.results.length)continue;
   const first=data.results[0];
   if(!p.UUID.test(first.sellerId)||typeof first.sellerUsername!=='string'||!first.sellerUsername.trim()||data.results.some(row=>row.sellerId!==first.sellerId||row.sellerUsername!==first.sellerUsername))throw Error('The Seller API response does not identify one seller account.');
   return {sellerId:first.sellerId,sellerHref:'https://www.eldorado.gg/users/'+encodeURIComponent(first.sellerUsername)};
  }
                                                                              
  const offers=await this.listOffers();
  if(offers.length){const offer=this.normalizeOffer(await this.getOffer(offers[0].id||offers[0].offer?.id));if(offer.sellerId&&offer.sellerHref)return {sellerId:offer.sellerId,sellerHref:offer.sellerHref};}
  throw Error('The Seller API returned neither seller order history nor an identifiable existing offer. Account identity could not be read.');
 }
 async inspectAutomaticSetup(){
  const bridge=this.services.browserBridge;
  if(!bridge?.inspectSellerIdentity)throw Error('Restart the updated Autosell to load the seller identity reader. Automatic setup does not require an existing offer.');
  const browser=await bridge.inspectSellerIdentity(),identity=await this.apiSellerIdentity();
  if(browser.sellerHref!==identity.sellerHref)throw Error('API credentials and Chrome belong to different seller accounts. Open the Chrome profile for '+decodeURIComponent(new URL(identity.sellerHref).pathname.split('/').pop())+'. No offer was changed.');
  const catalog=require('../contract/donutsmp-currency.json');
  const {data}=await this.invoke('listCompetitorOffers',{query:{gameId:catalog.gameId,category:'Currency',pageIndex:1,pageSize:1}});
  const flat=data?.results?.[0]?.offer||data?.results?.[0];
  if(!flat||flat.gameId!==catalog.gameId||flat.unitSystem!==catalog.unitSystem||flat.category!=='Currency'||flat.tradeEnvironmentValues?.length)throw Error('DonutSMP currency units could not be confirmed from Eldorado. The next connection check can retry.');
  return {sellerHref:identity.sellerHref,apiBinding:{source:'direct',key:'automatic:'+identity.sellerId+':'+catalog.gameId,...identity,gameId:catalog.gameId,serverId:catalog.serverId,unitCoins:String(p.unitCoins(flat.unitSystem))}};
 }
 async sellerHref(){const listing=await this.services.settings.get('listing.policy'),binding=listing.apiBinding;if(!p.bindingKey(binding)||binding.sellerHref!==listing.observedSellerHref)throw Error('Connect the seller Chrome profile and check its connection to link the API account.');
  if(binding.source==='direct'){const identity=await this.apiSellerIdentity();if(identity.sellerId!==binding.sellerId||identity.sellerHref!==binding.sellerHref)throw Error('API credentials no longer match the linked seller account.');return identity.sellerHref;}
  const offer=this.normalizeOffer(await this.getOffer(binding.templateId));if(offer.id!==binding.templateId||offer.gameId!==binding.gameId||offer.serverId!==binding.serverId||offer.sellerHref!==binding.sellerHref)throw Error('API credentials no longer match the selected currency offer.');return binding.sellerHref;
 }
 async confirmedAvailability(id,paused,{beforeDispatch,expectedOffer}={}){
  let offer=this.normalizeOffer(await this.getOffer(id));
  if(offer.id!==id)throw Error('The offer read returned a different ID. No availability change was sent.');
  if(expectedOffer)this.assertSameOffer(offer,expectedOffer);
  if(paused&&(offer.closed||offer.offline))return {...offer,availabilityBlocked:true};
  if(!paused&&(offer.closed||offer.offline))throw Error('This offer is closed or the seller is offline; no resume request was sent.');
  const wanted=paused?'Paused':'Active';
  if(offer.status===wanted)return offer;
  if(!['Active','Paused'].includes(offer.status))throw Error('Eldorado returned an unknown offer availability state.');
  await this.invoke(paused?'pauseOffer':'resumeOffer',{id,beforeDispatch});offer=this.normalizeOffer(await this.getOffer(id));
  if(expectedOffer)this.assertSameOffer(offer,expectedOffer);
  if(offer.id!==id||offer.status!==wanted||offer.closed||offer.offline)throw Error('Eldorado has not confirmed the requested offer '+(paused?'pause':'resume')+'. The next check will read its status again.');return offer;
 }
 assertSameOffer(offer,expected){
  for(const key of ['id','sellerHref','sellerId','gameId','serverId','unitCoins','quantity','quantityCoins','minOrder','price','currency']){
   if(offer[key]!==expected[key])throw Error('The linked offer '+key+' changed during its availability check. No replacement offer will be created.');
  }
 }
 async reopenClosedOffer(id,expected,{beforeDispatch}={}){
  let dispatched=false;
  try{
  if(expected.id!==id||expected.status!=='Closed'||typeof beforeDispatch!=='function')throw Error('Closed offer recovery requires a recorded, guarded manual offer attempt.');
  let offer=this.normalizeOffer(await this.getOffer(id));this.assertSameOffer(offer,expected);
  if(offer.status==='Active')return offer;
  if(offer.status!=='Closed'||offer.offline)throw Error('The offer is no longer Closed. Recheck its current availability before reopening.');
  await this.invoke('resumeOffer',{id,beforeDispatch,onDispatch:()=>{dispatched=true;}});
  offer=this.normalizeOffer(await this.getOffer(id));this.assertSameOffer(offer,expected);
  if(offer.status!=='Active'||offer.closed||offer.offline||offer.paused)throw Error('Eldorado has not confirmed Active after the reopen request. Autosell will only reread this offer; resume or correct it on Eldorado if it remains Closed.');
  return offer;
  }catch(error){if(!dispatched)error.requestNotSent=true;throw error;}
 }
 async pauseOffer(id){return this.confirmedAvailability(id,true);}
 async resumeOffer(id,options){return this.confirmedAvailability(id,false,options);}
 async createOffer(offer){
  let dispatched=false;
  try{return await this.invoke('createOffer',{body:p.dto(offer),onDispatch:()=>{dispatched=true;}});}
  catch(error){if(!dispatched)error.requestNotSent=true;throw error;}
 }
 async creationRecoveryOrders(sinceMs){
  const rows=await this.listMonitoringOrders({scope:'creation-recovery',sinceMs,scanState:{}});
  if(['Regular','Historical'].some(group=>rows.monitorState?.state[group]?.cursor))throw Error('More than 200 recent orders per group need review. The recovery read is incomplete, so no offer creation was reset or resubmitted.');
  return rows.filter(row=>Date.parse(row.createdDate)>=sinceMs).map(row=>{const order=this.normalizeObservation(row);return {offerId:order.offerId,apiStatus:order.status};});
 }
 async updateOffer(id,body){return this.invoke('updateOffer',{id,body:p.dto(body)});}
 async deleteOffer(id){return this.invoke('deleteOffer',{id});}
 async setStock(id,quantity){return this.invoke('changeQuantity',{id,body:Number(quantity)});}
 async setPrice(id,amount){return this.invoke('changePrice',{id,body:{amount,currency:'USD'}});}
 async cancelOrder(id,reason){return (await this.invoke('cancelOrder',{id,reason:reason==='Buyer explicitly requested cancellation'?'Buyer_Does_Not_Need_It_Anymore':reason})).data;}
 async listCompetitorOffers(input){const rows=await this.pages('listCompetitorOffers',{gameId:input.gameId,category:'Currency',...(input.serverId!=='default'?{tradeEnvironmentId:input.serverId}:{})});const binding=(await this.services.settings.get('listing.policy')).apiBinding;
  return rows.map(raw=>{const offer=this.normalizeOffer(raw);if(offer.gameId!==input.gameId||offer.serverId!==input.serverId)throw Error('Competitor results include a different game or server.');return {...offer,isOwn:offer.sellerId===binding.sellerId};});}
 async testConnection(){try{await this.authenticate();const {data}=await this.invoke('listOrders',{query:{displayFilter:'DisplaySellingOrders',orderGroup:'Regular',isAscendingDateOrder:false,pageDirection:'Next',pageSize:1}});if(!data||!Array.isArray(data.results))throw Error('Eldorado returned an invalid order response.');return {success:true,remotelyValidated:true,orders:data.results.length,scope:'Connection check only; full order history is not imported',source:p.source};}catch(error){return {success:false,error:error.message};}}
}
module.exports={EldoradoSellerAdapter,routes};
