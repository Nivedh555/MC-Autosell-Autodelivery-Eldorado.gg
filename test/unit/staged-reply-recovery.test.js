'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('../../db/database');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');
const {recover}=require('../../marketplace/browser/message-outbox');
const chat=require('../../marketplace/browser/observed-chat');
const references=require('../../marketplace/browser/order-reference');

test('reopened database reconciles a late outgoing bubble with no second click, even if the exact draft remains',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autosell-outbox-fixture-'));
  // Cleanup only the exact fixture database and its SQLite sidecars.
  const file=path.join(dir,'fixture.sqlite');
  const order={id:'order',status:'Pending delivery',buyerName:'Buyer',gameLabel:'DonutSMP',quantityDisplay:'100 M',orderUrl:'https://www.eldorado.gg/order/order'};
  const text="Done! Here's your proof",messageId='customer-proof:order',sellerHref='seller';
  let database=await Database.open(file),activations=0,messages=[],draft='';
  t.after(async()=>{await database.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});fs.rmdirSync(dir);});
  t.mock.method(chat,'frameFor',async()=>({getByRole:()=>({innerText:async()=>draft,fill:async v=>{draft=v;}})}));
  t.mock.method(references,'readReference',async()=>({status:order.status,messages}));
  t.mock.method(chat,'send',async (_p,_o,value,{beforeSend,beforeActivate})=>{
    await beforeSend({messages:[]});
    draft=value; await beforeActivate(); activations++;
    throw Error('Fixture receipt timed out');
  });
  const session=()=>{
    const s=new PlaywrightSession({db:database,settings:{get:async()=>({})}});
    s.context={};s.page={isClosed:()=>false};s.state='ATTACHED_PAUSED';s.config={timeoutMs:40};
    s.orderChatContext=async()=>({sellerHref,orders:[order]});
    return s;
  };
  const send=()=>session().sendOrderMessageObserved(order,text,messageId,sellerHref,async()=>{});
  await assert.rejects(send(),/timed out/);
  await database.close(); database=await Database.open(file); recover(database.raw());
  database.raw().exec('UPDATE message_outbox SET next_check_ms=0');
  await assert.rejects(send(),/missing or ambiguous/);
  assert.equal(draft,text);
  messages=[{id:'stable-message',peer:false,text}];
  database.raw().exec('UPDATE message_outbox SET next_check_ms=0');
  const result=await send();
  assert.equal(result.recovered,true);
  await Promise.all([send(),send()]);
  assert.equal(activations,1);
  assert.equal(database.raw().prepare('SELECT state FROM message_outbox').get().state,'SENT');
});
