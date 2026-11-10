'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const services=require('../../services'),FabricClient=require('../../v3/fabric-client');
test('a replaced Fabric bot cannot send commands through the new session',t=>{
 const previous=services.gameBridge;services.gameBridge=null;t.after(()=>services.gameBridge=previous);
 const client=new FabricClient('seller1');let calls=0;client.chat=()=>calls++;
 client._attach({ign:'Fixture',version:'26.3',host:'donutsmp.net'});const old=client.bot;
 client._attach({ign:'Fixture',version:'26.3',host:'donutsmp.net'});
 assert.throws(()=>old.chat('/pay BuyerOne 100'),/session changed/);assert.equal(calls,0);
 client.bot.chat('/bal');assert.equal(calls,1);
});
test('a delayed failure of an old bridge request cannot end the new command channel',async t=>{
 const previous={gameBridge:services.gameBridge,events:services.events};Object.assign(services,{gameBridge:null,events:new EventEmitter()});t.after(()=>Object.assign(services,previous));
 const client=new FabricClient('seller1');client.isOnline=()=>true;let reject;
 services.gameBridge={request:()=>new Promise((_resolve,r)=>reject=r)};
 client._attach({ign:'Fixture',version:'26.3',host:'donutsmp.net'});const old=client.bot;let oldEnds=0,newEnds=0;old.on('end',()=>oldEnds++);
 client.chat('/bal');client._attach({ign:'Fixture',version:'26.3',host:'donutsmp.net'});client.bot.on('end',()=>newEnds++);
 reject(Error('Old socket lost'));await new Promise(resolve=>setImmediate(resolve));assert.equal(oldEnds,1);assert.equal(newEnds,0);
});
