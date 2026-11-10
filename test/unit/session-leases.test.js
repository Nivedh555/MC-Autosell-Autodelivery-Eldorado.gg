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
