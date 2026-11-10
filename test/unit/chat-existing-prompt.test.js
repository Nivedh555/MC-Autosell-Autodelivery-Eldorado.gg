'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Agent=require('../../marketplace/ai-chat-agent');
const flow=require('../../marketplace/order-chat-flow');
test('a hydrated IGN observation does not redraft its visible confirmation; a correction still does',async()=>{
  const services=require('../../services'),previous=services.gameBridge;services.gameBridge={};
  try{
    const writes=[];
    const agent=new Agent({services:{settings:{get:async()=>({confirmIgn:true,minimalChat:true})}},db:{raw:()=>({prepare:()=>({get:()=>undefined})})},repo:{get:()=>({state:'WAITING_FOR_IGN',conversationOnly:true,payload:JSON.stringify({amount:'100000000'})})}});
    agent.save=(...args)=>writes.push(args);agent.transcript=()=>[];
    const reference={messages:[{id:'hydrated-ign',peer:true,text:'ign: BuyerOne'},{id:'existing-prompt',peer:false,text:flow.confirmationPrompt('BuyerOne','100000000')}]};
    await agent.handleBuyerMessage({orderId:'order',message:'ign: BuyerOne',messageId:'new-fingerprint',reference});
    assert.equal(writes.filter(row=>row[2]==='out').length,0);
    reference.messages.push({id:'correction',peer:true,text:'ign: BuyerTwo'});
    await agent.handleBuyerMessage({orderId:'order',message:'ign: BuyerTwo',messageId:'correction',reference});
    const outgoing=writes.filter(row=>row[2]==='out');assert.equal(outgoing.length,1);
    assert.match(outgoing[0][1],/BuyerTwo/);
  }finally{services.gameBridge=previous;}
});
