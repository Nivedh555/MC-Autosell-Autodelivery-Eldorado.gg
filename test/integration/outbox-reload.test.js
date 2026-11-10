'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const Database=require('../../db/database');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');

test('a TalkJS send accepted before timeout is only reconciled on page reload and duplicate worker callbacks',async t=>{
  const browser=await chromium.launch();
  const database=await Database.open(':memory:');
  t.after(async()=>{await browser.close();await database.close();});
  const page=await browser.newPage();
  const order={id:'ac14c613-c07a-4dad-a251-9d3d62fdd918',status:'Pending delivery',buyerName:'FixtureBuyer',gameLabel:'DonutSMP',quantityDisplay:'100M'};
  order.orderUrl='https://www.eldorado.gg/order/'+order.id;
  const text='Fixture payment receipt follows.';
  let submitCount=0,showReceipt=false;
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/fixture-submit') {
      submitCount++;
      return route.fulfill({status:200,body:'accepted'});
    }
    const room=`<div class="ChatHeader__title"><a href="https://www.eldorado.gg/users/FixtureBuyer">FixtureBuyer</a></div>
      ${showReceipt?'<div class="UserMessage__message-row" data-message-id="receipt"><span class="MessageBody__message-text">'+text+'</span></div>':''}
      <div contenteditable="true" role="textbox" aria-label="Say something..."></div>
      <button aria-label="Send" onclick="fetch('/fixture-submit')">Send</button>`;
    const orderPage=`<style>eld-seller-order-page,eld-order-header,eld-seller-order-details-card{display:block}iframe{height:450px;width:700px}</style>
      <eld-seller-order-page><eld-order-header><span>Order ID: ${order.id}</span><eld-chip>Pending delivery</eld-chip></eld-order-header>
      <eld-seller-order-details-card><div><span>Game</span><span>DonutSMP</span></div><div><span>Quantity</span><span>100M</span></div>
      <div><span>Buyer</span><span>FixtureBuyer</span></div></eld-seller-order-details-card></eld-seller-order-page>
      <iframe src="https://app.talkjs.com/app/fixture/user/seller/chatbox/order"></iframe>`;
    return route.fulfill({contentType:'text/html',body:url.hostname==='app.talkjs.com'?room:orderPage});
  });
  await page.goto(order.orderUrl);
  const session=new PlaywrightSession({db:database,settings:{get:async()=>({})}});
  session.context={};session.state='ATTACHED_PAUSED';session.page=page;session.config={timeoutMs:1000};
  session.orderChatContext=async()=>({sellerHref:'fixture-seller',orders:[order]});
  const send=()=>session.sendOrderMessageObserved(order,text,'customer-proof:'+order.id,'fixture-seller',async()=>{});
  await assert.rejects(send(),{code:'CHAT_CONFIRMATION_TIMEOUT'});
  assert.equal(submitCount,1);
  assert.equal(database.raw().prepare('SELECT state FROM message_outbox').get().state,'UNKNOWN');
  showReceipt=true;await page.reload();
  database.raw().exec('UPDATE message_outbox SET next_check_ms=0');
  const results=await Promise.all([send(),send(),send()]);
  assert.equal(results.every(r=>r.text===text&&r.orderId===order.id),true);
  assert.equal(database.raw().prepare('SELECT state FROM message_outbox').get().state,'SENT');
  assert.equal(submitCount,1);
});
