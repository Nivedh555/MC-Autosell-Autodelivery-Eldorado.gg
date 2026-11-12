'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VerifiedPayments } = require('../../minecraft/verified-payments');
const { profile,configure } = require('../../minecraft/donutsmp-profile');
const { splitAmount,deliveryPolicy } = require('../../minecraft/verified-payments');
const { rateFromEvidence,observedRate } = require('../../minecraft/donutsmp-tax');
const Database = require('../../db/database');

function botFor(receipt, position = 'system') {
  const bot = new EventEmitter();
  bot.chat = command => queueMicrotask(() => {
    if (command.startsWith('/pay ')) bot.emit('messagestr', receipt, position);
    if (command === '/bal') bot.emit('messagestr', 'You have $ 182,030,515', 'system');
  });
  return bot;
}

test('DonutSMP receipt tax and exact debit jointly verify the payment', async () => {
  const pack = { ...profile(), timeoutMs: 40 };
  const verifier = new VerifiedPayments(pack);
  const result = await verifier.exclusive(botFor('You paid 14him $ 10M (+$ 200K tax)'), bot =>
    verifier.pay(bot, '14him', { command: 10000000n, debit: 10000000n }, 192230515n));
  assert.equal(result.verified, true);
  assert.equal(result.expectedDebit, '10200000');
  assert.equal(result.signal.tax, '200000');
});

test('DonutSMP taxed receipt still rejects wrong recipient or untrusted position', async () => {
  const pack = { ...profile(), timeoutMs: 20 };
  for (const [line, position] of [
    ['You paid OtherGuy $ 10M (+$ 200K tax)', 'system'],
    ['You paid 14him $ 10M (+$ 200K tax)', 'chat'],
  ]) {
    const verifier = new VerifiedPayments(pack);
    const result = await verifier.exclusive(botFor(line, position), bot =>
      verifier.pay(bot, '14him', { command: 10000000n, debit: 10000000n }, 192230515n));
    assert.equal(result.verified, false);
  }
});

test('DonutSMP taxed receipt rejects a different sender debit', async () => {
  const pack = { ...profile(), timeoutMs: 40 };
  const verifier = new VerifiedPayments(pack);
  const result = await verifier.exclusive(botFor('You paid 14him $ 10M (+$ 100K tax)'), bot =>
    verifier.pay(bot, '14him', { command: 10000000n, debit: 10000000n }, 192230515n));
  assert.equal(result.verified, false);
  assert.equal(result.expectedDebit, '10100000');
});

test('funded order is a strict total debit budget after observed tax', () => {
  const parts=splitAmount('10000000',deliveryPolicy({taxMode:'sender_budget',taxBasisPoints:'0',maxPay:'100000000'},200));
  assert.equal(parts[0].command,9803922n);
  assert.equal(parts[0].debit,10000000n);
  assert.equal(parts[0].net,10000000n);
  assert.throws(()=>deliveryPolicy({taxMode:'sender_budget'},undefined),/no verified recent receipt/);
});

test('tax inference requires trusted receipt, exact amount and exact debit', () => {
  const evidence={line:'You paid 14him $ 10M (+$ 200K tax)',recipient:'14him',command:'10000000',debit:'10200000'};
  assert.equal(rateFromEvidence(evidence),200);
  assert.equal(rateFromEvidence({...evidence,recipient:'SomeoneElse'}),null);
  assert.equal(rateFromEvidence({...evidence,position:'chat'}),null);
  assert.equal(rateFromEvidence({...evidence,debit:'10000000'}),null);
});

test('recent uncertain payment journal can establish tax without authorizing a resend', async t => {
  const db=await Database.open(':memory:');t.after(()=>db.close());const raw=db.raw();
  const id='tax-fixture';
  raw.prepare('INSERT INTO delivery_orders(id,fingerprint,payload,state,mode,account_id,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,'fixture',JSON.stringify({id,buyerIgn:'14him',amount:'10000000'}),'NEEDS_OPERATOR','live','seller1',Date.now(),Date.now());
  raw.prepare('INSERT INTO delivery_chunks(order_id,chunk_index,amount,command_amount,debit,state,before_balance,idempotency_key) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,0,'10000000','10000000','10000000','PAY_SENT','192230515',id+':0');
  const events=[['command',{command:'/pay 14him 10000000'}],['chat',{raw:'You paid 14him $ 10M (+$ 200K tax)',position:'system',sender:null}],['command',{command:'/bal'}],['PAY_UNCERTAIN',{before:'192230515',after:'182030515',delta:'10200000'}]];
  for(const [kind,data] of events)raw.prepare('INSERT INTO delivery_events(order_id,kind,data,wall_ms,monotonic_ns) VALUES(?,?,?,?,?)').run(id,kind,JSON.stringify(data),1,'1');
  assert.equal(observedRate(raw,'seller1').basisPoints,200);
  assert.equal(raw.prepare('SELECT state FROM delivery_chunks WHERE order_id=?').get(id).state,'PAY_SENT');
  const policy={calibrated:true,source:'fixture',orderAmountMode:'command',taxMode:'sender_budget',taxBasisPoints:'0',maxPay:'100000000',maxChunks:10,unitSize:'1000000',offerId:'offer',gameId:'donut',serverId:'main',paidStatuses:['FUNDED'],cooldownMs:0,markRetryMs:0,markEscalateMs:0};
  const order={buyerIgn:'14him',amount:'10000000',unitSize:'1000000',offerId:'offer',gameId:'donut',serverId:'main',status:'FUNDED'};
  const {DeliveryService}=require('../../marketplace/delivery-service');
  assert.doesNotThrow(()=>DeliveryService.prototype._validate.call({repo:{db:raw},options:{mode:'live'}},order,policy));
  const ListingManager=require('../../marketplace/listing-manager').ListingManager;
  assert.equal(ListingManager.prototype.deliverableStock.call({db:raw},10000000n,policy,1000000n),10000000n);
  raw.prepare('DELETE FROM delivery_events WHERE order_id=?').run(id);
  assert.throws(()=>DeliveryService.prototype._validate.call({repo:{db:raw},options:{mode:'live'}},order,policy),/no verified recent receipt/);

});

test('bundled legacy payment profile and policy migrate to tax-aware budget mode',async()=>{
  const defaults=profile();
  const legacySuccess=defaults.success.replace('(?: \\(\\+\\$ (?<taxAmount>[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)(?<taxUnit>[KkMmBbTt])? tax\\))?','');
  const values=new Map([
    ['mc.server.host','donutsmp.net'],
    ['delivery.patternPack',{...defaults,success:legacySuccess}],
    ['delivery.policy',{source:defaults.source,taxMode:'buyer',taxBasisPoints:'0',orderAmountMode:'command'}],
  ]);
  const settings={get:async key=>values.get(key),set:async(key,value)=>values.set(key,value)};
  assert.equal(await configure(settings),true);
  assert.equal(values.get('delivery.policy').taxMode,'sender_budget');
  assert.equal(values.get('delivery.patternPack').success,defaults.success);
});
