'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {retryAfterMs}=require('../../marketplace/retry-after');
const {EldoradoSellerAdapter}=require('../../marketplace/adapters/eldorado-seller');
test('Retry-After accepts seconds and dates and bounds missing or invalid delays',()=>{
 const now=Date.parse('2026-11-09T00:00:00Z');
 assert.equal(retryAfterMs({'retry-after':'2'},now),2000);
 assert.equal(retryAfterMs({'Retry-After':'Mon, 09 Nov 2026 00:00:10 GMT'},now),10000);
 assert.equal(retryAfterMs({},now),30000);assert.equal(retryAfterMs({'retry-after':'invalid'},now),30000);
 assert.equal(retryAfterMs({'retry-after':'999999'},now),300000);
});
test('closed or offline offers are already unavailable and do not trigger failing pause mutations',async()=>{
 const adapter=new EldoradoSellerAdapter({services:{}});let state={id:'offer',status:'Closed',closed:true,offline:false,paused:false},writes=0;
 adapter.getOffer=async()=>state;adapter.normalizeOffer=x=>x;adapter.invoke=async()=>writes++;
 assert.equal((await adapter.pauseOffer('offer')).availabilityBlocked,true);assert.equal(writes,0);
 await assert.rejects(adapter.resumeOffer('offer'),/closed or the seller is offline/);assert.equal(writes,0);
 state={id:'offer',status:'Offline',closed:false,offline:true,paused:false};await adapter.pauseOffer('offer');await assert.rejects(adapter.resumeOffer('offer'),/offline/);assert.equal(writes,0);
});
test('a seller API throttle delays the next request and never automatically replays a write',async()=>{
 const times=[];
 const adapter=new EldoradoSellerAdapter({minIntervalMs:0,services:{settings:{}},transport:{request:async()=>{times.push(performance.now());return {status:times.length===1?429:200,headers:{'retry-after':'1'},text:async()=>'[]'};}}});
 adapter.auth.credential=async()=> 'fixture-not-a-secret';
 await assert.rejects(adapter.invoke('pauseOffer',{id:'11111111-1111-1111-1111-111111111111'}),/HTTP 429/);assert.equal(times.length,1);
 await adapter.invoke('getOffer',{id:'11111111-1111-1111-1111-111111111111'});assert.equal(times.length,2);assert(times[1]-times[0]>=950);
});
