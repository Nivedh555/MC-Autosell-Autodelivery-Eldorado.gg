'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const services=require('../../services');
const sessions=require('../../minecraft/session-manager');
services.settings={getSync:()=>undefined};
after(()=>sessions.shutdownAll());
function fixture(t,online=true){
  const manager=new sessions.SessionManager(),client=new EventEmitter();
  client.bot={username:'Fixture'};client.isOnline=()=>online;client.connect=async()=>{};client.disconnect=async()=>{};
  manager.clients.set('buyer1',client);manager.states.set('buyer1',online?'READY':'CONNECTING');manager.getMode=()=> 'always_on';
  t.after(()=>manager.shutdownAll());return {manager,client};
}
test('expired ready leases cannot expose the bot or be revived by extension',async t=>{
  const {manager}=fixture(t);const lease=await manager.acquire('buyer1','fixture');await lease.ready();
  lease.expiresAt=Date.now()-1;
  await assert.rejects(lease.ready(),/expired|released/i);assert.throws(()=>lease.getBot(),/expired|released/i);
  lease.extend(60000);assert.equal(lease.isValid(),false);
});
test('releasing a pending lease rejects its wait immediately',async t=>{
  const {manager}=fixture(t,false);const lease=await manager.acquire('buyer1','fixture');
  const waiting=lease.ready(50);lease.release();await assert.rejects(waiting,/released/i);
});
test('disconnect invalidates already ready leases instead of binding them to a new bot',async t=>{
  const {manager,client}=fixture(t);const lease=await manager.acquire('buyer1','fixture');await lease.ready();
  manager._failPendingLeases('buyer1',Error('Disconnected fixture'));client.bot={username:'Replacement'};
  assert.equal(lease.isValid(),false);assert.throws(()=>lease.getBot(),/Disconnected|released/i);
  assert.equal(manager.getLeases('buyer1').length,0);
});
test('a lease rejects a replaced bot even before the end handler runs',async t=>{
  const {manager,client}=fixture(t);const lease=await manager.acquire('buyer1','fixture');await lease.ready();
  client.bot={username:'Replacement'};assert.throws(()=>lease.getBot(),/changed|disconnected/i);
});
test('manual logout prevents new jobs from acquiring the online account',async t=>{
  const {manager}=fixture(t);manager.setManualStop('buyer1');
  await assert.rejects(manager.acquire('buyer1','fixture'),/manually|logged out/i);
  assert.equal(manager.getLeases('buyer1').length,0);
});
test('offline Fabric account waits for the paired game without repeated connection attempts',async t=>{
  const previousBridge=services.gameBridge,previousEvents=services.events;
  services.gameBridge={clients:new Map()};services.events=new EventEmitter();
  t.after(()=>{services.gameBridge=previousBridge;services.events=previousEvents;});
  const manager=new sessions.SessionManager(),client=new EventEmitter();
  t.after(()=>manager.shutdownAll());
  client.transport='fabric';client.bot=null;client.state='offline';client.isOnline=()=>false;
  client._getEmail=()=> 'seller@example.test';
  let attempts=0,waiting=0;
  client.connect=async()=>{attempts++;};client.disconnect=async()=>{};
  services.events.on('session:waiting_game',()=>waiting++);
  manager.clients.set('seller1',client);manager.states.set('seller1','DISCONNECTED');manager.getMode=()=> 'always_on';
  manager._evaluateAccountConnection('seller1');manager._evaluateAccountConnection('seller1');
  assert.equal(attempts,0);assert.equal(waiting,1);
  services.gameBridge.clients.set('seller1',{});
  manager._evaluateAccountConnection('seller1');
  assert.equal(attempts,1);
});
