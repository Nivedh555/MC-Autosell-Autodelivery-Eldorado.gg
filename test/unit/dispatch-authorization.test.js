'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateRecipient}=require('../../marketplace/dispatch-authorization');
const flow=require('../../marketplace/order-chat-flow');
test('dispatch rereads the exact room and rejects late correction, cancel and changed identity',async()=>{
  const order={id:'order',buyerMarketplaceId:'buyer',buyerIgn:'BuyerOne',amount:'100000000',browserOrder:{id:'order'}};
  let rows=[{id:'name',peer:true,text:'BuyerOne'},{id:'prompt',peer:false,text:flow.confirmationPrompt('BuyerOne',order.amount)},{id:'yes',peer:true,text:'yes'}],buyer='buyer',events=0,checks=0;
  const services={browserFulfillment:{authorize:async()=>checks++},browserBridge:{inspectOrderReference:async()=>({id:'order',buyerName:buyer,status:'Pending delivery',quantityDisplay:'100 M',messages:rows})},settings:{get:async()=>({confirmIgn:true})},deliveryService:{repo:{event:()=>events++}}};
  await validateRecipient(services,order,'seller1');assert.equal(events,1);assert.equal(checks,2);
  const original=[...rows];for(const text of ['wait','no','cancel my order','ign: BuyerTwo']){rows=[...original,{id:'late',peer:true,text}];await assert.rejects(validateRecipient(services,order,'seller1'),/changed their recipient/);}
  rows=original;buyer='different buyer';await assert.rejects(validateRecipient(services,order,'seller1'),/identity/);assert.equal(events,1);
});
