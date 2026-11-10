'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {chromium}=require('playwright');
const chat=require('../../marketplace/browser/observed-chat');
const uploads=require('../../marketplace/browser/evidence-upload');
const {readReference}=require('../../marketplace/browser/order-reference');
const Database=require('../../db/database');
const services=require('../../services');
const {OrderPoller}=require('../../marketplace/order-poller');
const order={id:'a71fb786-5778-46bd-d109-08df2b835c4f',buyerName:'FixtureBuyer',gameLabel:'DonutSMP',quantityDisplay:'100M',status:'Pending delivery'};
order.orderUrl='https://www.eldorado.gg/order/'+order.id;
const row=(text,attrs='')=>'<div class="UserMessage__message-row" '+attrs+'><span class="MessageBody__message-text">'+text+'</span></div>';
function extract(html){const dom=new JSDOM(html);try{return chat.readRows([...dom.window.document.querySelectorAll('.UserMessage__message-row')]);}finally{dom.window.close();}}
test('chat captures timestamp siblings and parent direction without stealing another message time',()=>{
  const rows=extract('<div class="UserMessage__by-other">'+row('FixtureIGN')+'<time datetime="2026-10-19T10:00:00Z"></time></div>'+row('Greeting'));
  assert.equal(rows[0].peer,true);assert.equal(rows[0].displayedTime,'2026-10-19T10:00:00Z');assert.equal(rows[1].displayedTime,null);
  assert.equal(chat.messages(order.id,rows).length,2);
});
test('timestamp-free unique messages retain stable local identities across captures',()=>{
  const rows=extract(row('hello')+row('FixtureIGN'));
  const first=chat.messages(order.id,rows),second=chat.messages(order.id,rows);
  assert.deepEqual(first.map(m=>m.id),second.map(m=>m.id));assert.equal(first[0].displayedTime,null);
  assert.equal(first[0].moneyActionsAllowed,false);
});
test('duplicate messages need distinct captured identity and oversized messages are rejected',()=>{
  assert.throws(()=>chat.messages(order.id,extract(row('Y')+row('Y'))),/distinct captured identities/);
  assert.equal(chat.messages(order.id,extract(row('Y','data-message-id="one"')+row('Y','data-message-id="two"'))).length,2);
  assert.throws(()=>chat.messages(order.id,[{text:'x'.repeat(4001),peer:true}]),/text limit/);
});
test('timestamp hydration cannot turn an existing message or attachment into a new send receipt',()=>{
  const before=chat.messages(order.id,[{text:'hello',peer:false}]);
  const after=chat.messages(order.id,[{text:'hello',peer:false,displayedTime:'2026-10-19'}]);
  assert.throws(()=>chat.newReceipt(before,after,order.id,'hello'),/already present/);
  const attachment={text:'proof.png',names:['proof.png'],peer:false,displayedTime:null};
  assert.throws(()=>uploads.newAttachmentReceipt([attachment],[{...attachment,displayedTime:'2026-10-19'}],order.id,'proof.png','hash'),/already existed/);
  assert.equal(uploads.newAttachmentReceipt([],[attachment],order.id,'proof.png','hash').receipt.name,'proof.png');
});

test('adjacent indistinguishable confirmation replies collapse without discarding corrections',()=>{
  const yes={text:'yes',peer:true,displayedTime:'same-time'},no={text:'no',peer:true,displayedTime:'same-time'};
  assert.equal(chat.messages(order.id,[yes,yes]).length,1);
  assert.deepEqual(chat.messages(order.id,[yes,yes,no]).map(m=>m.text),['yes','no']);
  assert.throws(()=>chat.messages(order.id,[yes,no,yes]),/Identical chat messages/);
  assert.throws(()=>chat.messages(order.id,[{text:'BuyerName',peer:true},{text:'BuyerName',peer:true}]),/Identical chat messages/);
});
test('browser chat reads and confirms sends without row timestamps, and rejects changed order headers',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  const html='<style>eld-seller-order-page,eld-seller-order-details-card,eld-order-header{display:block}iframe{height:500px;width:700px}</style><eld-seller-order-page><eld-order-header><span>Order ID: '+order.id+'</span><eld-chip>Pending delivery</eld-chip></eld-order-header><eld-seller-order-details-card><div><span>Game</span><span>DonutSMP</span></div><div><span>Quantity</span><span>100M</span></div><div><span>Buyer</span><span>FixtureBuyer</span></div></eld-seller-order-details-card></eld-seller-order-page><iframe src="https://app.talkjs.com/app/fixture/user/seller/chatbox/order"></iframe>';
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().startsWith('https://app.talkjs.com')?'<div class="ChatHeader__title"><a href="https://www.eldorado.gg/users/FixtureBuyer">FixtureBuyer</a></div><div id="messages"><div class="UserMessage__by-other">'+row('FixtureIGN')+'</div></div><div contenteditable="true" role="textbox" aria-label="Say something..."></div><button onclick="const box=document.querySelector(\'[role=textbox]\');const r=document.createElement(\'div\');r.className=\'UserMessage__message-row\';const b=document.createElement(\'span\');b.className=\'MessageBody__message-text\';b.textContent=box.textContent;r.append(b);document.querySelector(\'#messages\').append(r);box.textContent=\'\';window.sent=(window.sent||0)+1" aria-label="Send">Send</button>':html}));
  await page.goto(order.orderUrl);
  const reference=await readReference(page,order,1500);assert.equal(reference.messages[0].peer,true);assert.equal(reference.messages[0].text,'FixtureIGN');
  const receipt=await chat.send(page,order,'Hello fixture',{timeoutMs:1500,characterMs:0,beforeSend:async()=>{},beforeSubmit:async()=>{}});
  assert.equal(receipt.text,'Hello fixture');assert.equal(receipt.displayedTime,null);
  const frame=await chat.frameFor(page,order.buyerName,1500);assert.equal(await frame.evaluate(()=>window.sent),1);
  await assert.rejects(chat.send(page,order,'Second fixture',{timeoutMs:1500,characterMs:0,beforeSend:async()=>{},beforeSubmit:async()=>{await page.locator('eld-order-header span').evaluate(node=>{node.textContent='Order ID: wrong-order';});}}),/Order header changed/);
  assert.equal(await frame.evaluate(()=>window.sent),1);
});
test('order reference timeouts identify the failing stage',async()=>{
  const failure=Object.assign(Error('fixture selector timeout'),{name:'TimeoutError'});
  const page={url:()=>order.orderUrl,locator:()=>({waitFor:async()=>{throw failure;}})};
  await assert.rejects(readReference(page,order,50),error=>error.code==='ELDORADO_ORDER_READ_TIMEOUT'&&/order details/.test(error.message));
});

test('image delivery uses the hidden input without a file picker and confirms a delayed upload once',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();let chooserOpened=false,intents=0;
  page.on('filechooser',()=>chooserOpened=true);
  const html=`<style>eld-seller-order-page,eld-seller-order-details-card,eld-order-header{display:block}iframe{height:500px;width:700px}</style><eld-seller-order-page><eld-order-header><span>Order ID: ${order.id}</span><eld-chip>Pending delivery</eld-chip></eld-order-header><eld-seller-order-details-card><div><span>Game</span><span>DonutSMP</span></div><div><span>Quantity</span><span>100M</span></div><div><span>Buyer</span><span>FixtureBuyer</span></div></eld-seller-order-details-card></eld-seller-order-page><iframe src="https://app.talkjs.com/app/fixture/user/seller/chatbox/order"></iframe>`;
  const room=`<div class="ChatHeader__title"><a href="https://www.eldorado.gg/users/FixtureBuyer">FixtureBuyer</a></div><div id="messages"></div><input type="file" class="test__fileupload-input" style="display:none"><button aria-label="Share a file">Attach</button><div id="preview"></div><script>
    window.sent=0;document.querySelector('input').onchange=()=>setTimeout(()=>{
      const name=document.querySelector('input').files[0].name;
      const preview=document.querySelector('#preview');preview.innerHTML='<span>'+name+'</span><button disabled>Send</button>';
      const send=preview.querySelector('button');setTimeout(()=>send.disabled=false,150);
      send.onclick=()=>{window.sent++;preview.replaceChildren();setTimeout(()=>{const row=document.createElement('div');row.className='UserMessage__message-row UserMessage__by-me';row.innerHTML='<div class="MessageBody__message-text"><a>'+name+' (38 KB)</a></div><img alt="">';document.querySelector('#messages').append(row);},150);};
    },150);
  </script>`;
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:r.request().url().startsWith('https://app.talkjs.com')?room:html}));
  await page.goto(order.orderUrl);
  const file=require('node:path').resolve('web/dist/buyer-guides/which-name.jpg');
  const receipt=await uploads.upload(page,order,file,{timeoutMs:3000,beforeSend:async()=>intents++});
  assert.equal(receipt.receipt.name,'which-name.jpg');assert.equal(intents,1);assert.equal(chooserOpened,false);
  const frame=await chat.frameFor(page,order.buyerName,1500);assert.equal(await frame.evaluate(()=>window.sent),1);
  await assert.rejects(uploads.upload(page,order,file,{timeoutMs:1500,beforeSend:async()=>intents++}),/already appears/);
  assert.equal(intents,1);assert.equal(await frame.evaluate(()=>window.sent),1);
});
test('sold history never opens completed chats or creates holds for terminal orders',async t=>{
  const db=await Database.open(':memory:');t.after(()=>db.close());const statuses=['Completed','Delivered','Received','Canceled','Disputed','Pending delivery'];
  const orders=statuses.map((status,i)=>({...order,id:'fixture-'+i,status,orderUrl:'https://www.eldorado.gg/order/fixture-'+i}));
  const opened=[];services.offerQueue=null;services.listingManager=null;services.chatScheduler=null;
  services.browserBridge={status:()=>({connected:true,state:'ATTACHED_PAUSED'}),inspectOrders:async()=>({orders,sellerHref:'https://www.eldorado.gg/users/seller'}),inspectOrderReference:async value=>{opened.push(value.id);throw Error('fixture reference not hydrated');}};
  db.raw().prepare('INSERT INTO observed_order_holds(order_id,offer_id,status,reason,created_ms) VALUES(?,?,?,?,?)').run('fixture-0','offer','Pending delivery','old',Date.now());
  const poller=new OrderPoller({profile:{}},null,{db,settings:{get:async()=>({offerId:'offer',observedSellerHref:'https://www.eldorado.gg/users/seller'})}});
  await poller.captureBrowserOrders();assert.deepEqual(opened,['fixture-5']);
  assert.deepEqual(db.raw().prepare('SELECT order_id FROM observed_order_holds WHERE resolved_ms IS NULL').all().map(row=>row.order_id),['fixture-5']);
});
