'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Database=require('../../db/database');
const {ChatInterpreter,validateResult,suggestion,requestModel}=require('../../marketplace/chat-interpreter');
const config=mode=>({mode,model:'fixture-model',key:'fixture-secret'});
const input={orderId:'order-1',messageId:'message-1',text:'the account u need is BuyerOne pls',ruleIntent:'off_topic'};
const candidate={intent:'PROVIDE_IGN',username:'BuyerOne',confidence:'high'};
async function fixture(t,options={}){const db=await Database.open(':memory:');t.after(()=>db.close());return {db,engine:new ChatInterpreter({db:db.raw(),config:()=>config('shadow'),request:async()=>candidate,...options})};}
test('shadow caches classifications and cannot send a suggestion or authorize payments',async t=>{
  let calls=0;const {engine}=await fixture(t,{request:async()=>{calls++;return candidate;}});
  const results=await Promise.all([engine.interpret(input),engine.interpret(input)]);
  assert.equal(calls,1);assert.equal(results[0].moneyActionsAllowed,false);assert.equal(suggestion(results[0]),null);
  await engine.interpret(input);assert.equal(calls,1);
});
test('suggest requires literal valid names and never supplies a payment confirmation',async t=>{
  const {engine}=await fixture(t,{config:()=>config('suggest')});const result=await engine.interpret(input);
  assert.match(suggestion(result),/reply "ign: BuyerOne"/);
  for(const output of [{...candidate,username:'InventedName'},{...candidate,username:'Buyer'},{...candidate,amount:'1000000'},{...candidate,intent:'CONFIRM'},{...candidate,confidence:1}])assert.throws(()=>validateResult(output,input.text));
  assert.equal(suggestion({...result,intent:'CONFIRM',username:null}),null);assert.equal(suggestion({...result,confidence:'low'}),null);
});
test('disabled, deterministic and sensitive messages make no provider requests',async t=>{
  let calls=0;const {engine}=await fixture(t,{request:async()=>{calls++;return candidate;}});
  for(const value of [{...input,ruleIntent:'confirm_yes'},{...input,text:'api_key=private'},{...input,text:'https://example.test/?authToken=x'},{...input,text:'x'.repeat(1001)}])assert.equal(await engine.interpret(value),null);
  engine.config=()=>config('off');await engine.interpret(input);assert.equal(calls,0);
});
test('provider timeout fails closed, persists sanitized reason and bounds retries across restart',async t=>{
  const {db,engine}=await fixture(t,{timeoutMs:5,request:()=>new Promise(()=>{})});
  assert.equal(await engine.interpret(input),null);
  const row=db.raw().prepare('SELECT * FROM chat_interpretations').get();assert.equal(row.state,'UNAVAILABLE');assert.equal(row.reason,'AI_TIMEOUT');assert.equal(row.result,null);
  let calls=0;const restarted=new ChatInterpreter({db:db.raw(),config:()=>config('suggest'),request:async()=>{calls++;return candidate;}});
  assert.equal(await restarted.interpret(input),null);assert.equal(calls,0);
});
test('AI errors never persist credentials or provider response bodies',async t=>{
  const {db,engine}=await fixture(t,{request:async()=>{throw Error('Bearer fixture-secret raw buyer content');}});
  await engine.interpret(input);assert.equal(db.raw().prepare('SELECT reason FROM chat_interpretations').get().reason,'AI_INVALID_OR_UNAVAILABLE');
});
test('Responses request has strict schema, no tools, no order payload and handles refusals',async()=>{
  let sent;
  const fetchImpl=async(url,options)=>{sent={url,...JSON.parse(options.body)};return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(candidate)}]}]}));};
  assert.deepEqual(await requestModel({text:input.text,config:config('shadow'),fetchImpl}),candidate);
  assert.equal(sent.store,false);assert.equal(sent.text.format.strict,true);assert.equal(sent.tools,undefined);assert.equal(sent.input,JSON.stringify({buyer_message:input.text}));assert(!sent.input.includes(input.orderId));
  await assert.rejects(requestModel({text:input.text,config:config('shadow'),fetchImpl:async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}))}),/AI_REFUSAL/);
});
