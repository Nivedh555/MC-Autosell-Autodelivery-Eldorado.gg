'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {reservedCoins}=require('../../marketplace/listing-reservations');
test('queued orders reserve their unpaid amount once, including verified partial payments',()=>{
 const pending=[{id:'one',amount:'100000000'},{id:'two',amount:'200000000'}];
 assert.equal(reservedCoins(pending,[{id:'one'}],id=>id==='one'?{amount:'100000000',chunks:[{amount:'40000000',state:'PAY_VERIFIED'}]}:null),260000000n);
 assert.throws(()=>reservedCoins([{id:'one',amount:'100'}],[],()=>({state:'NEEDS_OPERATOR'})),/reconciliation/);
 assert.throws(()=>reservedCoins([{id:'one',amount:'100'}],[],()=>({chunks:[{state:'PAY_SENT'}]})),/reconciliation/);
 assert.throws(()=>reservedCoins([],[{id:'unknown'}],()=>null),/no verified currency/);
});

test('a closed order releases its listing reservation only when the local debit is settled',async t=>{
 const Database=require('../../db/database'),{DeliveryRepository}=require('../../db/repositories/delivery');
 const {OfferQueue}=require('../../marketplace/offer-queue');
 const db=await Database.open(':memory:');t.after(()=>db.close());
 const repo=new DeliveryRepository(db),queue=new OfferQueue(db);
 for(const id of ['uncertain','verified']){
   repo.observe({id,amount:'100',buyerIgn:'Fixture',offerId:'offer'},'live');
   repo.intent(id,0,{net:100n,command:100n,debit:100n},500n);repo.sent(id,0);
   if(id==='verified')repo.verify(id,0,{after:'400'},null,'seller1');
   repo.applyMarketplaceStatus(id,'Canceled');
 }
 assert.deepEqual(queue.unresolved('offer').map(row=>row.id),['uncertain']);
 const execution=id=>({state:repo.get(id).state,amount:'100',chunks:repo.chunks(id)});
 assert.equal(reservedCoins([{id:'verified',amount:'100'}],[],execution),0n);
 assert.throws(()=>reservedCoins([],queue.unresolved('offer'),execution),/unresolved debit/);
});

test('an empty queue cannot reopen an offer advertising more money than the seller owns',async()=>{
 const controls=require('../../treasury/trading-controls'),previous={global:controls.globallyEnabled,allowed:controls.deliveryAllowed};
 controls.globallyEnabled=async()=>true;controls.deliveryAllowed=async()=>({allowed:true});
 try{
  let quantity='500000000';const calls=[],policy={offerId:'offer',observedSellerHref:'seller',apiBinding:{gameId:'donut',unitCoins:'1000000'}};
  const manager={settings:{},db:{prepare:()=>({get:()=>undefined})},adapter:{services:{offerQueue:{active:()=>({account_id:'seller1'}),unresolved:()=>[]}},contract:{statuses:{paid:['Paid']}},getOffer:async()=>({id:'offer',sellerHref:'seller',gameId:'donut',unitCoins:'1000000',quantityCoins:quantity,minOrder:'100'}),normalizeOffer:x=>x,pauseOffer:async()=>calls.push('pause'),resumeOffer:async()=>calls.push('resume')},save:()=>{}};
  const listings=new(require('../../marketplace/hybrid-listings').HybridListings)(manager);
  listings.balances=async()=>({balances:new Map([['seller1',{balance:200000000n,available:200000000n,threshold:100000000n}]]),eligible:['seller1']});listings.freshOrders=async()=>({orders:[]});
  assert.equal(await listings.manual(policy),false);assert.deepEqual(calls,['pause']);
  calls.length=0;quantity='100000000';assert.equal(await listings.manual(policy),true);assert.deepEqual(calls,['resume']);
 }finally{controls.globallyEnabled=previous.global;controls.deliveryAllowed=previous.allowed;}
});
test('existing offer stays active with pending orders only when advertised stock is fully funded',async()=>{
 const controls=require('../../treasury/trading-controls'),originalGlobal=controls.globallyEnabled,originalAllowed=controls.deliveryAllowed;
 controls.globallyEnabled=async()=>true;controls.deliveryAllowed=async()=>({allowed:true});
 try{
  const calls=[],policy={offerId:'offer',observedSellerHref:'seller',apiBinding:{gameId:'donut',unitCoins:'1000000'}};
  let balance=504000000n,amount='100000000';
  const adapter={services:{offerQueue:{active:()=>({account_id:'seller1'}),unresolved:()=>[{id:'order'}]},deliveryService:{repo:{get:()=>null}}},contract:{statuses:{paid:['Paid']}},getOffer:async()=>({id:'offer',sellerHref:'seller',gameId:'donut',unitCoins:'1000000',quantityCoins:'400000000',minOrder:'100'}),normalizeOffer:x=>x,resumeOffer:async()=>calls.push('resume'),pauseOffer:async()=>calls.push('pause')};
  const manager={adapter,settings:{},save:(...x)=>calls.push(x),db:{prepare:()=>({get:()=>undefined})}};
  const listings=new(require('../../marketplace/hybrid-listings').HybridListings)(manager);
  listings.balances=async()=>({balances:new Map([['seller1',{balance,available:balance}]])});
  listings.freshOrders=async()=>({orders:[{id:'order',offerId:'offer',apiStatus:'Paid',amount}]});
  assert.equal(await listings.manual(policy),true);assert.equal(calls[0],'resume');assert.equal(calls[1][3].reserved,'100000000');
  calls.length=0;balance=499000000n;assert.equal(await listings.manual(policy),false);assert.deepEqual(calls,['pause']);
  calls.length=0;balance=504000000n;amount=null;assert.equal(await listings.manual(policy),false);assert.deepEqual(calls,['pause']);
 }finally{controls.globallyEnabled=originalGlobal;controls.deliveryAllowed=originalAllowed;}
});
