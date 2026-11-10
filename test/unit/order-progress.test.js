'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Database=require('../../db/database'),{DeliveryRepository}=require('../../db/repositories/delivery'),{orderProgress}=require('../../marketplace/order-progress');
test('progress distinguishes verified money from pending proof and does not authorize another payment',async t=>{
 const db=await Database.open(':memory:');t.after(()=>db.close());const repo=new DeliveryRepository(db),order={id:'fixture',buyerMarketplaceId:'buyer',buyerIgn:'BuyerOne',amount:'100',unitSize:'1',offerId:'offer'};
 repo.observe(order,'mock');repo.intent(order.id,0,{net:100n,command:100n,debit:100n},500n);repo.sent(order.id,0);
 let result=orderProgress(db.raw(),order.id);assert.equal(result.payment.uncertain,true);assert.equal(result.payment.verifiedCoins,'0');assert.equal(result.marketplaceAcknowledgement,'PENDING');
 repo.verify(order.id,0,{after:'400'},null,'seller1');repo.state(order.id,'ALL_VERIFIED');result=orderProgress(db.raw(),order.id);
 assert.equal(result.payment.verifiedCoins,'100');assert.equal(result.screenshot,'PENDING');assert.equal(result.upload,'PENDING');assert.match(result.nextAction,/proof and marketplace acknowledgement only/);
 assert.equal(result.marketplaceAcknowledgement,'PENDING');assert.equal(result.confirmation.confirmed,false);
});
test('adding interpretation storage preserves existing payment journals on migration',async t=>{
 const db=await Database.open(':memory:');t.after(()=>db.close());const repo=new DeliveryRepository(db);
 repo.observe({id:'preserved',buyerIgn:'BuyerOne',amount:'100'},'mock');repo.intent('preserved',0,{net:100n,command:100n,debit:100n},500n);
 db.raw().exec('DROP TABLE chat_interpretations; DELETE FROM schema_version WHERE version=25;');
 await db.migrate();assert.equal(repo.chunks('preserved')[0].state,'PAY_INTENT');assert.equal(db.raw().prepare('SELECT count(*) n FROM chat_interpretations').get().n,0);
});
test('owner progress separates a refunded paid order from a message with an uncertain send outcome',async t=>{
  const db=await Database.open(':memory:');t.after(()=>db.close());
  const repo=new DeliveryRepository(db),id='closed-paid';
  repo.observe({id,buyerIgn:'BuyerOne',amount:'100'},'live');
  repo.intent(id,0,{net:100n,command:100n,debit:100n},500n);
  repo.sent(id,0);repo.verify(id,0,{after:'400'},null,'seller1');
  db.raw().prepare('INSERT INTO marketplace_observations VALUES(?,?,?,?,?)').run(id,JSON.stringify({id,status:'Canceled'}),'fixture',1,2);
  repo.applyMarketplaceStatus(id,'Canceled');
  db.raw().prepare(`INSERT INTO message_outbox(order_id,logical_key,action_id,state,submission_started,reason,updated_ms)
    VALUES(?,'proof-text','fixture-key','UNKNOWN',1,'Confirmation bubble missing',?)`).run(id,Date.now());
  const p=orderProgress(db.raw(),id);
  assert.equal(p.state,'RECONCILIATION_REQUIRED');
  assert.equal(p.marketplaceStatus,'Canceled');assert.equal(p.payment.verifiedCoins,'100');
  assert.equal(p.marketplaceAcknowledgement,'STOPPED');
  assert.equal(p.messages[0].state,'UNKNOWN');
  assert.match(p.nextAction,/closed Eldorado order/);
});
