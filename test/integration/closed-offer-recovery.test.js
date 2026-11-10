'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('../../db/database');
const {HybridListings}=require('../../marketplace/hybrid-listings');
const {EldoradoSellerAdapter}=require('../../marketplace/adapters/eldorado-seller');
const controls=require('../../treasury/trading-controls');
const ID='11111111-1111-4111-8111-111111111111';
const SELLER='22222222-2222-4222-8222-222222222222';
const HREF='https://www.eldorado.gg/users/fixture-seller';

async function fixture(t){
 const database=await Database.open(':memory:');t.after(()=>database.close());
 t.mock.method(controls,'deliveryAllowed',async()=>({allowed:true}));
 t.mock.method(controls,'globallyEnabled',async()=>true);
 const state={status:'Closed',writes:[],pending:[],unresolved:[],balance:500000000n};
 const policy={offerId:ID,observedSellerHref:HREF,automatic:{enabled:false},apiBinding:{templateId:ID,sellerId:SELLER,sellerHref:HREF,gameId:'donut',serverId:'default',unitCoins:'1000000'}};
 const config={'listing.policy':policy,'general.bot.paused':false,'eldorado.order.auto_deliver':true,'eldorado.chat.local':{autoSend:true}};
 const browser={connected:true,state:'ATTACHED_PAUSED',sellerCheck:{identityMatched:true,compatible:true,sellerHref:HREF}};
 const client={id:'seller1',connected:true,receiptGeometry:1,sessionId:'game-session'};
 const pair={sellerId:'seller1',sellerIgn:'Fixture',threshold:'100000000'};
 const services={settings:{get:async key=>config[key]},db:database,browserBridge:{status:()=>browser},gameBridge:{status:()=>[client]},pairManager:{getPairs:()=>[pair]},offerQueue:{active:()=>({account_id:'seller1'}),unresolved:()=>state.unresolved},deliveryService:{repo:{get:()=>null}}};
 const adapter=new EldoradoSellerAdapter({services,mode:'live',minIntervalMs:0,transport:{request:async(url,request)=>{
  state.writes.push({url,method:request.method,body:request.body});
  if(state.dispatch)await state.dispatch();else state.status='Active';
  return {status:state.httpStatus||200,headers:{},text:async()=>''};
 }}});
 adapter.auth.credential=async()=>{if(state.beforeAuth)await state.beforeAuth();return 'fixture-only';};
 adapter.normalizeOffer=value=>value;
 const offer=()=>({id:ID,sellerId:SELLER,sellerHref:HREF,gameId:'donut',serverId:'default',unitCoins:'1000000',quantity:'200',quantityCoins:'200000000',minOrder:'100',price:0.012,currency:'USD',status:state.status,closed:state.status==='Closed',offline:state.status==='Offline',paused:state.status==='Paused',...state.changed});
 adapter.getOffer=async()=>offer();
 const manager={adapter,db:database.raw(),settings:services.settings,setting:async(key,fallback)=>config[key]??fallback,save(account,offerId,status,payload,reason){this.last={state:status,offer:offerId,reason,...payload};}};
 const listings=new HybridListings(manager);
 const stock={balance:state.balance,available:state.balance,threshold:100000000n,sessionId:'game-session',observedMs:Date.now()};
 listings.balances=async()=>({eligible:['seller1'],balances:new Map([['seller1',stock]])});
 listings.freshOrders=async()=>({orders:state.pending});
 const attempts=()=>database.raw().prepare('SELECT * FROM offer_reopen_attempts ORDER BY created_ms').all();
 return {state,policy,config,browser,client,pair,services,adapter,manager,listings,stock,offer,attempts};
}

test('funded linked Closed offer reopens once through the documented PUT and exact Active readback',async t=>{
 const f=await fixture(t);assert.equal(await f.listings.manual(f.policy),true);
 assert.equal(f.state.writes.length,1);assert.deepEqual(f.state.writes[0],{url:'https://www.eldorado.gg/api/v1/currency-management/me/offers/'+ID+'/resume',method:'PUT',body:undefined});
 assert.equal(f.attempts()[0].state,'CONFIRMED');assert(f.attempts()[0].resolved_ms);assert.equal(f.manager.last.state,'ACTIVE');
 await f.listings.manual(f.policy);assert.equal(f.state.writes.length,1);
});
test('timeout survives a new worker and only rereads until an independent Active or Paused observation',async t=>{
 const f=await fixture(t);f.state.dispatch=()=>{throw Error('Transport timed out');};
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.attempts()[0].state,'UNKNOWN');
 const restarted=new HybridListings(f.manager);restarted.balances=f.listings.balances;restarted.freshOrders=f.listings.freshOrders;
 assert.equal(await restarted.manual(f.policy),false);assert.equal(f.state.writes.length,1);assert.match(f.manager.last.reason,/only reread/);
 f.state.status='Active';assert.equal(await restarted.manual(f.policy),true);assert.equal(f.state.writes.length,1);assert(f.attempts()[0].resolved_ms);
 f.state.status='Closed';delete f.state.dispatch;assert.equal(await restarted.manual(f.policy),true);assert.equal(f.state.writes.length,2);assert.equal(f.attempts().length,2);
});
test('upstream rejection is retained without repeating a failed reopen',async t=>{
 const f=await fixture(t);f.state.httpStatus=400;f.state.dispatch=()=>{};
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.attempts()[0].state,'REJECTED');assert.equal(f.attempts()[0].http_status,400);
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,1);assert.match(f.manager.last.reason,/HTTP 400/);
});
test('unconfirmed success, Offline readback and changed identity never report Active',async t=>{
 for(const outcome of ['Closed','Offline','wrong-id'])await t.test(outcome,async t=>{
  const f=await fixture(t);f.state.dispatch=()=>{f.state.status=outcome==='wrong-id'?'Active':outcome;if(outcome==='wrong-id')f.state.changed={id:SELLER};};
  assert.equal(await f.listings.manual(f.policy),false);assert.notEqual(f.manager.last.state,'ACTIVE');assert.equal(f.state.writes.length,1);assert.equal(f.attempts()[0].state,'UNKNOWN');
 });
});
test('closed recovery does not dispatch without current browser, client, stock, or permissions',async t=>{
 const cases={browser:f=>{f.browser.connected=false;},identity:f=>{f.browser.sellerCheck.sellerHref='other';},client:f=>{f.client.connected=false;},capability:f=>{f.client.receiptGeometry=0;},session:f=>{f.client.sessionId='replacement';},stale:f=>{f.stock.observedMs=Date.now()-91000;},threshold:f=>{f.pair.threshold='600000000';},stock:f=>{f.stock.available=150000000n;},messages:f=>{f.config['eldorado.chat.local'].autoSend=false;},delivery:f=>{f.config['eldorado.order.auto_deliver']=false;},offline:f=>{f.state.status='Offline';},owner:f=>{f.state.changed={sellerId:ID};}};
 for(const [name,change]of Object.entries(cases))await t.test(name,async t=>{const f=await fixture(t);change(f);assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,0);assert.equal(f.attempts().length,0);});
});
test('a permission or client change during authentication stops the actual PUT and permits a fresh guarded retry',async t=>{
 const f=await fixture(t);f.state.beforeAuth=()=>{f.browser.connected=false;};
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,0);assert.equal(f.attempts()[0].state,'NOT_SENT');assert(f.attempts()[0].resolved_ms);
 f.browser.connected=true;delete f.state.beforeAuth;assert.equal(await f.listings.manual(f.policy),true);assert.equal(f.state.writes.length,1);
});
test('pending accepted orders reserve stock before any Closed resume',async t=>{
 const f=await fixture(t);f.state.pending=[{id:'order',offerId:ID,apiStatus:'Paid',amount:'400000000'}];
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,0);assert.equal(f.attempts().length,0);
});
test('ordinary availability reads reject another ID and Offline resume readback',async t=>{
 const f=await fixture(t);f.state.status='Paused';f.state.dispatch=()=>{f.state.status='Offline';};
 await assert.rejects(f.adapter.resumeOffer(ID),/not confirmed/);assert.equal(f.state.writes.length,1);
 f.state.changed={id:SELLER};await assert.rejects(f.adapter.pauseOffer(ID),/different ID/);assert.equal(f.state.writes.length,1);
});
test('Paused offers use the same publication readiness guard while Active offers stay unchanged',async t=>{
 const f=await fixture(t);f.state.status='Paused';f.browser.connected=false;
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,0);
 f.state.status='Active';assert.equal(await f.listings.manual(f.policy),true);assert.equal(f.state.writes.length,0);
 f.state.status='Paused';f.browser.connected=true;assert.equal(await f.listings.manual(f.policy),true);assert.equal(f.state.writes.length,1);assert.equal(f.attempts().length,0);
});
test('a crash after durable intent never issues a new PUT on worker restart',async t=>{
 const f=await fixture(t),now=Date.now();
 f.manager.db.prepare("INSERT INTO offer_reopen_attempts VALUES(?,?,?,'INTENT',?,NULL,NULL,?,?,NULL)").run('crashed',ID,'seller1',JSON.stringify(f.offer()),now,now);
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,0);assert.equal(f.attempts()[0].resolved_ms,null);
 f.state.status='Paused';assert.equal(await f.listings.manual(f.policy),true);assert(f.attempts()[0].resolved_ms);assert.equal(f.state.writes.length,1);
});
test('global off leaves a Closed offer unavailable without recording a reopen',async t=>{
 const f=await fixture(t);t.mock.method(controls,'globallyEnabled',async()=>false);
 assert.equal(await f.listings.manual(f.policy),false);assert.equal(f.state.writes.length,0);assert.equal(f.attempts().length,0);
});
