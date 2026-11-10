'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const flow=require('../../marketplace/order-chat-flow'),{parseIgn}=require('../../marketplace/ign-rules');
const amount='100000000';
let messageSequence=0;
const incoming=(text,id='m'+ ++messageSequence)=>({id,text,peer:true});
const prompt=(ign,id='prompt')=>({id,text:flow.confirmationPrompt(ign,amount),peer:false});
const select=messages=>flow.selection(messages,{amount,confirmIgn:true});
const confirmed=()=>[incoming('14him','name'),prompt('14him'),incoming('yes','yes')];
test('early yes and a changed amount cannot authorize a payment',()=>{
  assert.equal(select([incoming('yes'),incoming('14him'),prompt('14him')]).confirmed,false);
  assert.equal(flow.selection(confirmed(),{amount:'200000000'}).confirmed,false);
  assert.equal(flow.selection([incoming('14him')],{confirmIgn:false,amount}).confirmed,false);
});
for(const text of ['no','wait','wrong one','stop','cancel my order','wait no use 14him2','14him2','ign: 14him2','14him or 14him2','ign: nruhh???']){
  test('fresh control/correction revokes authorization: '+text,()=>assert.equal(select([...confirmed(),incoming(text)]).confirmed,false));
}
test('negative reply requires a new recipient and a new confirmation; old yes cannot survive',()=>{
  const rows=[...confirmed(),incoming('no','no'),incoming('14him2','new')];
  let state=select(rows);assert.equal(state.latest.ign,'14him2');assert.equal(state.confirmed,false);
  rows.push(prompt('14him2','new-prompt'),incoming('yes','new-yes'));state=select(rows);
  assert.equal(state.confirmed,true);assert.equal(state.confirmationMessageId,'new-yes');
  assert.deepEqual(select(JSON.parse(JSON.stringify(rows))),state);
});
test('unrelated status questions do not replace the confirmed IGN',()=>{
  for(const text of ['btw how long will it take?','thanks','waiting','yooooooooooooo']){
    const state=select([...confirmed(),incoming(text)]);assert.equal(state.latest.ign,'14him');assert.equal(state.confirmed,true);
  }
});
test('cancellation remains blocking even after another name and yes',()=>{
  const state=select([...confirmed(),incoming('cancel'),incoming('14him2'),prompt('14him2'),incoming('yes')]);
  assert.equal(state.cancelled,true);assert.equal(state.confirmed,false);
});
test('labeled extraction cannot truncate malformed, long or multiple usernames',()=>{
  for(const text of ['ign: nruhh???','ign: BuyerOne or BuyerTwo','ign: BuyerOne username BuyerTwo','ign: abcdefghijklmnopq','ign: BuyerOne!'])assert.equal(parseIgn(text),null,text);
  assert.equal(parseIgn('hi ign TestBuyer7').ign,'TestBuyer7');assert.equal(parseIgn('ign: .Bedrock_Name').ign,'.Bedrock_Name');
});
test('a model suggestion and yes never replace canonical IGN and exact confirmation',()=>{
  const rows=[incoming('this is confusing'),{id:'ai',peer:false,text:'I read your Minecraft username as BuyerOne. Please reply ign: BuyerOne.'},incoming('yes')];
  assert.equal(select(rows).confirmed,false);assert.equal(select(rows).latest,null);
});
test('rejected confirmation cannot be resurrected by another copy of its prompt and yes',()=>{
  assert.equal(select([...confirmed(),incoming('no'),prompt('14him','again'),incoming('yes')]).confirmed,false);
});
test('owner override must be bound to the current captured conversation revision',()=>{
  const rows=confirmed(),order={id:'order',offerId:'offer',amount,buyerName:'buyer'};
  const data={offerId:'offer',amount,buyer:'buyer',ign:'14him',conversationRevision:flow.revision(rows)};
  const services={db:{raw:()=>({prepare:()=>({get:()=>({data:JSON.stringify(data),wall_ms:1})})})}};
  assert.equal(flow.ownerRecipient(services,order,{messages:rows}).confirmed,true);
  assert.equal(flow.ownerRecipient(services,order,{messages:[...rows,incoming('wait')]}),null);
  delete data.conversationRevision;assert.equal(flow.ownerRecipient(services,order,{messages:rows}),null);
});
