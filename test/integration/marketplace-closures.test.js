'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('../../db/database');
const {DeliveryRepository}=require('../../db/repositories/delivery');
const {OrderObservations}=require('../../marketplace/order-observations');
const {DeliveryService}=require('../../marketplace/delivery-service');
const {OrderPoller}=require('../../marketplace/order-poller');
const {BrowserFulfillment}=require('../../marketplace/browser/fulfillment');
const {PlaywrightSession}=require('../../marketplace/browser/playwright-session');
const {validateRecipient}=require('../../marketplace/dispatch-authorization');
const flow=require('../../marketplace/order-chat-flow');

const id='11111111-1111-4111-8111-111111111111';
const order={id,orderUrl:'https://www.eldorado.gg/order/'+id,buyerMarketplaceId:'FixtureBuyer',buyerIgn:'PlayerOne',offerId:'offer',amount:'100000000',unitSize:'1000000',
  gameId:'donut',serverId:'default',status:'Pending delivery',browserWorkflow:true,hybridWorkflow:true,
  browserOrder:{id,buyerName:'FixtureBuyer',offerId:'offer',gameLabel:'DonutSMP',quantityDisplay:'100 M',hybridApiOrder:true,amount:'100000000'},
  browserBinding:{sellerHref:'seller'}};
const chunk={net:100000000n,command:100000000n,debit:100000000n};
async function fixture(t) {
  const db=await Database.open(':memory:');
  t.after(()=>db.close());
  const repo=new DeliveryRepository(db),archive=new OrderObservations(db);
  return {db,repo,archive};
}
function recordPayment(repo) {
  repo.intent(id,0,chunk,500000000n);
  repo.sent(id,0);
  repo.verify(id,0,{after:'400000000'},null,'seller1');
}

test('restart closes the actual verified-payment/old canceled-observation shape before opening any conversation',async t=>{
  const {db,repo}=await fixture(t);
  repo.observe(order,'live');recordPayment(repo);repo.state(id,'MARK_DELIVERED_PENDING');
  db.raw().prepare('INSERT INTO marketplace_observations VALUES(?,?,?,?,?)').run(id,
    JSON.stringify({...order,status:'Pending delivery',apiStatus:'Canceled'}),'seller fixture',1,2);
  const delivery=new DeliveryService(null,null,null,{}, {db});
  delivery.recover();
  assert.equal(await delivery.processOrder(order),false);
  assert.equal(repo.pending().length,0);
  assert.equal(repo.get(id).state,'RECONCILIATION_REQUIRED');
  assert.equal(repo.chunks(id)[0].amount,'100000000');
  assert.equal(repo.chunks(id)[0].state,'PAY_VERIFIED');
  assert.throws(()=>repo.intent(id,1,chunk,400000000n),/terminal/);
  delivery.recover();
  assert.equal(repo.history(id).filter(e=>e.kind==='STATE' && JSON.parse(e.data).state==='RECONCILIATION_REQUIRED').length,1);
});

test('a closed observation survives a stale page, duplicate discovery and a later reference write',async t=>{
  const {db,repo,archive}=await fixture(t);
  archive.observe({...order,status:'Canceled'});
  archive.recordReference(order,{id,status:'Pending delivery',messages:[],referenceOnly:true,executionEligible:false,paymentsSent:0,messagesSent:0});
  const poller=new OrderPoller({contract:{statuses:{paid:['Pending delivery']}}},{repo,ownerHeld:()=>false},{db,mode:'mock'});
  assert.equal(await poller.processDiscoveredOrder(order),false);
  assert.equal(repo.get(id),undefined);
  assert.equal(archive.list()[0].marketplaceStatus,'Canceled');
  repo.observe(order,'live');
  repo.applyMarketplaceStatus(id,repo.closedStatus(id));
  assert.equal(repo.get(id).state,'CANCELLED');
  assert.throws(()=>repo.state(id,'VALIDATED'),/closed/);
});

test('fresh cancellation after the confirmed room stops the last dispatch and preserves its intent',async t=>{
  const {db,repo}=await fixture(t);
  repo.observe(order,'live');repo.intent(id,0,chunk,500000000n);
  const reference={id,buyerName:'FixtureBuyer',status:'Pending delivery',quantityDisplay:'100 M',messages:[
    {id:'name',peer:true,text:'PlayerOne'},{id:'prompt',peer:false,text:flow.confirmationPrompt('PlayerOne',order.amount)},{id:'yes',peer:true,text:'yes'}]};
  let chats=0;
  const services={db,deliveryService:{repo},settings:{get:async()=>({})},marketplace:{chatOrder:async()=>({...order.browserOrder,status:'Canceled'})},
    browserBridge:{inspectOrderReference:async()=>{chats++;return reference;}}};
  services.browserFulfillment=new BrowserFulfillment(services);
  services.browserFulfillment.authorize=async()=>{};
  const {VerifiedPayments}=require('../../minecraft/verified-payments');
  const transport=new(require('node:events').EventEmitter)();
  const commands=[];transport.chat=command=>commands.push(command);
  const verifier=new VerifiedPayments({calibrated:true,source:'fixture',balance:'^Balance (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',timeoutMs:20,systemPositions:['system']});
  await assert.rejects(verifier._exchange(transport,'/pay PlayerOne 100000000',()=>null,null,()=>validateRecipient(services,order,'seller1')),/Canceled/);
  assert.equal(chats,1);assert.deepEqual(commands,[]);
  assert.equal(repo.get(id).state,'RECONCILIATION_REQUIRED');
  assert.equal(repo.chunks(id)[0].state,'PAY_INTENT');
});

test('in-flight cancellation preserves a subsequent genuine receipt and ledger debit without reopening the order',async t=>{
  const {db,repo}=await fixture(t);
  repo.observe(order,'live');repo.lock(id,'seller1','owner',100000000n,500000000n);
  repo.intent(id,0,chunk,500000000n);repo.sent(id,0);
  repo.applyMarketplaceStatus(id,'Canceled');
  assert.ok(db.raw().prepare('SELECT 1 FROM delivery_account_locks WHERE order_id=?').get(id));
  const Ledger=require('../../ledger/ledger'),ledger=new Ledger(db.raw());
  repo.verify(id,0,{after:'400000000'},ledger,'seller1');
  assert.equal(ledger.query({referenceId:id}).length,1);
  assert.equal(repo.chunks(id)[0].state,'PAY_VERIFIED');
  assert.equal(repo.get(id).state,'RECONCILIATION_REQUIRED');
  assert.equal(db.raw().prepare('SELECT 1 FROM delivery_account_locks WHERE order_id=?').get(id),undefined);
  repo.recover();assert.equal(repo.pending().length,0);
});

test('cancellation before finalization checks status before any proof/upload/mark in both delivery modes',async t=>{
  for(const hybridWorkflow of [true,false])await t.test(hybridWorkflow?'seller API':'seller history',async t=>{
    const {repo}=await fixture(t);
    const current={...order,hybridWorkflow};
    repo.observe(current,'live');recordPayment(repo);repo.state(id,'MARK_DELIVERED_PENDING');
    const remote={...order.browserOrder,status:'Canceled'};
    const services={deliveryService:{repo},marketplace:{chatOrder:async()=>remote},browserBridge:{inspectOrders:async()=>({sellerHref:'seller',orders:[remote]})}};
    const fulfillment=new BrowserFulfillment(services);let uploads=0;
    fulfillment.authorize=async()=>{};
    fulfillment.uploadEvidence=async()=>uploads++;
    await assert.rejects(fulfillment.markDelivered(id),/Canceled/);
    assert.equal(uploads,0);assert.equal(repo.get(id).state,'RECONCILIATION_REQUIRED');
  });
});

test('canceled seller API result cannot navigate Chrome, including a stale completion notification',async t=>{
  const {db,repo}=await fixture(t);
  repo.observe(order,'live');recordPayment(repo);repo.state(id,'DELIVERED');
  let navigations=0;
  const services={db,deliveryService:{repo},marketplace:{chatOrder:async()=>({...order.browserOrder,status:'Canceled'}),sellerHref:async()=>'seller'}};
  const session=new PlaywrightSession(services);session.page={url:()=>'',goto:async()=>{navigations++;}};
  for(const completionNotification of [false,true])await assert.rejects(session.orderChatContext(order.browserOrder,{completionNotification}),/Canceled/);
  assert.equal(navigations,0);assert.equal(repo.get(id).state,'RECONCILIATION_REQUIRED');
});

test('remote completion with our journaled acknowledgement reconciles once, external completion cannot start a payment',async t=>{
  const {db,repo}=await fixture(t);
  repo.observe(order,'live');recordPayment(repo);repo.state(id,'MARK_DELIVERED_PENDING');
  db.raw().prepare("INSERT INTO seller_api_actions(id,operation,resource_id,state,created_ms,updated_ms) VALUES(?,?,?,'INTENT',?,?)").run('markDelivered:'+id,'markDelivered',id,1,1);
  repo.applyMarketplaceStatus(id,'Delivered');
  assert.equal(repo.get(id).state,'DELIVERED');
  assert.equal(db.raw().prepare('SELECT state FROM seller_api_actions').get().state,'CONFIRMED');
  repo.applyMarketplaceStatus(id,'Completed');assert.equal(repo.pending().length,0);
  const other={...order,id:'second'};
  repo.observe(other,'live');repo.applyMarketplaceStatus(other.id,'Order received');
  assert.equal(repo.get(other.id).state,'MARKETPLACE_CLOSED');
  assert.throws(()=>repo.intent(other.id,0,chunk,500000000n),/terminal/);
});

test('a terminal readback does not clear an existing nonreceipt investigation',async t=>{
  const {db,repo}=await fixture(t);
  repo.observe(order,'live');recordPayment(repo);repo.state(id,'DELIVERED');
  db.raw().prepare("INSERT INTO seller_api_actions(id,operation,resource_id,state,created_ms,updated_ms) VALUES(?,?,?,'CONFIRMED',?,?)").run('markDelivered:'+id,'markDelivered',id,1,1);
  repo.state(id,'NEEDS_OPERATOR','Buyer reports nonreceipt after recorded delivery');
  repo.applyMarketplaceStatus(id,'Delivered');
  assert.equal(repo.get(id).state,'RECONCILIATION_REQUIRED');
  assert.equal(repo.pending().length,0);
  assert.equal(repo.chunks(id)[0].state,'PAY_VERIFIED');
});
