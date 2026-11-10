'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CommandPacer}=require('../../minecraft/command-pacer');
test('balance and payment commands share a per-account cooldown and failed sends are never replayed',async()=>{
 let clock=0;const sends=[],waits=[];
 const pacer=new CommandPacer({now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});
 await Promise.all(['/bal','/pay Buyer 100000000','/bal Buyer'].map(command=>pacer.run('seller1',async()=>sends.push({command,at:clock}))));
 assert.deepEqual(sends.map(x=>x.at),[0,1100,2200]);assert.deepEqual(waits,[1100,1100]);
 let failed=0;await assert.rejects(pacer.run('seller1',async()=>{failed++;throw Error('unknown outcome');}),/unknown/);assert.equal(failed,1);
 await pacer.run('seller1',async()=>sends.push({command:'/bal',at:clock}));assert.equal(sends.at(-1).at,4400);
 await pacer.run('seller2',async()=>sends.push({command:'/bal',at:clock}));assert.equal(sends.at(-1).at,4400);
});
test('Fabric command response timers and final authorization run after the cooldown',async()=>{
 const {EventEmitter}=require('node:events'),{VerifiedPayments}=require('../../minecraft/verified-payments');
 const bot=new EventEmitter(),sent=[];bot.transport='fabric';bot.chat=command=>{sent.push({command,at:performance.now()});queueMicrotask(()=>bot.emit('messagestr','ok','system'));};
 const verifier=new VerifiedPayments({calibrated:true,source:'isolated test fixture',balance:'^Balance: (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',timeoutMs:40,systemPositions:['system']});
 const exchange=command=>verifier._exchange(bot,command,text=>text==='ok'?{ok:true}:null);
 await exchange('/bal');await exchange('/bal Buyer');
 assert(sent[1].at-sent[0].at>=1050);
 let allowed=true;const pending=verifier._exchange(bot,'/pay Buyer 100',()=>null,null,()=>{if(!allowed)throw Error('owner paused');});allowed=false;
 await assert.rejects(pending,/owner paused/);assert.equal(sent.length,2);
});

test('an asynchronous rejected authorization finishes before dispatch and cannot send /pay',async()=>{
 const {EventEmitter}=require('node:events'),{VerifiedPayments}=require('../../minecraft/verified-payments');
 const bot=new EventEmitter(),commands=[];bot.chat=command=>commands.push(command);
 const verifier=new VerifiedPayments({calibrated:true,source:'fixture',balance:'^Balance: (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',timeoutMs:20,systemPositions:['system']});
 await assert.rejects(verifier._exchange(bot,'/pay BuyerOne 100',()=>null,null,async()=>{await Promise.resolve();throw Error('Late buyer correction');}),/Late buyer correction/);
 assert.equal(commands.length,0);
});

test('slow authorization measures the next cooldown from actual dispatch',async()=>{
 let clock=0;const waits=[],pacer=new CommandPacer({now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});
 await pacer.run('seller1',async()=>{clock+=5000;pacer.mark('seller1');});
 await pacer.run('seller1',async()=>pacer.mark('seller1'));
 assert.deepEqual(waits,[1100]);assert.equal(clock,6100);
});

test('trusted command cooldown rejects promptly without replaying a payment command',async()=>{
 const {EventEmitter}=require('node:events'),{VerifiedPayments}=require('../../minecraft/verified-payments');
 const bot=new EventEmitter(),commands=[];bot.chat=command=>{commands.push(command);queueMicrotask(()=>bot.emit('messagestr','You need to wait another 0.25 seconds to execute a command','system'));};
 const verifier=new VerifiedPayments({calibrated:true,source:'fixture',balance:'^Balance: (?<amount>\\d+)$',success:'^Paid (?<amount>\\d+) to (?<ign>[A-Za-z0-9_]+)$',timeoutMs:100,systemPositions:['system']});
 await assert.rejects(verifier._exchange(bot,'/pay BuyerOne 100',()=>null),error=>error.code==='SERVER_COMMAND_COOLDOWN');assert.equal(commands.length,1);
});
