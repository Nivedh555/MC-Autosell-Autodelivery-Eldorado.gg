'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Database=require('../../db/database'),Agent=require('../../marketplace/ai-chat-agent'),flow=require('../../marketplace/order-chat-flow');
test('AI suggestion must pass through canonical IGN entry and exact amount confirmation in the real chat agent',async t=>{
 const db=await Database.open(':memory:');t.after(()=>db.close());const globalServices=require('../../services'),old=globalServices.gameBridge;globalServices.gameBridge={};t.after(()=>globalServices.gameBridge=old);
 const order={id:'order',amount:'100000000',buyerName:'buyer'},reference={messages:[{id:'messy',peer:true,text:'the account u need is BuyerOne pls'}]};
 const row={state:'WAITING_FOR_IGN',conversationOnly:true,payload:JSON.stringify({...order,orderReference:reference})};let calls=0;
 const services={db,settings:{get:async()=>({confirmIgn:true,minimalChat:true,fastReplies:true})}};
 const agent=new Agent({db,services,repo:{get:()=>row},interpreter:{interpret:async()=>{calls++;return {mode:'suggest',intent:'PROVIDE_IGN',username:'BuyerOne',confidence:'high',moneyActionsAllowed:false};}}});
 const first=await agent.handleBuyerMessage({orderId:'order',message:reference.messages[0].text,messageId:'in:messy',reference});
 assert.equal(first.action,'clarify');assert.match(first.reply,/reply "ign: BuyerOne"/);assert.equal(calls,1);
 reference.messages.push({id:'suggestion',peer:false,text:first.reply},{id:'early-yes',peer:true,text:'yes'});
 assert.equal(flow.selection(reference.messages,{amount:order.amount}).confirmed,false);
 reference.messages.push({id:'canonical',peer:true,text:'ign: BuyerOne'});
 const next=await agent.handleBuyerMessage({orderId:'order',message:'ign: BuyerOne',messageId:'in:canonical',reference});
 assert.match(next.reply,/Confirm payment: 100000000 Donut dollars to BuyerOne\./);assert.match(next.reply,/Order: order/);assert.equal(calls,1);
 reference.messages.push({id:'prompt',peer:false,text:next.reply},{id:'confirm',peer:true,text:'yes'});
 assert.equal(flow.selection(reference.messages,{amount:order.amount,orderId:order.id,services}).confirmed,true);
 assert.equal(JSON.parse(row.payload).buyerIgn,undefined);assert.equal(db.raw().prepare('SELECT count(*) n FROM delivery_chunks').get().n,0);
});
test('an already supplied exact IGN skips the opening request',async t=>{
 const db=await Database.open(':memory:');t.after(()=>db.close());const globalServices=require('../../services'),old=globalServices.gameBridge;globalServices.gameBridge={};t.after(()=>globalServices.gameBridge=old);
 const row={state:'WAITING_FOR_IGN',conversationOnly:true,payload:JSON.stringify({id:'order',amount:'100000000',orderReference:{messages:[{id:'name',peer:true,text:'ign: BuyerOne'}]}})};
 const agent=new Agent({db,services:{settings:{get:async()=>({confirmIgn:true})}},repo:{get:()=>row}});
 assert.equal((await agent.sendOpeningMessage('order')).skippedKnownRecipient,true);
 assert.equal(db.raw().prepare("SELECT count(*) n FROM buyer_messages WHERE direction='out'").get().n,0);
});
