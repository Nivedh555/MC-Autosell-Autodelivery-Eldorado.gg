'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('../../db/database'),{DeliveryService}=require('../../marketplace/delivery-service');
test('shutdown stops new deliveries while letting an active delivery finish before disconnect',async()=>{
 const db=await Database.open(':memory:');try{
  const delivery=new DeliveryService(null,null,null,null,{db});let complete,calls=0;
  delivery._processOrder=async()=>{calls++;return new Promise(resolve=>complete=resolve);};
  const active=delivery.processOrder({id:'active'}),stopping=delivery.stop(1000);
  assert.equal(await delivery.processOrder({id:'new'}),false);assert.equal(calls,1);
  complete(true);assert.equal(await active,true);assert.equal(await stopping,true);assert.equal(delivery.activeOrders.size,0);
 }finally{db.close();}
});
test('shutdown is bounded when an external service remains stuck',async()=>{
 const db=await Database.open(':memory:');try{
  const delivery=new DeliveryService(null,null,null,null,{db});let complete;delivery._processOrder=async()=>new Promise(resolve=>complete=resolve);
  const active=delivery.processOrder({id:'stuck'});assert.equal(await delivery.stop(10),false);complete(false);await active;
 }finally{db.close();}
});
