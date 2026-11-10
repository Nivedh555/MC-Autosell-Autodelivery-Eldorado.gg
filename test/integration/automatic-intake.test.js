'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {SettingsRegistry,loadDefaults} = require('../../settings/registry');
const profile = require('../../minecraft/donutsmp-profile');
const patterns = require('../../payments/payment-patterns');
const automatic = require('../../payments/automatic-intake');
const Database = require('../../db/database');
const {PaymentVerifier} = require('../../payments/payment-verifier');

function settings() {
  const registry = Object.create(SettingsRegistry.prototype); registry.definitions = new Map();
  const values = new Map(); registry.store={get:k=>values.get(k),set:(k,v)=>values.set(k,v)};
  loadDefaults(registry); return registry;
}

test('real registered settings can configure automatic linked-seller payouts without a setup page', async()=>{
  const s=settings(); await automatic.configure(s);const p=await s.get('payout.policy');
  assert.equal(p.enabled,true);assert.equal(p.addressMode,'linked-seller');
  assert.equal(p.maxPerTxFiatMicros,'10000000');assert.equal(p.maxPerDayFiatMicros,'50000000');
  assert.equal(await s.get('wallet.maxPerTxUsd'),0);assert.equal(await s.get('wallet.maxPerDayUsd'),0);
  await s.set('payout.policy',{...p,enabled:false},'fixture');assert.equal(await automatic.configure(s),false);
  assert.equal((await s.get('payout.policy')).enabled,false);
});

test('automatic payout defaults respect smaller existing wallet limits',async()=>{
 const s=settings();await s.set('wallet.maxPerTxUsd',2,'fixture');await s.set('wallet.maxPerDayUsd',3,'fixture');
 await automatic.configure(s);assert.equal((await s.get('payout.policy')).maxPerTxFiatMicros,'2000000');assert.equal((await s.get('payout.policy')).maxPerDayFiatMicros,'3000000');
});

test('bundled DonutSMP formats parse legacy receipts but reject chat, outgoing commands and partial matches',()=>{
  const pack=profile.profile();assert.equal(patterns.canMatch(pack),true);
  for (const line of ['TestPlayer paid you $1,500','You received $1500 from TestPlayer','[MVP+] .Steve has sent you $1.5K','You were paid $1500 by TestPlayer','$1500 has been credited from TestPlayer']) {
    assert.equal(patterns.matchCaptured(line,{position:'system'},pack).amountText,'1500');
    assert.equal(patterns.matchCaptured(line,{position:'chat'},pack),null);
    assert.equal(patterns.matchCaptured(line,{position:'system',sender:'player-uuid'},pack),null);
  }
  for(const line of ['<TestPlayer> TestPlayer paid you $1500','You paid TestPlayer $1500','announcement: TestPlayer paid you $1500','TestPlayer paid you $1500 extra text','TestPlayer sent you a teleport request']) assert.equal(patterns.matchCaptured(line,{position:'system'},pack),null);
});

test('automatic receipt support preserves a custom reviewed balance and incoming format',async()=>{
  const s=settings();const prior={balance:'^Balance: (?<amount>\\d+)$',source:'reviewed fixture',balanceCalibrated:true,calibrated:false,systemPositions:['system'],timeoutMs:80};
  await s.set('delivery.patternPack',prior,'fixture');await profile.configure(s);
  const pack=await s.get('delivery.patternPack');assert.equal(pack.balance,prior.balance);assert.equal(pack.calibrated,false);assert.equal(patterns.canMatch(pack),true);
  const custom={...pack,incoming:'^Custom (?<ign>TestPlayer) (?<amount>\\d+)$',incomingCalibrated:true};
  assert.equal(patterns.matchCaptured('TestPlayer paid you $1500',{position:'system'},custom),null);
  assert.equal(patterns.matchCaptured('Custom TestPlayer 1500',{position:'system'},custom).amountText,'1500');
});

test('automatic intake confirms a real-format receipt using exact self-balance fallback',async t=>{
  const db=await Database.open(':memory:');t.after(()=>db.close());const pack={...profile.profile(),timeoutMs:80};
  const bot=new EventEmitter();bot.username='FixtureBuyer';let balance=1000000;const commands=[];
  bot.chat=command=>{commands.push(command);queueMicrotask(()=>bot.emit('messagestr',command==='/bal'?'You have $ 1M':'FixtureBuyer has $ '+balance,'system'));};
  const verifier=new PaymentVerifier({db,patternPack:pack});
  await verifier.arm(bot,{saleId:'automatic',username:'TestPlayer',amount:1500,accountId:'buyer1'});balance+=1500;
  const result=await verifier.verifyPayment(bot,{saleId:'automatic',rawLine:'TestPlayer paid you $1,500',packet:{position:'system'}});
  assert.equal(result.confirmed,true);assert.deepEqual(commands,['/bal','/bal FixtureBuyer','/bal','/bal FixtureBuyer']);
});

test('automatic defaults never convert two rounded balances into payment proof',async t=>{
  const db=await Database.open(':memory:');t.after(()=>db.close());const pack={...profile.profile(),timeoutMs:80};
  const bot=new EventEmitter();bot.username='FixtureBuyer';bot.chat=command=>queueMicrotask(()=>bot.emit('messagestr',command==='/bal'?'You have $ 1M':'FixtureBuyer has $ 1M','system'));
  await assert.rejects(new PaymentVerifier({db,patternPack:pack}).arm(bot,{saleId:'rounded',username:'TestPlayer',amount:1500,accountId:'buyer1'}),/rounded balances/);
  assert.equal(db.raw().prepare('SELECT COUNT(*) n FROM intake_sales').get().n,0);
});
