'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Database=require('../../db/database');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');
const {recover,MessageOutbox}=require('../../marketplace/browser/message-outbox');

test('an outgoing text mention or a similarly named attachment cannot reconcile the requested file',()=>{
  const {newAttachmentReceipt}=require('../../marketplace/browser/evidence-upload');
  for(const row of [{text:'proof.png',html:''},{text:'other-proof.png',html:'<img>'},{text:'proof.png.anything',html:'<img>'}]){
    assert.throws(()=>newAttachmentReceipt([],[{...row,peer:false}], 'A','proof.png','fixture'),/unconfirmed/);
  }
});

test('a timeout during file selection is reconciled after restart without selecting the file again',async t=>{
  const database=await Database.open(':memory:');
  t.after(()=>database.close());
  const db=database.raw();
  const order={id:'order-a',status:'Pending delivery',buyerName:'buyer',gameLabel:'DonutSMP',quantityDisplay:'100 M',orderUrl:'https://www.eldorado.gg/order/order-a'};
  const sellerHref='seller';
  const state={selected:0,after:[]};
  const file=path.resolve('web/dist/buyer-guides/which-name.jpg');
  const files=require('../../marketplace/browser/evidence-upload');
  const chat=require('../../marketplace/browser/observed-chat');
  t.mock.method(require('../../marketplace/browser/order-reference'),'readReference',async()=>({status:order.status}));
  t.mock.method(chat,'frameFor',async()=>({locator:()=>({evaluateAll:async()=>state.after})}));
  t.mock.method(files,'upload',async(_p,_o,_f,{beforeSend,beforeSelection})=>{
    await beforeSend({name:path.basename(file),hash:'fixture-hash',before:[]});
    await beforeSelection();
    state.selected++;
    throw Error('Fixture disconnected after file selection');
  });
  function session() {
    const s=new PlaywrightSession({db:database});
    s.context={};s.state='ATTACHED_PAUSED';s.page={isClosed:()=>false};s.config={timeoutMs:10};
    s.orderChatContext=async()=>({sellerHref,orders:[order]});
    return s;
  }
  const send=(s,pathName=file)=>s.uploadOrderEvidenceObserved(order,pathName,sellerHref,async()=>{});
  await assert.rejects(send(session()),/disconnected/);
  assert.equal(db.prepare('SELECT state FROM message_outbox').get().state,'UNKNOWN');
  recover(db);
  db.exec('UPDATE message_outbox SET next_check_ms=0');
  await assert.rejects(send(session()),/unconfirmed/);
  assert.equal(state.selected,1);
  state.after=[{peer:false,text:'which-name.jpg',names:['which-name.jpg'],displayedTime:'new',links:[]}];
  db.exec('UPDATE message_outbox SET next_check_ms=0');
  const result=await send(session());
  assert.equal(result.recovered,true);
  // A renamed replacement guide and a second worker replay the single saved receipt.
  assert.equal((await send(session(),path.resolve('marketplace/assets/minecraft-ign-guide.png'))).name,'which-name.jpg');
  assert.equal(state.selected,1);
  assert.deepEqual(db.prepare('SELECT state FROM message_outbox').all().map(row=>row.state),['SENT']);
});

test('per-order claims serialize senders; independent orders proceed; crash recovery distinguishes before and after dispatch',async t=>{
  const database=await Database.open(':memory:');t.after(()=>database.close());const db=database.raw();
  const entry=(order,name)=>new MessageOutbox(db,order,'uploadEvidenceObserved',{name},order+':'+name);
  const first=entry('A','how-to-confirm-1.png');
  first.claim();
  assert.throws(()=>entry('A','how-to-confirm-1.png').claim(),/Another sender/);
  assert.throws(()=>entry('A','how-to-confirm-2.png').claim(),/Another sender/);
  const other=entry('B','which-name.jpg');
  other.claim();other.stage('uploadEvidenceObserved','hash',{orderId:'B',name:'which-name.jpg'});other.dispatch();
  recover(db);
  assert.deepEqual(db.prepare('SELECT state FROM message_outbox ORDER BY order_id').all().map(row=>row.state),['FAILED','UNKNOWN']);
  assert.equal(entry('A','how-to-confirm-1.png').claim().reconcile,false);
  const uncertain=entry('B','which-name.jpg');
  assert.equal(uncertain.claim().reconcile,true);
  assert.throws(()=>uncertain.dispatch(),/already started/);
});

test('legacy confirmed actions survive newer logical keys and regenerated proof files',async t=>{
  const database=await Database.open(':memory:');t.after(()=>database.close());const db=database.raw();
  const insert=db.prepare('INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,result,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?)');
  const orderId='A';
  insert.run('legacy-text','sendMessageObserved',orderId,'hash','CONFIRMED',JSON.stringify({messageId:'v3-completion:A:v1'}),JSON.stringify({text:'previous version'}),1,1);
  insert.run('legacy-image','uploadEvidenceObserved',orderId,'hash','CONFIRMED',JSON.stringify({name:'delivery-old.png'}),JSON.stringify({name:'delivery-old.png'}),1,1);
  insert.run('later-uncertain','uploadEvidenceObserved',orderId,'hash','NEEDS_OPERATOR',JSON.stringify({name:'receipt-new.png'}),null,2,2);
  recover(db);
  assert.equal(new MessageOutbox(db,orderId,'sendMessageObserved',{messageId:'v3-completion:A'},'future-text').claim().result.text,'previous version');
  assert.equal(new MessageOutbox(db,orderId,'uploadEvidenceObserved',{name:'receipt-updated.png'},'future-image').claim().result.name,'delivery-old.png');
  assert.equal(db.prepare('SELECT count(*) n FROM message_outbox').get().n,2);
});
