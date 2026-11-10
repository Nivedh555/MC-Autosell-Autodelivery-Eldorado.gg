'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const Database=require('../../db/database');const Ledger=require('../../ledger/ledger');const services=require('../../services');
const {PaymentVerifier}=require('../../payments/payment-verifier');
const pack={calibrated:true,balanceCalibrated:true,source:'isolated fixture',incomingSource:'owner reviewed fixture',balance:'^Balance: (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',incoming:'^Received \\$(?<amount>\\d+) from (?<ign>[A-Za-z0-9_]+)$',systemPositions:['system'],timeoutMs:80};
async function fixture(t){const db=await Database.open(':memory:');t.after(()=>db.close());let balance=100;const bot=new EventEmitter();bot.username='FixtureIntake';bot.chat=command=>{assert.equal(command,'/bal');queueMicrotask(()=>bot.emit('messagestr','Balance: '+balance,'system'));};return{db,bot,add:n=>balance+=n};}
test('incoming money needs a matching trusted receipt AND the exact fresh balance increase',async t=>{
  const f=await fixture(t);const verifier=new PaymentVerifier({db:f.db,patternPack:pack});
  await verifier.arm(f.bot,{saleId:'fixture-sale',username:'TestPlayer',amount:1000,accountId:'buyer1'});f.add(1000);
  const result=await verifier.verifyPayment(f.bot,{saleId:'fixture-sale',rawLine:'Received $1000 from testplayer',packet:{position:'system'}});
  assert.equal(result.confirmed,true);assert.equal(result.verifiedAmount,1000);
  assert.equal((await verifier.verifyPayment(f.bot,{saleId:'fixture-sale'})).confirmed,false);
});
test('a spoofed receipt or wrong balance delta cannot verify a sale',async t=>{
  for(const spoofed of [true,false]){const f=await fixture(t);const verifier=new PaymentVerifier({db:f.db,patternPack:pack});await verifier.arm(f.bot,{saleId:'fixture',username:'TestPlayer',amount:1000,accountId:'buyer1'});f.add(spoofed?1000:999);const result=await verifier.verifyPayment(f.bot,{saleId:'fixture',rawLine:'Received $1000 from TestPlayer',packet:{position:'system',sender:spoofed?'player-uuid':null}});assert.equal(result.confirmed,false);assert.equal(f.db.raw().prepare('SELECT state FROM intake_sales').get().state,'NEEDS_OPERATOR');}
});
test('concurrent arming and unresolved prior attempts remain blocked across restart',async t=>{
  const f=await fixture(t);const verifier=new PaymentVerifier({db:f.db,patternPack:pack});const first=verifier.arm(f.bot,{saleId:'one',username:'TestPlayer',amount:1000,accountId:'buyer1'});
  await assert.rejects(verifier.arm(f.bot,{saleId:'two',username:'OtherPlayer',amount:1000,accountId:'buyer1'}),/armed sale/);await first;
  await assert.rejects(new PaymentVerifier({db:f.db,patternPack:pack}).arm(f.bot,{saleId:'three',username:'TestPlayer',amount:1000,accountId:'buyer1'}),/unresolved receipt/);
});
test('intake can use calibrated balance and receipt formats without Eldorado outgoing-pay calibration',async t=>{
 const f=await fixture(t);const verifier=new PaymentVerifier({db:f.db,patternPack:{...pack,calibrated:false,balanceCalibrated:true,incomingCalibrated:true,success:undefined}});
 await verifier.arm(f.bot,{saleId:'incoming-only',username:'TestPlayer',amount:10,accountId:'buyer1'});f.add(10);
 assert.equal((await verifier.verifyPayment(f.bot,{saleId:'incoming-only',rawLine:'Received $10 from TestPlayer',packet:{position:'system'}})).confirmed,true);
});
test('Discord money sale verifies, pays once, and keeps stock on its single Buyer account',async t=>{
  const f=await fixture(t);services.db=f.db;services.ledger=new Ledger(f.db.raw());
  let rate=.01,payments=0,sales=0,released;const complete=new Promise(resolve=>{released=resolve;});
  const automaticPack={...require('../../minecraft/donutsmp-profile').profile(),balance:pack.balance,balanceDisplay:undefined,timeoutMs:80};
  const values={'treasury.accountRoles':{buyer1:{role:'intake',holderAccount:'buyer1'}},'delivery.patternPack':automaticPack,'payout.policy':{},'general.bot.paused':false,'wallet.maxPerTxUsd':0,'wallet.maxPerDayUsd':0,'treasury.forwarding':{}};
  services.settings={get:async key=>values[key],getSync:key=>values[key],set:async(key,value)=>{values[key]=value;}};
  services.store={getSeller:()=>({ltcAddress:'fixture-address',ign:'TestPlayer'}),getRate:()=>rate,recordSale:()=>sales++,verifyEnabled:()=>false,autosellPaused:()=>false,sendEnabled:()=>true};
  services.config={wallet:{sendEnabled:true},discord:{}};services.rollout={authorize:async()=>{}};
  services.wallet={enabled:true,type:'segwit',isValidAddress:()=>true,usdToLitoshi:async usd=>Math.round(usd/50*1e8),cachedRate:()=>50,_availableUtxos:async()=>[{value:100000000,confirmed:true}],_feeRate:async()=>2,send:async(_address,litoshi,authorization)=>{payments++;assert.equal(litoshi,20000);assert.equal(f.db.raw().prepare('SELECT state FROM payout_intents WHERE id=?').get(authorization.intentId).state,'BROADCAST_INTENT');return{txid:'a'.repeat(64),fee:100,litoshi};}};
  services.sessions={acquire:async()=>({ready:async()=>{},getBot:()=>f.bot,release:()=>released()})};services.treasury={acceptSale:async()=>{throw Error('Single account must not forward to itself');}};
  services.logger={info:async()=>{},success:async()=>{},warn:async()=>{},error:async()=>{}};services.events=new EventEmitter();services.discordClient={users:{fetch:async()=>({send:async()=>{}})}};
  f.db.raw().prepare('INSERT INTO sellers(discord_id,stats) VALUES(?,?)').run('fixture-discord',JSON.stringify({cashedOutUsd:0,pending:{moneyDonut:1000000,moneyUsd:.01,skellyCount:0,skellyUsd:0}}));
  const exchange=require('../../sell/exchange');const ready=await exchange.armMoneySell('fixture-discord','TestPlayer',1000000,{editReply:async()=>{}},'buyer1');assert.equal(ready.ready,true);
  assert.equal(values['payout.policy'].addressMode,'linked-seller');assert.equal(values['payout.policy'].enabled,true);
  rate=99;f.add(1000000);const receipt={username:'testplayer',rawLine:'Received $1000000 from testplayer',packet:{position:'system'}};
  await exchange.onPayment(receipt,{accountId:'buyer1',bot:f.bot});await complete;
  await exchange.onPayment(receipt,{accountId:'buyer1',bot:f.bot});assert.equal(payments,1);assert.equal(sales,1);assert.equal(f.db.raw().prepare('SELECT state FROM payout_intents').get().state,'BROADCAST');
  const stats=JSON.parse(f.db.raw().prepare('SELECT stats FROM sellers WHERE discord_id=?').get('fixture-discord').stats);assert.equal(stats.cashedOutUsd,.01);assert.equal(stats.pending.moneyDonut,0);assert.equal(f.db.raw().prepare('SELECT count(*) n FROM seller_payout_settlements').get().n,1);
});
