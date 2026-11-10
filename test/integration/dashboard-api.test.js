'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('../../db/database');
const services = require('../../services');
const { OfferQueue } = require('../../marketplace/offer-queue');
const { SESSIONS } = require('../../api/middleware');

test('Pairs remains readable before seller offer setup', async t => {
  const db = await Database.open(':memory:'); t.after(() => db.close()); services.db = db;
  services.apiKey = 'isolated-test-owner'; services.config = {};
  services.settings = { get: async key => ({ 'listing.policy': {}, 'treasury.forwarding': {}, 'general.bot.paused': false, 'eldorado.connection': 'browser' })[key] };
  services.store = null; services.offerQueue = new OfferQueue(db); services.listingManager = null;
  services.pairManager = { getPairs: () => [{ id: 'pair_1', pairIndex: 1, buyerId: 'buyer1', sellerId: 'seller1', buyerEmail: '', sellerEmail: '', buyerIgn: '', sellerIgn: '' }] };
  const app = express(); app.use('/api/marketplace', require('../../api/routes/marketplace'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/pairs`, { headers: { 'x-api-key': services.apiKey } });
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.pairs.length, 1); assert.equal(data.pairs[0].balanceSnapshot, null); assert.deepEqual(data.queue, []);
});

test('withdrawal still requires owner authentication, CSRF and enabled sending', async t => {
  let sends = 0; services.wallet = { enabled: false, _runQueued: async fn => { sends++; return fn(); }, isValidAddress: () => true };
  services.apiKey = 'isolated-test-owner';
  const db = await Database.open(':memory:'); services.db = db; t.after(() => db.close());
  services.settings = { getSync: () => [], store: { auditLog: { log() {} } } };
  const middleware = require('../../api/middleware'); const boundary = require('../../api/security-boundary');
  const app = express(); app.use(express.json()); app.use('/api', middleware.verifyAuth, middleware.csrfProtection, boundary.sensitiveGuard);
  app.post('/api/wallet/send', middleware.requireReauth, require('../../api/owner-withdrawal'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/wallet/send`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const id = 'fixture-session'; const expires = Date.now() + 60000;
  SESSIONS.set(id, { expires, dashboardUntil: expires, csrfToken: 'fixture-csrf' }); t.after(() => SESSIONS.delete(id));
  const headers = { cookie: `sessionId=${id}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 403); assert.equal(sends, 0);
  headers['x-csrf-token'] = 'fixture-csrf';
  headers.cookie += '; csrfToken=fixture-csrf';
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ requestId: require('node:crypto').randomUUID(), toAddress: 'fixture', amountLtc: '1' }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /Wallet unavailable/); assert.equal(sends, 1);
});

test('intake setup routes require owner auth and expose working readiness and policy controls',async t=>{
  const db=await Database.open(':memory:');services.db=db;t.after(()=>db.close());services.apiKey='fixture-owner';services.sessions={clients:new Map()};services.pairManager=null;
  const values={'general.bot.paused':false,'treasury.accountRoles':{buyer1:{role:'intake',ign:'FixtureIntake'}},'delivery.patternPack':{balanceCalibrated:true},'payout.policy':{}};
  services.settings={get:async key=>values[key],getSync:()=>[],set:async(key,value)=>{values[key]=value;},store:{auditLog:{log(){}}}};
  services.store={autosellPaused:()=>false,sendEnabled:()=>false,buyMoneyEnabled:()=>true,buySkellyEnabled:()=>true};services.wallet={enabled:true,isValidAddress:()=>true};
  const app=require('../../api/server').createServer(services);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/intake/status')).status,401);
  const response=await fetch(base+'/api/intake/status',{headers:{'x-api-key':services.apiKey}});assert.equal(response.status,200);assert.equal((await response.json()).accounts[0].id,'buyer1');
  const tokens=require('../../api/middleware').CONFIRM_TOKENS;tokens.set('fixture-confirmation',{subject:'api-owner',expires:Date.now()+60000});
  const saved=await fetch(base+'/api/intake/policy',{method:'POST',headers:{'content-type':'application/json','x-api-key':services.apiKey,'x-confirm-token':'fixture-confirmation'},body:JSON.stringify({enabled:true,addressMode:'linked-seller',allowedAddresses:[],maxPerTxFiatMicros:'1000000',maxPerDayFiatMicros:'5000000'})});assert.equal(saved.status,200);assert.equal(values['payout.policy'].addressMode,'linked-seller');
  assert.equal((await fetch(base+'/intake-setup')).status,200);assert.equal((await fetch(base+'/assets/gsap.min.js')).status,200);
});

test('numeric account controls target the existing buyer session and reject unknown accounts',async t=>{
  services.apiKey='fixture-owner';services.config={collect:{tpaUsesGui:false}};
  services.pairManager=null;services.settings={getSync:()=>[]};const calls=[];
  const buyer2={isOnline:()=>true,moveSlotItem:async value=>{calls.push(['move',value.fromSlot]);return {success:true,account:'buyer2'};},chat:value=>calls.push(['chat',value]),_recordChat:()=>{}};
  services.sessions={clients:new Map([['buyer2',buyer2]]),getClient:id=>{throw Error('Unexpected new session: '+id);}};services.mcBot=null;services.buyer2Bot=buyer2;
  const middleware=require('../../api/middleware');const app=express();app.use(express.json());app.use('/api',middleware.verifyAuth,require('../../api/routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api`,headers={'content-type':'application/json','x-api-key':services.apiKey};
  for(const account of [2,'2','buyer2','buyer_2']){
    const moved=await fetch(base+'/control/bot/inventory/move',{method:'POST',headers,body:JSON.stringify({account,fromType:'inventory',fromSlot:9,toType:'inventory',toSlot:10})});assert.equal(moved.status,200,await moved.text());
    const teleported=await fetch(base+'/control/send-tpa',{method:'POST',headers,body:JSON.stringify({account,username:'FixturePlayer'})});assert.equal(teleported.status,200,await teleported.text());
  }
  assert.equal(calls.length,8);
  const unknown=await fetch(base+'/control/send-tpa',{method:'POST',headers,body:JSON.stringify({account:99,username:'FixturePlayer'})});assert.equal(unknown.status,400);assert.equal(calls.length,8);
});

test('Browser plus API setup accepts decimal price formats and names missing price fields before saving',async t=>{
  const db=await Database.open(':memory:');services.db=db;t.after(()=>db.close());services.apiKey='fixture-owner';
  const values={'eldorado.connection':'browser','listing.policy':{}};let writes=0;
  services.settings={get:async key=>values[key],set:async(key,value)=>{writes++;values[key]=value;},getSync:()=>[]};
  services.browserBridge=null;services.marketplace=null;services.marketplacePendingRestart=null;
  const middleware=require('../../api/middleware'),app=express();app.use(express.json());app.use('/api/marketplace',middleware.verifyAuth,require('../../api/routes/marketplace'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/marketplace/config`,headers={'content-type':'application/json','x-api-key':services.apiKey};
  const automatic={enabled:true,source:'direct',description:'Fixture delivery',guaranteedDeliveryTime:'Hour1',minPurchaseCoins:'100000000',undercutEnabled:false,basePrice:''};
  const failed=await fetch(url,{method:'POST',headers,body:JSON.stringify({connection:'hybrid',listing:{automatic}})});assert.equal(failed.status,400);assert.match((await failed.json()).error,/Selling price.*USD per billion/);assert.equal(writes,0);
  const saved=await fetch(url,{method:'POST',headers,body:JSON.stringify({connection:'hybrid',listing:{automatic:{...automatic,basePrice:' .01 '}}})});assert.equal(saved.status,200,await saved.text());assert.equal(values['eldorado.connection'],'hybrid');assert.equal(values['listing.policy'].automatic.basePrice,'.01');
});
