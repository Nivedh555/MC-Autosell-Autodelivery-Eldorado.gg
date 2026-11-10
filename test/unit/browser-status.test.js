'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');
test('seller checks persist verified status without resuming browser actions',async()=>{
  let reject=false;
  const session=new PlaywrightSession({settings:{get:async()=>({offerId:'fixture'})},marketplace:{documentedSellerApi:true,inspectOffersForSetup:async()=>{if(reject)throw Error('Identity mismatch');return {offers:[{id:'fixture'}]};}}});
  session.context={};session.page={isClosed:()=>false};session.state='ATTACHED_PAUSED';session.reason='Sign in yourself';
  assert.equal((await session.checkConnection()).compatible,true);
  assert.match(session.status().reason,/Seller login verified/);assert.match(session.status().reason,/Currency offer is linked/);
  assert.equal(session.state,'ATTACHED_PAUSED');
  reject=true;assert.equal((await session.checkConnection()).compatible,false);assert.match(session.status().reason,/Identity mismatch/);
});

test('connection checks wait behind an order read, coalesce clicks and permit nested queued readers',async()=>{
  let finishRead,checks=0;
  const session=new PlaywrightSession({settings:{get:async()=>({offerId:'fixture'})},marketplace:{documentedSellerApi:true,inspectOffersForSetup:()=>session.observedExclusive(async()=>{checks++;return {offers:[{id:'fixture'}]};})}});
  session.context={};session.page={isClosed:()=>false};session.state='ATTACHED_PAUSED';
  const read=session.observedExclusive(async()=>{session.busy=true;await new Promise(resolve=>finishRead=resolve);session.busy=false;});
  await new Promise(resolve=>setImmediate(resolve));
  const first=session.checkConnection(),second=session.checkConnection();
  assert.equal(first,second);assert.equal(checks,0);
  finishRead();await read;assert.equal((await first).compatible,true);assert.equal(checks,1);
  await session.checkConnection();assert.equal(checks,2);
});
