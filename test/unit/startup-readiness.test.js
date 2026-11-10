'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Database=require('../../db/database');
const {startupReadiness,checkStartup,FRESH_MS}=require('../../marketplace/startup-readiness');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');
const {EldoradoSellerAdapter}=require('../../marketplace/adapters/eldorado-seller');
async function fixture(t){
 const database=await Database.open(':memory:');t.after(()=>database.close());
 const now=Date.now(),sellerHref='https://www.eldorado.gg/users/fixture-seller';
 const policy={offerId:'offer-1',holderAccount:'seller1',reserve:'0',observedSellerHref:sellerHref,apiBinding:{sellerHref,gameId:'game-1',unitCoins:'1000000'}};
 const values={'listing.policy':policy,'eldorado.connection':'hybrid','general.bot.paused':false,'eldorado.order.auto_deliver':true,'eldorado.chat.local':{autoSend:true}};
 const browser={connected:true,state:'ATTACHED_PAUSED',sellerCheck:{identityMatched:true,compatible:true,sellerHref}};
 const client={id:'seller1',connected:true,receiptGeometry:1};
 const offer={id:'offer-1',status:'Active',sellerHref,gameId:'game-1',unitCoins:'1000000',quantityCoins:'200000000',minOrder:'100',checkedMs:now};
 database.raw().prepare('INSERT INTO balance_observations(account_id,balance,observed_ms) VALUES(?,?,?)').run('seller1','212230418',now);
 const s={db:database,settings:{get:async key=>values[key]},store:{autosellPaused:()=>false},pairManager:{getPairs:()=>[{sellerId:'seller1',buyerId:'buyer1',sellerIgn:'FixtureSeller',threshold:'100000000'}]},gameBridge:{status:()=>[client]},browserBridge:{status:()=>browser},marketplace:{documentedSellerApi:true,getOfferSnapshot:()=>offer},listingManager:{status:()=>({})},orderPoller:{isRunning:true},offerQueue:{active:()=>null,unresolved:()=>[]}};
 return {s,now,values,policy,browser,client,offer,db:database.raw()};
}
test('attached browser can be ready; GET never invokes remote reads or trading controls',async t=>{
 const {s,now}=await fixture(t);s.marketplace.getOffer=()=>assert.fail('GET performed a remote read');s.browserBridge.checkConnection=()=>assert.fail('GET navigated browser');
 const result=await startupReadiness(s,{now});assert.equal(result.ready,true);assert.equal(result.headline,'Ready for incoming orders');assert(result.steps.every(row=>row.state==='ready'));
});
test('global enabled does not claim a Closed or Offline offer is live',async t=>{
 const {s,offer,now}=await fixture(t);
 offer.status='Closed';let result=await startupReadiness(s,{now});assert.equal(result.ready,false);assert.equal(result.globalEnabled,true);assert.match(result.headline,/Closed/);
 offer.status='Offline';result=await startupReadiness(s,{now});assert.match(result.nextAction,/Offline mode/);
});
test('connection check is coalesced and read-only even when Global Autosell is on',async t=>{
 const {s,offer,browser}=await fixture(t);let checks=0,reads=0,release;
 s.browserBridge.checkConnection=async()=>{checks++;await new Promise(resolve=>release=resolve);return {...browser.sellerCheck};};
 s.marketplace.getOffer=async()=>{reads++;offer.status='Closed';};
 s.marketplace.resumeOffer=()=>assert.fail('check resumed offer');s.listingManager.requestSync=()=>assert.fail('check started mutation worker');
 const first=checkStartup(s),second=checkStartup(s);assert.equal(first,second);release();
 assert.equal((await first).ready,false);assert.equal(checks,1);assert.equal(reads,1);
 await checkStartup({...s,browserBridge:{...s.browserBridge,checkConnection:async()=>({compatible:false,reason:'Sign in again'})}}).then(result=>assert.match(result.headline,/Sign in again/));
});
test('stale balance and offer observation cannot claim ready',async t=>{
 const {s,db,offer,now}=await fixture(t);db.prepare('UPDATE balance_observations SET observed_ms=?').run(now-FRESH_MS-1);
 let result=await startupReadiness(s,{now});assert.match(result.headline,/fresh balance/);
 db.prepare('UPDATE balance_observations SET observed_ms=?').run(now);offer.checkedMs=now-FRESH_MS-1;
 result=await startupReadiness(s,{now});assert.equal(result.steps.find(row=>row.id==='offer').state,'unknown');assert.equal(result.ready,false);
});
test('stock calculation handles reserve exactly once and preserves the advertised quantity',async t=>{
 const {s,db,policy,now,offer}=await fixture(t);policy.reserve='20000000';
 let result=await startupReadiness(s,{now});assert.equal(result.ready,false);assert.match(result.steps.find(row=>row.id==='offer').detail,/quantity/);
 db.prepare('INSERT INTO offer_waiting(offer_id,account_id,balance,observed_ms) VALUES(?,?,?,?)').run('offer-1','seller1','212230418',now+1);
 result=await startupReadiness(s,{now:now+1});assert.equal(result.ready,true);assert.equal(offer.quantityCoins,'200000000');
});
test('pending orders reserve stock; verified completed orders do not reserve it again',async t=>{
 const {s,db,now}=await fixture(t),order={id:'order-1',offerId:'offer-1',apiStatus:'Paid',amount:'100000000'};
 db.prepare('INSERT INTO marketplace_observations VALUES(?,?,?,?,?)').run(order.id,JSON.stringify(order),'fixture',now,now);
 let result=await startupReadiness(s,{now});assert.equal(result.ready,false);assert.match(result.steps.find(row=>row.id==='offer').detail,/outside the available stock/);
 s.deliveryService={repo:{get:()=>({state:'DELIVERED',payload:JSON.stringify(order)}),chunks:()=>[{state:'PAY_VERIFIED',amount:order.amount}]}};
 result=await startupReadiness(s,{now});assert.equal(result.ready,true);
});
test('changed identity, old mod, disabled chat and stopped monitor remain visible blockers',async t=>{
 const {s,browser,client,values,offer,now}=await fixture(t);
 browser.sellerCheck.sellerHref='https://www.eldorado.gg/users/other';assert.equal((await startupReadiness(s,{now})).steps[0].state,'blocked');
 browser.sellerCheck.sellerHref=offer.sellerHref;client.receiptGeometry=0;assert.match((await startupReadiness(s,{now})).headline,/mod/);
 client.receiptGeometry=1;values['eldorado.chat.local'].autoSend=false;assert.match((await startupReadiness(s,{now})).headline,/messages/);
 values['eldorado.chat.local'].autoSend=true;s.orderPoller.isRunning=false;assert.match((await startupReadiness(s,{now})).headline,/monitor/);
});
test('new browser generation or failed identity check invalidates verification',async()=>{
 let fail=false;
 const session=new PlaywrightSession({settings:{get:async()=>({offerId:'offer-1',observedSellerHref:'seller'})},marketplace:{documentedSellerApi:true,inspectOffersForSetup:async()=>{if(fail)throw Error('Different seller');return {sellerHref:'seller',offers:[{id:'offer-1'}]};}}});
 session.context={};session.page={isClosed:()=>false};session.state='ATTACHED_PAUSED';
 await session.checkConnection();assert.equal(session.status().sellerCheck.identityMatched,true);
 session.epoch++;assert.equal(session.status().sellerCheck,null);
 fail=true;await session.checkConnection();assert.equal(session.status().sellerCheck,null);
});
test('failed offer refresh invalidates a previous Active observation',async()=>{
 let fail=false;
 const adapter={invoke:async()=>{if(fail)throw Error('timeout');return {data:{status:'Active'}};},normalizeOffer:raw=>({id:'offer-1',...raw})};
 await EldoradoSellerAdapter.prototype.getOffer.call(adapter,'offer-1');assert.equal(adapter.offerSnapshots.get('offer-1').status,'Active');
 fail=true;await assert.rejects(EldoradoSellerAdapter.prototype.getOffer.call(adapter,'offer-1'));
 assert.equal(adapter.offerSnapshots.get('offer-1').status,undefined);assert.match(adapter.offerSnapshots.get('offer-1').error,/failed/);
});
test('browser-only mode reads the seller dashboard without submitting a generic API operation',async t=>{
 const {s,values,offer}=await fixture(t);values['eldorado.connection']='browser';
 let reads=0;s.marketplace={profile:{},getOffer:()=>assert.fail('unexpected generic operation')};
 s.browserBridge.inspectOffers=async()=>{reads++;};
 s.browserBridge.getObservedOfferSnapshot=()=>({...offer,gameLabel:'DonutSMP',unitCoins:'1',minOrder:'100000000'});
 assert.equal((await checkStartup(s)).ready,true);assert.equal(reads,1);
 s.browserBridge.getObservedOfferSnapshot=()=>({...offer,gameLabel:'Another game'});
 assert.equal((await startupReadiness(s)).steps.find(s=>s.id==='offer').state,'blocked');
});
