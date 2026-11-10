'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const bitcoin = require('bitcoinjs-lib');
const {ECPairFactory} = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const Database = require('../../db/database');
const Ledger = require('../../ledger/ledger');
const Orders = require('../../db/repositories/orders');
const services = require('../../services');
const admission = require('../../sell/intake-admission');
const {PayoutService} = require('../../payments/payout-service');
const {PaymentVerifier} = require('../../payments/payment-verifier');
const {LtcWallet} = require('../../wallet/ltc-wallet');
const {NETWORK} = require('../../wallet/withdrawal-transaction');
const exchange = require('../../sell/exchange');
const pack = {calibrated:true,source:'isolated fixture',incomingSource:'reviewed fixture',balance:'^Balance: (?<amount>\\d+)$',incoming:'^Received \\$(?<amount>\\d+) from (?<ign>[A-Za-z0-9_]+)$',systemPositions:['system'],timeoutMs:80};

async function fixture(t) {
  const db = await Database.open(':memory:'); services.db = db; services.ledger = new Ledger(db.raw());
  const values = {'treasury.accountRoles':{buyer1:{role:'intake',holderAccount:'buyer1'}},'delivery.patternPack':pack,'payout.policy':{enabled:true,addressMode:'linked-seller',maxPerTxFiatMicros:'10000000',maxPerDayFiatMicros:'100000000'},'general.bot.paused':false,'wallet.maxPerTxUsd':0,'wallet.maxPerDayUsd':0,'treasury.forwarding':{}};
  services.settings = {get:async k=>values[k],getSync:k=>values[k]};
  services.store = {getSeller:()=>({ltcAddress:'fixture-address'}),getRate:()=>1,sendEnabled:()=>true,autosellPaused:()=>false,verifyEnabled:()=>false};
  services.rollout = {authorize:async()=>{}}; services.config = {buy:{maxPerSell:100},wallet:{sendEnabled:true},discord:{}};
  services.events = new EventEmitter(); services.sellManager = null;
  services.logger = {success:async()=>{},warn:async()=>{},error:async()=>{}};
  let reads = 0, sends = 0;
  services.wallet = {enabled:true,type:'segwit',isValidAddress:()=>true,usdToLitoshi:async usd=>Math.round(usd/50*1e8),cachedRate:()=>50,_availableUtxos:async()=>{reads++;return[{value:100000000,confirmed:true}];},_feeRate:async()=>2,send:async()=>{sends++;return{txid:'b'.repeat(64),fee:100};}};
  const bot = new EventEmitter(); bot.username = 'FixtureBuyer'; bot.chat = ()=>queueMicrotask(()=>bot.emit('messagestr','Balance: 100','system'));
  services.sessions = {acquire:async()=>({ready:async()=>{},getBot:()=>bot,release:()=>{},extend:()=>{}})};
  t.after(()=>{exchange.onAccountDisconnected('buyer1');services.sellManager=null;db.close();});
  return {db,bot,values,reads:()=>reads,sends:()=>sends};
}

test('100 simultaneous Sell Money requests admit one before wallet work; disconnect holds the receipt', async t=>{
  const f = await fixture(t);
  const results = await Promise.all(Array.from({length:100},(_,i)=>exchange.armMoneySell('user'+i,'Player'+i,1000000,null,'buyer1')));
  assert.equal(results.filter(r=>r.ready).length,1);
  assert.equal(results.filter(r=>!r.ready && /busy/.test(r.error)).length,99);
  assert.equal(f.reads(),1); assert.equal(f.sends(),0);
  assert.equal(f.db.raw().prepare('SELECT COUNT(*) n FROM intake_sales').get().n,1);
  const savedContext=JSON.parse(f.db.raw().prepare('SELECT context FROM intake_sales').get().context);
  assert.equal(savedContext.discordId,'user0');assert.equal(savedContext.payoutAddress,'fixture-address');assert.equal(savedContext.fiatMicros,'1000000');
  exchange.onAccountDisconnected('buyer1');
  assert.equal(admission.busy,false);
  assert.equal(f.db.raw().prepare('SELECT state FROM intake_sales').get().state,'NEEDS_OPERATOR');
  const retry = await exchange.armMoneySell('other','OtherPlayer',1000000,null,'buyer1');
  assert.equal(retry.ready,false); assert.match(retry.error,/unresolved/);
});

test('queued spawners take priority over new money requests without wallet traffic', async t=>{
  const f = await fixture(t); services.sellManager = {queue:['accepted-spawner']};
  const result = await exchange.armMoneySell('user','Player',1000000,null,'buyer1');
  assert.equal(result.ready,false); assert.match(result.error,/queued/); assert.equal(f.reads(),0);
});

test('spawner admission rejects duplicate clicks and bounds pending plus queued requests at 25', async t=>{
  const f = await fixture(t); const repo = new Orders(f.db.raw());
  const store = {getPrice:()=>1,saveOrder:o=>repo.saveOrder(o),getOrder:id=>repo.getOrder(id)};
  const SellManager = require('../../sell/manager'); const manager = new SellManager(store); manager.pause(); services.sellManager=manager;
  const input = {sellerDiscordId:'same',sellerUsername:'FixtureSeller',ltcAddress:'fixture-address',requested:1};
  const duplicates = await Promise.allSettled(Array.from({length:100},()=>manager.createOrder(input)));
  assert.equal(duplicates.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.reads(),1);
  const burst = await Promise.allSettled(Array.from({length:50},(_,i)=>manager.createOrder({...input,sellerDiscordId:'seller'+i})));
  assert.equal(burst.filter(r=>r.status==='fulfilled').length,24); assert.equal(manager.queue.length,25);
  const saved = repo.getOrder(manager.queue[0]);
  assert.equal(saved.sellerUsername,'FixtureSeller'); assert.equal(saved.ltcAddress,'fixture-address'); assert.equal(saved.requested,1); assert.equal(saved.priceUsd,1);
});

test('100 concurrent calls for a sale produce one payout and one settlement', async t=>{
  const f = await fixture(t); const service = new PayoutService();
  const input = {saleId:'duplicate-sale',ltcAddress:'fixture-address',usd:1,kind:'money',donut:1000000};
  const results = await Promise.all(Array.from({length:100},()=>service.payInstant('seller',input)));
  assert.equal(results.filter(r=>r.ok).length,100); assert.equal(f.sends(),1);
  assert.equal(f.db.raw().prepare('SELECT COUNT(*) n FROM seller_payout_settlements').get().n,1);
  assert.equal(services.ledger.query({entryType:'payout'}).length,1);
});

test('different concurrent payouts cannot exceed the daily cap', async t=>{
  const f = await fixture(t); f.values['payout.policy'].maxPerTxFiatMicros='1000000';f.values['payout.policy'].maxPerDayFiatMicros='1500000';
  const service = new PayoutService();
  const results = await Promise.all(['one','two'].map(saleId=>service.payInstant('seller',{saleId,ltcAddress:'fixture-address',usd:1,kind:'money'})));
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(f.sends(),1);
});

test('late and restarted RECEIVED sales cannot be armed or paid as a new sale', async t=>{
  const f = await fixture(t); const verifier = new PaymentVerifier({db:f.db,patternPack:pack});
  await verifier.arm(f.bot,{saleId:'late',username:'FixtureSeller',amount:1,accountId:'buyer1',expiresMs:Date.now()-1});
  const result = await verifier.verifyPayment(f.bot,{saleId:'late',rawLine:'Received $1 from FixtureSeller',packet:{position:'system'}});
  assert.equal(result.confirmed,false); assert.match(result.error,/expired/);
  f.db.raw().prepare("UPDATE intake_sales SET state='RECEIVED' WHERE id='late'").run();
  await assert.rejects(new PaymentVerifier({db:f.db,patternPack:pack}).arm(f.bot,{saleId:'new',username:'OtherPlayer',amount:1,accountId:'buyer1'}),/unresolved/);
});

test('uncertain real transaction builder persists signed bytes and reserves inputs across wallet restart', async t=>{
  const f = await fixture(t); const wallet = new LtcWallet();
  wallet.signer=ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32,3),{network:NETWORK});
  const own=bitcoin.payments.p2wpkh({pubkey:Buffer.from(wallet.signer.publicKey),network:NETWORK});
  wallet.enabled=true;wallet.address=own.address;wallet.output=own.output;wallet.type='segwit';wallet.inVbytes=68;
  const available=async()=>[{txid:'a'.repeat(64),vout:0,value:1000000,confirmed:true}];
  wallet._fetchUtxos=available;wallet._feeRate=async()=>2;wallet.getRate=async()=>50;wallet.usdToLitoshi=async()=>100000;wallet.cachedRate=()=>50;
  services.wallet=wallet;services.store.getSeller=()=>({ltcAddress:own.address});
  services.config.wallet={sendEnabled:true,spendUnconfirmed:false};
  let broadcasts=0;wallet._broadcast=async hex=>{
    broadcasts++;
    const row=f.db.raw().prepare('SELECT signed_hex,txid FROM payout_intents').get();
    assert.equal(row.signed_hex,hex);assert.equal(row.txid,bitcoin.Transaction.fromHex(hex).getId());
    assert.equal(f.db.raw().prepare('SELECT COUNT(*) n FROM payout_utxo_reservations').get().n,1);
    throw Error('connection closed after submission');
  };
  const service=new PayoutService();const input={saleId:'unknown-broadcast',ltcAddress:own.address,usd:1,kind:'money'};
  assert.equal((await service.payInstant('seller',input)).ok,false);
  assert.equal((await service.payInstant('seller',input)).ok,false);
  const restarted=new LtcWallet();restarted.address=own.address;restarted._fetchUtxos=available;
  assert.equal((await restarted._availableUtxos(false)).length,0);
  assert.equal((await new PayoutService().payInstant('seller',{...input,saleId:'different'})).ok,false);
  assert.equal(broadcasts,1);
});
