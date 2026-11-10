"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {DatabaseSync}=require("node:sqlite");
const {confirmationPrompt,selection}=require("../../marketplace/order-chat-flow");
const {CompletionNotifications}=require("../../v3/notifications");

test("a buyer's yes is bound to the amount and exact IGN in the prompt",()=>{
  const conversation=[
    {id:"ign",kind:"text",peer:true,text:"ign: BuyerOne"},
    {id:"prompt",kind:"text",peer:false,text:confirmationPrompt("BuyerOne","500000000")},
    {id:"yes",kind:"text",peer:true,text:"yes"},
  ];
  assert.equal(selection(conversation,{confirmIgn:true,amount:"500000000"}).confirmed,true);
  assert.equal(selection(conversation,{confirmIgn:true,amount:"50000000"}).confirmed,false);
  assert.equal(selection([...conversation,{id:"correction",peer:true,text:"ign: BuyerTwo"}],{confirmIgn:true,amount:"500000000"}).confirmed,false);
});

test('conversational confirmations and waiting messages cannot become payment usernames',()=>{
 const options={confirmIgn:true,amount:'180000000'};
 const messages=[{id:'name',peer:true,text:'hi ign TestBuyer7'},{id:'prompt',peer:false,text:confirmationPrompt('TestBuyer7',options.amount)},{id:'yes',peer:true,text:'yea'},{id:'waiting',peer:true,text:'yooooooooooooo'}];
 const selected=selection(messages,options);assert.equal(selected.latest.ign,'TestBuyer7');assert.equal(selected.confirmed,true);
 const correction=selection([...messages,{id:'no',peer:true,text:'no TestBuyer7'},{id:'again',peer:true,text:'can u give me my money ign TestBuyer7'}],options);
 assert.equal(correction.latest.ign,'TestBuyer7');assert.equal(correction.confirmed,false);assert.equal(correction.needsConfirmation,true);
});

test('explicit owner confirmation is bound to this exact buyer, amount and offer',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE delivery_events(order_id TEXT,kind TEXT,data TEXT,wall_ms INTEGER)');
  const order={id:'order',offerId:'offer',amount:'180000000',buyerName:'buyer'};
  const flow=require('../../marketplace/order-chat-flow'),s={db:{raw:()=>db}};
  assert.equal(flow.ownerRecipient(s,order),null);
  const reference={messages:[{id:'captured-name',peer:true,text:'ign: TestBuyer7'}]};
  db.prepare('INSERT INTO delivery_events VALUES(?,?,?,1)').run('order','OWNER_CONFIRMED_RECIPIENT',JSON.stringify({ign:'TestBuyer7',offerId:'offer',amount:'180000000',buyer:'buyer',conversationRevision:flow.revision(reference.messages)}));
  assert.equal(flow.ownerRecipient(s,order,reference).latest.ign,'TestBuyer7');
  assert.equal(flow.ownerRecipient(s,order,{messages:[...reference.messages,{id:'new',peer:true,text:'wait'}]}),null);
  assert.throws(()=>flow.ownerRecipient(s,{...order,amount:'190000000'}),/differs/);
  assert.throws(()=>flow.ownerRecipient(s,{...order,buyerName:'other'}),/differs/);
 }finally{db.close();}
});

test("completed delivery sends the buyer message and both confirmation guides; confirmed buyers are skipped",async t=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE delivery_orders(id TEXT,payload TEXT,state TEXT,evidence TEXT,created_ms INTEGER)");
  database.exec("CREATE TABLE browser_actions(operation TEXT,resource_id TEXT,request TEXT)");
  database.exec(require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../../db/migrations/026-message-outbox.sql'),'utf8'));
  const saved={hybridWorkflow:true,browserOrder:{quantityDisplay:"500 M"},browserBinding:{sellerHref:"seller-fixture"}};
  database.prepare("INSERT INTO delivery_orders VALUES(?,?,'DELIVERED',?,1)").run("order-a",JSON.stringify(saved),JSON.stringify({screenshotCaptured:true}));
  database.prepare("INSERT INTO delivery_orders VALUES(?,?,'DELIVERED',?,2)").run("order-b",JSON.stringify(saved),JSON.stringify({screenshotCaptured:true}));
  const sends=[],uploads=[];
  const service=new CompletionNotifications({
    db:{raw:()=>database},settings:{getSync:()=>false},
    marketplace:{chatOrder:async(id)=>({id,status:id==="order-a"?"Delivered":"Received"})},
    deliveryService:{repo:{get:()=>({state:"DELIVERED"})},ownerHeld:()=>false},
    browserBridge:{status:()=>({connected:true}),sendOrderMessageObserved:async(order,text,id,_seller,authorize)=>{await authorize();sends.push({order,text,id});},uploadOrderEvidenceObserved:async(order,file,_seller,authorize,options)=>{await authorize();assert.equal(options.confirmationGuide,true);assert(fs.existsSync(file));uploads.push([order.id,require('node:path').basename(file)]);}}
  });service.start();t.after(()=>{service.stop();database.close();});
  await service.tick();await service.tick();assert.deepEqual(uploads,[["order-a","how-to-confirm-1.png"],["order-a","how-to-confirm-2.png"]]);assert.equal(sends.length,1);
  assert.match(sends[0].text,/Confirm delivery/);assert.equal(sends[0].id,"v3-completion:order-a");
  assert.equal(database.prepare('SELECT state FROM v3_completions WHERE order_id=?').get('order-b').state,'SKIPPED');
});

