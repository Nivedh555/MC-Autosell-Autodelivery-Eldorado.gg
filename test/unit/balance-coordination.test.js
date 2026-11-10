'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {VerifiedPayments,reserveCommandChannel}=require('../../minecraft/verified-payments');
const {BalanceCoordinator}=require('../../minecraft/balance-coordinator');
const pack={calibrated:true,source:'fixture',balance:'^Balance: (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',timeoutMs:100,systemPositions:['system']};
test('twenty equivalent idle requests dispatch one /bal; exact payment reads still dispatch independently',async()=>{
  const bot=new EventEmitter(),commands=[];bot.chat=c=>{commands.push(c);queueMicrotask(()=>bot.emit('messagestr','Balance: 500','system'));};
  const verifiers=Array.from({length:20},()=>new VerifiedPayments(pack,undefined,undefined,{readOnly:true}));
  assert.deepEqual(await Promise.all(verifiers.map(v=>v.readIdleBalance(bot))),Array(20).fill(500n));assert.equal(commands.length,1);
  await verifiers[0].readIdleBalance(bot);assert.equal(commands.length,1);
  const financial=new VerifiedPayments(pack);
  await financial.exclusive(bot,async raw=>{await financial.readBalance(raw);await financial.readBalance(raw);});
  assert.equal(commands.length,3);await verifiers[0].readIdleBalance(bot);assert.equal(commands.length,4);
  assert.equal(financial.lastBalanceObservation.cached,undefined);
});
test('cache freshness, invalidation and disconnect are session-specific',async()=>{
  let now=0,reads=0;const coordinator=new BalanceCoordinator({now:()=>now}),bot=new EventEmitter();
  const read=async()=>({balance:String(++reads),observedMs:now,exact:true});
  assert.equal((await coordinator.read(bot,'key',read)).balance,'1');now=4999;assert.equal((await coordinator.read(bot,'key',read)).balance,'1');
  now=5000;assert.equal((await coordinator.read(bot,'key',read)).balance,'2');coordinator.invalidate(bot);assert.equal((await coordinator.read(bot,'key',read)).balance,'3');
  bot.emit('end');await assert.rejects(coordinator.read(bot,'key',read),/disconnected/);
  assert.equal((await coordinator.read(new EventEmitter(),'key',read)).balance,'4');
});
test('idle reads cannot consume a financial response or survive a disconnected in-flight request',async()=>{
  const bot=new EventEmitter();bot.chat=()=>{};const v=new VerifiedPayments(pack,undefined,undefined,{readOnly:true});
  const release=reserveCommandChannel(bot);await assert.rejects(v.readIdleBalance(bot),/checking or sending/);release();
  const pending=v.readIdleBalance(bot);await new Promise(resolve=>setImmediate(resolve));bot.emit('end');await assert.rejects(pending,/disconnected/);
});
