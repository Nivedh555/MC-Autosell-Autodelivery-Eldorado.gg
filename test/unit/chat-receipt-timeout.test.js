'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const Database=require('../../db/database');
const chat=require('../../marketplace/browser/observed-chat');
const {CompletionNotifications}=require('../../v3/notifications');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');

test('receipt polling reports a stable timeout when the final browser read exhausts its budget',async t=>{
  let now=1000,reads=0;
  t.mock.method(Date,'now',()=>now);
  const cause=Object.assign(Error('locator.innerText: Timeout 1ms exceeded'),{name:'TimeoutError'});
  const frame={locator:()=>({innerText:async()=>{reads++;now=1010;throw cause;}})};
  await assert.rejects(chat.waitForReceipt(frame,'order','reply',[],10),error=>error.code==='CHAT_CONFIRMATION_TIMEOUT'&&error.cause===cause);
  assert.equal(reads,1);
  await assert.rejects(chat.waitForReceipt(frame,'order','reply',[],0),{code:'CHAT_CONFIRMATION_TIMEOUT'});
  assert.equal(reads,1);
});

test('completion notifier repeated start and restart leave one live interval and none after stop',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const live=new Set();
  t.mock.method(global,'setInterval',()=>{
    const timer={unref(){}};
    live.add(timer);
    return timer;
  });
  t.mock.method(global,'clearInterval',timer=>live.delete(timer));
  const worker=new CompletionNotifications({db:{raw:()=>db}});
  worker.start();worker.start();
  assert.equal(live.size,1);
  worker.stop();assert.equal(live.size,0);assert.equal(worker.timer,null);
  worker.start();assert.equal(live.size,1);
  worker.stop();assert.equal(live.size,0);
});

test('cancellation after attachment selection prevents preview submission and preserves UNKNOWN',async t=>{
  const database=await Database.open(':memory:');t.after(()=>database.close());
  const order={id:'A',status:'Pending delivery',buyerName:'buyer',gameLabel:'DonutSMP',quantityDisplay:'100 M',orderUrl:'https://www.eldorado.gg/order/A'};
  let selected=0,activated=0;
  const button={isEnabled:async()=>true,count:async()=>1,click:async()=>{activated++;}};
  const frame={
    locator:selector=>{
      if(selector.includes('input'))return {count:async()=>1,setInputFiles:async()=>{selected++;}};
      return {evaluateAll:async()=>[]};
    },
    getByText:()=>({count:async()=>1,isVisible:async()=>true,evaluate:async()=>false}),
    getByRole:(_role,{name})=>name==='Share a file'?{count:async()=>1}:{and:()=>button}
  };
  t.mock.method(chat,'frameFor',async()=>frame);
  t.mock.method(chat,'assertOrderPage',async()=>{});
  t.mock.method(require('../../marketplace/browser/order-reference'),'readReference',async()=>({status:selected?'Canceled':'Pending delivery'}));
  const session=new PlaywrightSession({db:database});
  session.context={};session.state='ATTACHED_PAUSED';session.page={isClosed:()=>false};session.config={timeoutMs:10};
  session.orderChatContext=async()=>({sellerHref:'seller',orders:[order]});
  const file=require('node:path').resolve('web/dist/buyer-guides/which-name.jpg');
  await assert.rejects(session.uploadOrderEvidenceObserved(order,file,'seller',async()=>{}),/Order changed before attachment submission/);
  assert.equal(selected,1);
  assert.equal(activated,0);
  assert.equal(database.raw().prepare('SELECT state FROM message_outbox').get().state,'UNKNOWN');
});
