'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const services = require('../../services');
const AccountClient = require('../../minecraft/account-client');
const stock = require('../../minecraft/stock');
const sweep = require('../../minecraft/sweep');
services.settings = { getSync: () => undefined };
services.config = { mc: {} };
services.logger = { info() {}, warn() {}, error() {}, minecraft() {} };
services.sellManager = { activeId: null };

function fakeClient() {
  const client = new AccountClient('buyer1');
  const bot = new EventEmitter(); bot.inventory = new EventEmitter();
  bot.inventory.items = () => []; bot.inventory.slots = []; bot.username = 'OfflineTest';
  bot.chat = () => {}; client.bot = bot; client.state = AccountClient.STATE.IDLE; client._shouldRun = true;
  client._recordChat = () => {}; client._onUsernameDetected = () => {};
  client.antiAfk = { start() {}, stop() {} };
  return { client, bot };
}

test('raw home and ec commands never recursively orchestrate storage', () => {
  const { client, bot } = fakeClient(); let commands = 0; let storage = 0;
  bot.chat = () => commands++; client.handleHomeTeleportAndSync = () => { storage++; };
  client.chat('/home 1'); client.chat('/ec');
  assert.equal(commands, 2); assert.equal(storage, 0);
});

test('overlapping auto-vault and home tasks share one storage operation', async () => {
  const { client } = fakeClient(); let calls = 0; let release;
  client._handleHomeTeleportAndSync = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { success: true }; };
  const first = client.handleHomeTeleportAndSync(); const second = client.syncAndDepositEnderChest(true);
  assert.equal(first, second); await Promise.resolve(); assert.equal(calls, 1); release();
  assert.equal((await first).success, true); assert.equal(client._storageTask, null);
});

test('respawn preserves delivery state and does not schedule duplicate initialization', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, bot } = fakeClient(); client.role = 'secondary'; client._registerHandlers();
  let sequences = 0; client.runSpawnSequence = async () => { sequences++; };
  client._consecutiveFailures = 4; bot.emit('spawn'); client.state = AccountClient.STATE.DELIVERING; bot.emit('spawn');
  assert.equal(client.state, AccountClient.STATE.DELIVERING); assert.equal(client._consecutiveFailures, 4);
  t.mock.timers.tick(1200); assert.equal(sequences, 1);
  client._shouldRun = false; bot.emit('end', 'test end');
});

test('successful pathfinding cancels its abort timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let stopped = 0;
  await stock.gotoWithTimeout({ pathfinder: { goto: async () => {}, stop: () => { stopped++; } } }, {}, 100);
  t.mock.timers.tick(200); assert.equal(stopped, 0);
});

test('an unrelated container is never reused or cached as Ender Chest', async () => {
  const furnace = { type: 'minecraft:furnace', inventoryStart: 3, containerItems: () => [] };
  assert.equal(stock.isVerifiedEnderChest(furnace), false);
  const bot = { currentWindow: furnace, registry: { blocksByName: {} } };
  await assert.rejects(stock.openNearbyEnderChest(bot), /ender_chest block id/);
  stock._cacheEnderChest(bot, furnace); assert.equal(bot.latestEnderChest, undefined);
});

test('a full chest and accepted no-op shift-click never report a successful deposit', async () => {
  const original = stock.openNearbyEnderChest;
  const { client, bot } = fakeClient();
  const item = { name: 'spawner', displayName: 'Spawner', type: 42, count: 5, slot: 9 };
  bot.inventory.items = () => [item];
  const container = { inventoryStart: 27, inventoryEnd: 27, containerItems: () => [], deposit: async () => { throw Error('full'); }, close() {} };
  bot.clickWindow = async () => {};
  stock.openNearbyEnderChest = async () => container;
  try { const result = await client.syncAndDepositEnderChest(); assert.equal(result.depositedCount, 0); assert.equal(result.success, false); }
  finally { stock.openNearbyEnderChest = original; }
});

test('explicit missing-home message stops storage teleport', async () => {
  const bot = new EventEmitter(); bot.registry = { blocksByName: {} };
  bot.chat = () => bot.emit('messagestr', 'Home does not exist');
  assert.equal(await sweep.goHomeRobust(bot, 1), false);
  assert.equal(bot.listenerCount('messagestr'), 0);
});

const sessions = require('../../minecraft/session-manager');
after(() => sessions.shutdownAll());
test('always-on mode changes cancel a previously armed idle logout', () => {
  const manager = new sessions.SessionManager(); const client = new EventEmitter(); let disconnected = 0;
  client.isOnline = () => true; client.disconnect = async () => { disconnected++; };
  manager.clients.set('buyer1', client); manager.states.set('buyer1', 'READY');
  let mode = 'lease'; manager.getMode = () => mode;
  manager._evaluateAccountConnection('buyer1'); assert.equal(manager.graceTimers.has('buyer1'), true);
  mode = 'always_on'; manager._evaluateAccountConnection('buyer1');
  assert.equal(manager.graceTimers.has('buyer1'), false); assert.equal(disconnected, 0);
  manager.setManualStop('buyer1'); manager.states.set('buyer1', 'DISCONNECTED'); let connects = 0; client.connect = async () => { connects++; };
  manager._evaluateAccountConnection('buyer1'); assert.equal(connects, 0); clearInterval(manager.watchdogInterval);
});

test('inventory updateSlot detects pickups, item replacement, and ignores stale connections', () => {
  const {client,bot}=fakeClient();client._registerHandlers();let vaults=0;const pickups=[];
  client.scheduleAutoVault=()=>{vaults++;};client.on('itemPickup',event=>pickups.push(event));
  const stone={type:1,count:64,name:'stone',displayName:'Stone'};
  const spawner={type:42,count:2,name:'spawner',displayName:'Skeleton Spawner'};
  bot.inventory.emit('updateSlot',9,stone,spawner);
  bot.inventory.emit('updateSlot',9,spawner,{...spawner,count:5});
  bot.inventory.emit('updateSlot',9,{...spawner,count:5},spawner);
  assert.deepEqual(pickups.map(event=>event.count),[2,3]);assert.equal(vaults,2);
  client.bot=new EventEmitter();bot.inventory.emit('updateSlot',9,null,spawner);
  assert.equal(vaults,2);client._shouldRun=false;client.bot=bot;bot.emit('end','test end');
});

test('an explicit ban stops reconnects even without a session-manager listener',()=>{
  const {client,bot}=fakeClient();client._registerHandlers();
  bot.emit('kicked',{text:'You are temporarily banned. Ban ID: fixture'});
  assert.equal(client._shouldRun,false);bot.emit('end','kicked');
  assert.equal(client._reconnectTimer,null);assert.equal(client._watchdog,null);
});

test('verified Ender Chest cache follows slot changes and detaches after close',async()=>{
  const {client,bot}=fakeClient();bot._clientRef=client;
  let contents=[{slot:0,type:42,name:'spawner',count:2}];
  const chest=new EventEmitter();chest.title='Ender Chest';chest.containerItems=()=>contents;
  chest.close=()=>bot.emit('windowClose',chest);bot.currentWindow=null;
  bot.registry={blocksByName:{ender_chest:{id:1}}};bot.findBlocks=()=>[];
  bot.chat=()=>{bot.currentWindow=chest;bot.emit('windowOpen',chest);};
  const previousEvents=services.events;services.events=new EventEmitter();
  try{
    await stock.openNearbyEnderChest(bot);assert.equal(client.latestEnderChest[0].count,2);
    contents=[{...contents[0],count:7}];chest.emit('updateSlot',0,null,contents[0]);
    assert.equal(client.latestEnderChest[0].count,7);
    chest.close();assert.equal(chest.listenerCount('updateSlot'),0);
    contents=[];chest.emit('updateSlot',0,null,null);assert.equal(client.latestEnderChest[0].count,7);
  }finally{services.events=previousEvents;}
});
