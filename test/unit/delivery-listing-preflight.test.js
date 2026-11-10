'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const services=require('../../services');
const {ListingManager}=require('../../marketplace/listing-manager');
test('a funded manual offer does not require a pause before delivery and checks all queued stock',async()=>{
 const prior={offerQueue:services.offerQueue,orderPoller:services.orderPoller,deliveryService:services.deliveryService};
 try{
  services.offerQueue={active:()=>({account_id:'seller1'}),unresolved:()=>[{id:'one'},{id:'two'}]};
  services.orderPoller={captureApiOrders:async()=>({orders:[{id:'one',offerId:'offer',apiStatus:'Paid',amount:'100'},{id:'two',offerId:'offer',apiStatus:'Paid',amount:'180'}]})};
  services.deliveryService={repo:{get:()=>null}};
  let paused=0;
  const manager={db:{prepare:()=>({get:()=>({state:'ACTIVE',offer_id:'offer'})})},setting:async()=>({offerId:'offer',observedSellerHref:'seller',apiBinding:{unitCoins:'1'},reserve:'0'}),adapter:{documentedSellerApi:true,contract:{statuses:{paid:['Paid']}},getOffer:async()=>({id:'offer',sellerHref:'seller',unitCoins:'1',quantityCoins:'20'}),normalizeOffer:x=>x,pauseOffer:async()=>paused++},save:()=>{}};
  const call=context=>ListingManager.prototype.beforeDelivery.call(manager,'seller1',context);
  const order={offerId:'offer',hybridWorkflow:true};
  await call({order});await call({order,balance:304n});assert.equal(paused,0);
  await call({order,balance:290n});assert.equal(paused,1);
  await assert.rejects(call({order,balance:270n}),/cannot cover accepted orders/);
  manager.adapter.pauseOffer=async()=>{throw Error('pause HTTP 400');};
  await assert.rejects(call({order,balance:290n}),/pause HTTP 400/);
 }finally{Object.assign(services,prior);}
});
test('a fresh confirmed recipient correction cannot change the order amount or identity',async()=>{
 const Database=require('../../db/database'),database=await Database.open(':memory:');
 try{
  const repo=new(require('../../db/repositories/delivery').DeliveryRepository)(database);
  const original={id:'unpaid-order',buyerIgn:'yea',amount:'180000000',unitSize:'1000000',offerId:'offer',gameId:'donut',serverId:'default',buyerMarketplaceId:'buyer',hybridWorkflow:true};
  repo.observe(original,'live');repo.state(original.id,'NEEDS_OPERATOR','Buyer changed their recipient or confirmation before payment No payment command was issued for this order.');
  assert.equal(repo.correctUnpaidRecipient({...original,buyerIgn:'TestBuyer7',amount:'190000000'}),false);
  assert.equal(repo.correctUnpaidRecipient({...original,buyerIgn:'TestBuyer7'}),true);
  assert.equal(repo.get(original.id).state,'VALIDATED');assert.equal(JSON.parse(repo.get(original.id).payload).buyerIgn,'TestBuyer7');
  assert.equal(repo.observe({...original,buyerIgn:'TestBuyer7'},'live').state,'VALIDATED');
 }finally{database.close();}
});
test('only listing holds with no payment attempt, lock or active claim may recover',()=>{
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE delivery_orders(id TEXT,state TEXT,reason TEXT,mode TEXT,payload TEXT,next_attempt_ms INTEGER,updated_ms INTEGER);
  CREATE TABLE delivery_chunks(order_id TEXT,chunk_index INTEGER,state TEXT);
  CREATE TABLE delivery_account_locks(order_id TEXT);
  CREATE TABLE delivery_order_claims(order_id TEXT);
  CREATE TABLE delivery_events(order_id TEXT,kind TEXT,data TEXT,wall_ms INTEGER,monotonic_ns TEXT);`);
  const reason='Step pause_listing: HTTP 400. No payment command was issued for this order.';
  for(const id of ['safe','paid','locked','claimed','other-step'])db.prepare('INSERT INTO delivery_orders VALUES(?,?,?,?,?,0,0)').run(id,'NEEDS_OPERATOR',id==='other-step'?'Step pay: uncertain':reason,'live',JSON.stringify({hybridWorkflow:true}));
  for(const [id,reason]of [['browser','The selected seller browser is disconnected No payment command was issued for this order.'],['shutdown','Step lease: Session manager is shutting down No payment command was issued for this order.']])db.prepare('INSERT INTO delivery_orders VALUES(?,?,?,?,?,0,0)').run(id,'NEEDS_OPERATOR',reason,'live',JSON.stringify({hybridWorkflow:true}));
  db.prepare("INSERT INTO delivery_chunks VALUES('paid',0,'PAY_SENT')").run();db.exec("INSERT INTO delivery_account_locks VALUES('locked');INSERT INTO delivery_order_claims VALUES('claimed');");
  const repo=new(require('../../db/repositories/delivery').DeliveryRepository)({raw:()=>db});repo.recoverListingHolds();
  assert.equal(repo.get('safe').state,'VALIDATED');
  assert.equal(repo.get('browser').state,'VALIDATED');assert.equal(repo.get('shutdown').state,'VALIDATED');
  for(const id of ['paid','locked','claimed','other-step'])assert.equal(repo.get(id).state,'NEEDS_OPERATOR');
  assert.equal(db.prepare('SELECT count(*) n FROM delivery_events').get().n,3);
 }finally{db.close();}
});
