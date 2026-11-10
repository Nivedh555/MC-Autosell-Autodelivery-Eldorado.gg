'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Database = require('../../db/database');
const Ledger = require('../../ledger/ledger');
const services = require('../../services');
const { DeliveryService } = require('../../marketplace/delivery-service');
const { OrderPoller } = require('../../marketplace/order-poller');

async function fixture(t) {
  const db = await Database.open(':memory:'); t.after(() => db.close()); services.db = db;
  services.pairManager = null; services.offerQueue = null; services.browserBridge = null; services.browserFulfillment = null;
  services.listingManager = null; services.chatScheduler = null; services.store = null; services.ops = null;
  let balance = 10000n; const payments = []; let ack = 0; let failAck = false; let dropConfirmation = false;
  const bot = new EventEmitter(); bot.username = 'FixtureHolder';
  bot.chat = command => queueMicrotask(() => {
    if (command === '/bal') bot.emit('messagestr', 'Balance: ' + balance, 'system');
    else if (command.startsWith('/pay ')) { const [, ign, amount] = command.split(' '); payments.push(command); balance -= BigInt(amount); if (!dropConfirmation) bot.emit('messagestr', `Paid ${amount} to ${ign}`, 'system'); }
  });
  const policy = { calibrated: true, source: 'isolated test fixture', holderAccount: 'buyer1', offerId: 'offer-fixture', gameId: 'donut', serverId: 'main', unitSize: '1', paidStatuses: ['FUNDED'], maxPay: '1000', maxChunks: 20, taxBasisPoints: 0, taxMode: 'none', reserve: '0', cooldownMs: 0, markRetryMs: 0, markEscalateMs: 10000, bedrockPrefix: '.' };
  const pack = { calibrated: true, source: 'isolated test fixture', balance: '^Balance: (?<amount>\\d+)$', success: '^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$', timeoutMs: 50, systemPositions: ['system'] };
  const settings = { get: async key => ({ 'general.bot.paused': false, 'eldorado.order.auto_deliver': true, 'delivery.policy': policy, 'delivery.patternPack': pack })[key] };
  const order = { id: 'order-fixture', offerId: policy.offerId, gameId: policy.gameId, serverId: policy.serverId, buyerIgn: 'FixtureBuyer', buyerMarketplaceId: 'buyer-fixture', amount: '2500', unitSize: '1', status: 'FUNDED' };
  const adapter = { contract: { statuses: { paid: ['FUNDED'] } }, listOrders: async () => [order], getOrder: async () => order, markDelivered: async () => { ack++; if (failAck) throw Error('Fixture acknowledgement unavailable'); } };
  const sessions = { acquire: async () => ({ ready: async () => {}, getBot: () => bot, release() {} }) };
  const ledger = new Ledger(db.raw());
  const delivery = new DeliveryService(sessions, ledger, settings, adapter, { db, mode: 'mock', policy, patternPack: pack, evidenceBuilder: async () => ({ fixture: true }) });
  return { db, settings, order, adapter, delivery, payments, ack: () => ack, failAck: value => { failAck = value; }, dropConfirmation: () => { dropConfirmation = true; } };
}

test('funded order runs through exact payment chunks, evidence and acknowledgement once', async t => {
  const f = await fixture(t); assert.equal(await f.delivery.processOrder(f.order), true);
  assert.deepEqual(f.payments, ['/pay FixtureBuyer 1000', '/pay FixtureBuyer 1000', '/pay FixtureBuyer 500']);
  assert.equal(f.delivery.repo.get(f.order.id).state, 'DELIVERED'); assert.equal(f.ack(), 1);
  assert.equal(await f.delivery.processOrder(f.order), true); assert.equal(f.payments.length, 3); assert.equal(f.ack(), 1);
});

test('marketplace acknowledgement retry cannot repeat already verified payments', async t => {
  const f = await fixture(t); f.failAck(true);
  assert.equal(await f.delivery.processOrder(f.order), false); assert.equal(f.delivery.repo.get(f.order.id).state, 'MARK_DELIVERED_PENDING');
  f.failAck(false); assert.equal(await f.delivery.processOrder(f.order), true); assert.equal(f.payments.length, 3); assert.equal(f.ack(), 2);
});

test('missing payment confirmation latches an operator hold and prevents automatic resend', async t => {
  const f = await fixture(t); f.dropConfirmation();
  assert.equal(await f.delivery.processOrder(f.order), false); assert.equal(f.payments.length, 1);
  assert.equal(f.delivery.repo.get(f.order.id).state, 'NEEDS_OPERATOR');
  assert.equal(await f.delivery.processOrder(f.order), false); assert.equal(f.payments.length, 1); assert.equal(f.ack(), 0);
});

test('unfunded or mismatched offer cannot send payment commands', async t => {
  const f = await fixture(t);
  assert.equal(await f.delivery.processOrder({ ...f.order, status: 'PENDING' }), false); assert.equal(f.payments.length, 0);
  const other = { ...f.order, id: 'other-order', offerId: 'wrong-offer' };
  assert.equal(await f.delivery.processOrder(other), false); assert.equal(f.payments.length, 0);
});

test('read-only order polling and non-funded ingestion do not admit a payment', async t => {
  const f = await fixture(t); const poller = new OrderPoller(f.adapter, f.delivery, { db: f.db, settings: f.settings, mode: 'mock' });
  const result = await poller.poll({ inspect: true }); assert.equal(result.success, true); assert.equal(f.payments.length, 0); assert.equal(f.delivery.repo.get(f.order.id), undefined);
  assert.equal(await poller.processDiscoveredOrder({ ...f.order, status: 'CANCELLED' }), false); assert.equal(f.payments.length, 0);
});

test('delivery renews its session while marketplace preparation is slow and stops renewal afterward',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setInterval']});let renewals=0,released=0;
  const acquire=f.delivery.sessionManager.acquire;
  f.delivery.sessionManager.acquire=async()=>({...await acquire(),extend:()=>{renewals++;},release:()=>{released++;}});
  services.listingManager={beforeDelivery:async()=>{t.mock.timers.tick(60000);assert.ok(renewals>=5);}};
  assert.equal(await f.delivery.processOrder(f.order),true);assert.equal(released,1);
  const last=renewals;t.mock.timers.tick(60000);assert.equal(renewals,last);
});

test('consecutive post-capture poll failures retain backoff until the entire poll succeeds',async t=>{
  const f=await fixture(t);f.adapter.hybrid=true;f.adapter.normalizeObservation=data=>data;f.adapter.prepareOrder=async()=>f.order;
  services.browserBridge={status:()=>({connected:true,state:'ATTACHED_PAUSED'})};
  const poller=new OrderPoller(f.adapter,f.delivery,{db:f.db,settings:f.settings});
  poller.captureApiOrders=async()=>({raw:[f.order],orders:[f.order]});
  poller.processDiscoveredOrder=async()=>{throw Error('Fixture downstream failure');};
  assert.equal((await poller.poll()).success,false);assert.equal((await poller.poll()).success,false);
  assert.equal(poller.errorCount,2);
  poller.blockedReason='Previous setup blocker';
  const read=await poller.poll({inspect:true});assert.equal(read.success,true);assert.equal(poller.errorCount,0);assert.equal(poller.blockedReason,null);
});

test('hybrid startup records orders without processing them while the browser is disconnected',async t=>{
  const f=await fixture(t);f.adapter.hybrid=true;
  const poller=new OrderPoller(f.adapter,f.delivery,{db:f.db,settings:f.settings});
  poller.captureApiOrders=async()=>({raw:[f.order],orders:[f.order]});
  poller.processDiscoveredOrder=async()=>{throw Error('Must not process disconnected orders');};
  const result=await poller.poll();assert.equal(result.success,true);assert.match(result.message,/Waiting for the seller browser/);
  assert.equal(f.delivery.repo.get(f.order.id),undefined);assert.equal(f.payments.length,0);
});
