'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Database=require('../../db/database'),{DeliveryRepository}=require('../../db/repositories/delivery'),{OrderObservations}=require('../../marketplace/order-observations'),{ChatScheduler}=require('../../marketplace/chat-scheduler');
test('completed orders are not opened by the chat watcher even when the marketplace observation is stale',async()=>{
 const database=await Database.open(':memory:'),globalServices=require('../../services'),previous=globalServices.store;globalServices.store=null;
 try{
  const order={id:'completed-order',browserWorkflow:true,status:'Pending delivery',gameLabel:'DonutSMP',offerId:'offer',orderUrl:'https://www.eldorado.gg/order/completed-order'};
  const repo=new DeliveryRepository(database),archive=new OrderObservations(database);repo.observe(order,'live');repo.state(order.id,'DELIVERED');archive.observe(order);
  let reads=0;const reference={id:order.id,status:'Delivered',referenceOnly:true,executionEligible:false,paymentsSent:0,messagesSent:0,messages:[]};
  const scheduler=new ChatScheduler({db:database,settings:{get:async key=>key==='listing.policy'?{offerId:'offer',observedSellerHref:'seller'}:false},marketplace:{hybrid:true},deliveryService:{repo},browserBridge:{status:()=>({connected:true,state:'ATTACHED_PAUSED'}),inspectOrderReference:async()=>{reads++;return reference;}}});
  await scheduler.tickObserved({openingEnabled:false});assert.equal(reads,0);
  assert.throws(()=>repo.state(order.id,'VALIDATED'),/Completed order/);
  const active={...order,id:'open-order',orderUrl:'https://www.eldorado.gg/order/open-order'};
  repo.observe(active,'live');repo.state(active.id,'VALIDATED');archive.observe(active);
  reference.id=active.id;await scheduler.tickObserved({openingEnabled:false});assert.equal(reads,1);
  assert.equal(archive.list().find(row=>row.id===active.id).marketplaceStatus,'Delivered');
 }finally{globalServices.store=previous;database.close();}
});
