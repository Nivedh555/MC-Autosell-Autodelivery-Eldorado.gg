'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const Database=require('../../db/database'),Ledger=require('../../ledger/ledger'),services=require('../../services');
const {DeliveryService}=require('../../marketplace/delivery-service'),{OrderPoller}=require('../../marketplace/order-poller');
async function fixture(t){
 const db=await Database.open(':memory:');t.after(()=>db.close());
 const keys=['db','pairManager','offerQueue','browserBridge','browserFulfillment','listingManager','chatScheduler','store','ops','gameBridge','rollout','deliveryService'];
 const previous=Object.fromEntries(keys.map(key=>[key,services[key]]));t.after(()=>Object.assign(services,previous));
 Object.assign(services,Object.fromEntries(keys.map(key=>[key,null])));services.db=db;
 let balance=1000000n;const payments=[],bot=new EventEmitter();bot.username='FixtureHolder';bot.chat=command=>queueMicrotask(()=>{
  if(command==='/bal')bot.emit('messagestr','Balance: '+balance,'system');
  else if(command.startsWith('/pay ')){const [,ign,amount]=command.split(' ');payments.push(command);balance-=BigInt(amount);bot.emit('messagestr',`Paid ${amount} to ${ign}`,'system');}
 });
 const policy={calibrated:true,source:'isolated burst fixture',holderAccount:'buyer1',offerId:'offer',gameId:'donut',serverId:'main',unitSize:'1',paidStatuses:['FUNDED'],maxPay:'100',maxChunks:20,taxBasisPoints:0,taxMode:'none',reserve:'0',cooldownMs:0,markRetryMs:0,markEscalateMs:10000,bedrockPrefix:'.'};
 const pack={calibrated:true,source:'isolated burst fixture',balance:'^Balance: (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',timeoutMs:50,systemPositions:['system']};
 const settings={get:async key=>({'general.bot.paused':false,'eldorado.order.auto_deliver':true,'delivery.policy':policy,'delivery.patternPack':pack})[key]};
 const order=id=>({id,offerId:'offer',gameId:'donut',serverId:'main',buyerIgn:'Buyer'+id.replace(/\D/g,''),buyerMarketplaceId:'buyer-'+id,amount:'250',unitSize:'1',status:'FUNDED'});
 const sessions={acquire:async()=>({ready:async()=>{},getBot:()=>bot,release(){}})},adapter={contract:{statuses:{paid:['FUNDED']}},getOrder:async id=>order(id),markDelivered:async()=>{}};
 const delivery=new DeliveryService(sessions,new Ledger(db.raw()),settings,adapter,{db,mode:'mock',policy,patternPack:pack,evidenceBuilder:async()=>({fixture:true})});
 return {db,policy,pack,settings,order,sessions,adapter,delivery,payments,balance:()=>balance};
}
test('60 simultaneous duplicated orders drain through one account despite acknowledgement failures, with exact totals and no repeated payments',async t=>{
 const f=await fixture(t),orders=Array.from({length:60},(_,i)=>f.order('order'+String(i).padStart(3,'0'))),acks=new Map();
 f.adapter.listOrders=async()=>[...orders,...orders];f.adapter.markDelivered=async id=>{const count=(acks.get(id)||0)+1;acks.set(id,count);if(id===orders[0].id&&count<=2)throw Error('Temporary acknowledgement outage');};
 const poller=new OrderPoller(f.adapter,f.delivery,{db:f.db,settings:f.settings,mode:'mock'});
 const first=await Promise.all([poller.poll(),poller.poll()]);assert(first.some(result=>result.success===false));
 let cycles=1;
 while(f.db.raw().prepare("SELECT count(*) n FROM delivery_orders WHERE state='DELIVERED'").get().n<60&&cycles++<40)await poller.poll();
 assert.equal(f.db.raw().prepare("SELECT count(*) n FROM delivery_orders WHERE state='DELIVERED'").get().n,60);
 assert.equal(f.payments.length,180);assert.equal(f.balance(),985000n);
 for(const order of orders){assert.deepEqual(f.delivery.repo.chunks(order.id).map(c=>[c.state,c.amount]),[['PAY_VERIFIED','100'],['PAY_VERIFIED','100'],['PAY_VERIFIED','50']]);assert.equal(f.payments.filter(c=>c.split(' ')[1]===order.buyerIgn).length,3);}
 assert.equal(f.delivery.ledger.query({entryType:'delivery'}).length,180);
 await poller.poll();assert.equal(f.payments.length,180);
});
test('restart before a send resumes safely; restart with an uncertain send stays held',async t=>{
 const f=await fixture(t),safe=f.order('safe1'),uncertain=f.order('uncertain2');
 f.delivery.repo.observe(safe,'mock');f.delivery.repo.lock(safe.id,'buyer1','old-process','250','1000000');f.delivery.repo.state(safe.id,'SESSION_READY');
 f.delivery.repo.recover();assert.equal(f.delivery.repo.get(safe.id).state,'VALIDATED');
 await f.delivery.processOrder(safe);assert.equal(f.payments.length,3);
 f.delivery.repo.observe(uncertain,'mock');f.delivery.repo.lock(uncertain.id,'buyer1','old-process','250','999750');f.delivery.repo.intent(uncertain.id,0,{net:100n,command:100n,debit:100n},999750n);f.delivery.repo.sent(uncertain.id,0);
 f.delivery.repo.recover();assert.equal(f.delivery.repo.get(uncertain.id).state,'NEEDS_OPERATOR');
 await f.delivery.processOrder(uncertain);assert.equal(f.payments.length,3);
});

test('100 unconfirmed hybrid orders rotate through bounded browser reads rather than starving later buyers',async t=>{
 const f=await fixture(t),orders=Array.from({length:100},(_,i)=>f.order('order'+String(i).padStart(3,'0'))),seen=new Set();
 f.adapter.hybrid=true;f.adapter.normalizeObservation=data=>data;
 services.browserBridge={status:()=>({connected:true,state:'ATTACHED_PAUSED'})};
 f.adapter.prepareOrder=async data=>{seen.add(data.id);return null;};
 const settings={get:async key=>key==='eldorado.order.auto_deliver'?false:f.settings.get(key)};
 const poller=new OrderPoller(f.adapter,f.delivery,{db:f.db,settings});poller.captureApiOrders=async()=>({raw:[...orders,...orders],orders});
 for(let cycle=0;cycle<25;cycle++){const before=seen.size;await poller.poll();assert.equal(seen.size-before,4);}
 assert.equal(seen.size,100);assert.equal(f.payments.length,0);
});
test('a failed screenshot retries proof only and blocks another payment on that account until captured',async t=>{
 const f=await fixture(t),paid={...f.order('paid1'),browserWorkflow:true},next=f.order('next2');
 let blocked=true,captures=0,marked=0;
 services.gameBridge={screenshot:async(account,reference)=>{captures++;if(blocked)throw Error('Close menu');return {accountId:account,reference,file:'isolated-fixture'};}};
 services.rollout={};services.browserFulfillment={authorize:async()=>{},markDelivered:async()=>marked++};
 const delivery=new DeliveryService(f.sessions,new Ledger(f.db.raw()),f.settings,f.adapter,{db:f.db,policy:f.policy,patternPack:f.pack,evidenceBuilder:async data=>{assert.equal(data.screenshots[0].reference,paid.id);return {signed:true};}});
 const repo=delivery.repo;repo.observe(paid,'live');repo.lock(paid.id,'buyer1','fixture','250','1000000');
 repo.intent(paid.id,0,{net:250n,command:250n,debit:250n},1000000n);repo.sent(paid.id,0);repo.verify(paid.id,0,{after:'999750'},null,'buyer1');repo.state(paid.id,'ALL_VERIFIED');repo.release(paid.id);
 await delivery.processOrder(paid);assert.equal(repo.get(paid.id).state,'ALL_VERIFIED');assert.match(repo.get(paid.id).reason,/Only proof capture/);
 await delivery.processOrder(next);assert.equal(f.payments.length,0);assert.equal(repo.chunks(next.id).length,0);
 blocked=false;await delivery.processOrder(paid);assert.equal(repo.get(paid.id).state,'DELIVERED');assert.equal(marked,1);assert.equal(captures,2);assert.equal(f.payments.length,0);
});

test('an existing queued delivery remains queued while startup waits for browser attachment',async t=>{
 const f=await fixture(t),order=f.order('queued1');f.delivery.repo.observe(order,'mock');f.adapter.hybrid=true;
 let deliveries=0;f.delivery.processOrder=async()=>{deliveries++;throw Error('Must wait for browser');};
 const poller=new OrderPoller(f.adapter,f.delivery,{db:f.db,settings:f.settings});poller.captureApiOrders=async()=>({raw:[order],orders:[order]});
 const result=await poller.poll();assert.equal(result.success,true);assert.equal(deliveries,0);assert.equal(f.delivery.repo.get(order.id).state,'DETECTED');assert.equal(f.payments.length,0);
});

test('unavailable payment frames enter a durable review hold after bounded capture retries',async t=>{
 const f=await fixture(t),order={...f.order('evidence1'),browserWorkflow:true};
 let captures=0,marked=0;
 services.gameBridge={screenshot:async()=>{captures++;throw Error('Verified receipt is not visible');}};
 services.rollout={};services.browserFulfillment={authorize:async()=>{},markDelivered:async()=>marked++};
 const options={db:f.db,policy:f.policy,patternPack:f.pack,evidenceBuilder:async()=>{throw Error('Unreachable');}};
 const create=()=>new DeliveryService(f.sessions,new Ledger(f.db.raw()),f.settings,f.adapter,options);
 const delivery=create(),repo=delivery.repo;
 repo.observe(order,'live');repo.lock(order.id,'buyer1','fixture','250','1000000');
 repo.intent(order.id,0,{net:250n,command:250n,debit:250n},1000000n);
 repo.sent(order.id,0);repo.verify(order.id,0,{after:'999750'},null,'buyer1');
 repo.state(order.id,'ALL_VERIFIED');repo.release(order.id);
 for(let attempt=0;attempt<3;attempt++){
   repo.db.prepare('UPDATE delivery_orders SET next_attempt_ms=0 WHERE id=?').run(order.id);
   await delivery.processOrder(order);
 }
 assert.equal(captures,3);assert.equal(repo.get(order.id).state,'NEEDS_OPERATOR');
 assert.match(repo.get(order.id).reason,/manual evidence review/);
 const restarted=create();restarted.recover();repo.recoverCompletionHolds();
 await restarted.processOrder(order);
 assert.equal(repo.get(order.id).state,'NEEDS_OPERATOR');
 assert.equal(captures,3);assert.equal(marked,0);assert.equal(f.payments.length,0);
});

test('unsafe legacy screenshot metadata cannot escape a signed-evidence review hold',async t=>{
 const f=await fixture(t),order={...f.order('evidence2'),browserWorkflow:true};
 let marked=0;
 services.gameBridge={};
 services.rollout={};services.browserFulfillment={authorize:async()=>{},markDelivered:async()=>{
   marked++;throw Object.assign(Error('Missing order-bound render geometry'),{code:'EVIDENCE_REVIEW'});
 }};
 const delivery=new DeliveryService(f.sessions,new Ledger(f.db.raw()),f.settings,f.adapter,
   {db:f.db,policy:f.policy,patternPack:f.pack});
 const repo=delivery.repo;repo.observe(order,'live');repo.lock(order.id,'buyer1','fixture','250','1000000');
 repo.intent(order.id,0,{net:250n,command:250n,debit:250n},1000000n);
 repo.sent(order.id,0);repo.verify(order.id,0,{after:'999750'},null,'buyer1');
 repo.state(order.id,'EVIDENCE_BUILT');repo.release(order.id);
 repo.db.prepare('UPDATE delivery_orders SET evidence=? WHERE id=?').run(JSON.stringify({signed:true,legacyFixture:true}),order.id);
 await delivery.processOrder(order);
 assert.equal(repo.get(order.id).state,'NEEDS_OPERATOR');
 repo.recover();repo.recoverCompletionHolds();await delivery.processOrder(order);
 assert.equal(repo.get(order.id).state,'NEEDS_OPERATOR');assert.equal(marked,1);assert.equal(f.payments.length,0);
});

for(const size of [10,25,50,100])test(size+' simultaneous orders preserve exact chunk totals after duplicate discovery',async t=>{
 const f=await fixture(t),orders=Array.from({length:size},(_,i)=>f.order('burst'+i));
 f.adapter.listOrders=async()=>[...orders,...orders];
 const poller=new OrderPoller(f.adapter,f.delivery,{db:f.db,settings:f.settings,mode:'mock'});
 for(let cycle=0;cycle<Math.ceil(size/4)+2;cycle++)await poller.poll();
 assert.equal(f.db.raw().prepare("SELECT count(*) n FROM delivery_orders WHERE state='DELIVERED'").get().n,size);
 assert.equal(f.payments.length,size*3);assert.equal(f.balance(),1000000n-BigInt(size)*250n);
 await poller.poll();assert.equal(f.payments.length,size*3);
});

test('restart after a complete verified journal resumes proof only; a partial journal stays held',async t=>{
 const f=await fixture(t);
 for(const [id,amount] of [['complete1',250n],['partial2',100n]]){
  const order=f.order(id),repo=f.delivery.repo;repo.observe(order,'mock');repo.lock(id,'buyer1','old','250','1000000');
  repo.intent(id,0,{net:amount,command:amount,debit:amount},1000000n);repo.sent(id,0);repo.verify(id,0,{after:String(1000000n-amount)},null,'buyer1');
  repo.recover();assert.equal(repo.get(id).state,id==='complete1'?'ALL_VERIFIED':'NEEDS_OPERATOR');
  await f.delivery.processOrder(order);assert.equal(f.payments.length,0);
 }
});

test('API discovery continues while the delivery worker waits and stops during shutdown',async t=>{
 const f=await fixture(t),poller=new OrderPoller({...f.adapter,hybrid:true},f.delivery,{db:f.db,settings:f.settings});
 let captures=0;poller.captureApiOrders=async()=>captures++;poller.isRunning=true;poller.busy=true;
 await poller.discoveryTick();assert.equal(captures,1);assert.equal(f.payments.length,0);
 poller.stop();await poller.discoveryTick();assert.equal(captures,1);
});

test('a page of closed orders cannot consume the validation budget for new funded orders',async t=>{
  const f=await fixture(t);
  const active=[f.order('working1'),f.order('working2')];
  const closed=Array.from({length:100},(_,i)=>({...f.order('closed'+i),status:'Canceled'}));
  const observed=[];
  const overlap=Promise.withResolvers();
  const adapter={...f.adapter,hybrid:true,normalizeObservation:value=>value,
    async prepareOrder(value){
      observed.push(value.id);
      if(value.id===active[0].id){
        await overlap.promise;
        throw Error('Simulated timeout in first room');
      }
      overlap.resolve();
      return value;
    }
  };
  const poller=new OrderPoller(adapter,f.delivery,{db:f.db,settings:f.settings});
  const valid=await poller.prepareHybridBatch([...closed,...active,active[1]]);
  assert.deepEqual(observed,active.map(value=>value.id));
  assert.deepEqual(valid.map(value=>value.id),[active[1].id]);
  assert.deepEqual(f.payments,[]);
});

test('new buyers and previously inspected waiting buyers both receive bounded turns',async t=>{
  const f=await fixture(t),seen=[];
  const waiting=Array.from({length:12},(_,i)=>f.order('waiting'+i));
  for(const order of waiting) {
    f.db.raw().prepare('INSERT INTO marketplace_observations VALUES(?,?,?,?,?)')
      .run(order.id,JSON.stringify({...order,routingReason:'Waiting for IGN'}),'fixture',1,1);
  }
  const fresh=Array.from({length:6},(_,i)=>f.order('fresh'+i));
  const adapter={...f.adapter,hybrid:true,normalizeObservation:value=>value,prepareOrder:async value=>{seen.push(value.id);return null;}};
  const poller=new OrderPoller(adapter,f.delivery,{db:f.db,settings:f.settings});
  await poller.prepareHybridBatch([...waiting,...fresh]);
  assert.equal(seen.filter(id=>id.startsWith('fresh')).length,2);
  assert.equal(seen.filter(id=>id.startsWith('waiting')).length,2);
  for(let i=0;i<5;i++)await poller.prepareHybridBatch([...waiting,...fresh]);
  assert.equal(new Set(seen.filter(id=>id.startsWith('waiting'))).size,12);
  assert.deepEqual(f.payments,[]);
});
