'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
test('spawner collection exposes every required timeout and GUI configuration',()=>{
  const config=require('../../config');for(const key of ['tpaTimeoutMs','collectMs','collectRadius','tpaConfirmSlot','tpaGuiDelayMs','enderChestSearchRadius','enderChestPlaceTimeoutMs'])assert.equal(Number.isFinite(config.collect[key]),true,key);assert.equal(typeof config.collect.tpaUsesGui,'boolean');
});
test('spawner home helper stops collection when teleport is unconfirmed',async()=>{
  const AccountClient=require('../../minecraft/account-client');const sweep=require('../../minecraft/sweep');const original=sweep.goHomeRobust;
  sweep.goHomeRobust=async()=>false;try{await assert.rejects(new AccountClient('buyer1').goHome(),/Home teleport was not confirmed/);}finally{sweep.goHomeRobust=original;}
});

test('spawner collection refuses to mix existing valuables with seller drops',async()=>{
  const services=require('../../services'),{EventEmitter}=require('node:events'),tp=require('../../minecraft/tp');
  const saved={mcBot:services.mcBot,logger:services.logger,config:services.config},originalSleep=tp.sleep;
  const client=new EventEmitter();let commands=0;
  client.bot={inventory:{items:()=>[{name:'diamond_sword',type:42,count:1}]} };client.isOnline=()=>true;client.setState=state=>{client.state=state;};client.goHome=async()=>{};client.chat=()=>{commands++;};
  services.mcBot=client;services.logger={minecraft:async()=>{},warn:async()=>{},error:async()=>{}};services.config={buy:{match:'skeleton'}};tp.sleep=async()=>{};
  try{const result=await require('../../minecraft/buy').collect({id:'fixture',requested:1,sellerUsername:'FixturePlayer'});assert.equal(result.success,false);assert.match(result.reason,/carrying items from before this sale/);assert.equal(commands,0);}
  finally{tp.sleep=originalSleep;Object.assign(services,saved);}
});

test('a disconnect while storing collected spawners cannot become a successful sale',async t=>{
  const services=require('../../services'),{EventEmitter}=require('node:events'),tp=require('../../minecraft/tp'),stock=require('../../minecraft/stock'),sweep=require('../../minecraft/sweep'),status=require('../../discord/seller-status');
  const saved={mcBot:services.mcBot,logger:services.logger,config:services.config};let items=[];
  const client=new EventEmitter(),bot={inventory:{items:()=>items},blockAt:()=>null};client.bot=bot;client.isOnline=()=>true;client.setState=value=>{client.state=value;};client.goHome=async()=>{};client.chat=()=>{};
  services.mcBot=client;services.logger={minecraft:async()=>{},warn:async()=>{},error:async()=>{},success:async()=>{}};
  services.config={buy:{match:'skeleton'},collect:{tpaTimeoutMs:10,tpaUsesGui:false,enderChestSearchRadius:5,enderChestPlaceTimeoutMs:10,collectMs:0,collectRadius:5}};
  t.mock.method(tp,'sleep',async()=>{});t.mock.method(tp,'waitForTeleport',async()=>{});t.mock.method(sweep,'goHomeRobust',async()=>true);
  t.mock.method(status,'live',async()=>{});t.mock.method(status,'post',async()=>{});
  t.mock.method(tp,'waitForEnderChestNearby',async()=>{items=[{name:'spawner',displayName:'Skeleton Spawner',nbt:{BlockEntityTag:{SpawnData:{entity:{id:'minecraft:skeleton'}}}},type:42,count:2}];return {position:{}};});
  t.mock.method(stock,'openChest',async()=>({deposit:async()=>{client.emit('end','fixture disconnect');items=[];},close:()=>{}}));
  t.mock.method(stock,'depositInventory',async()=>{});
  try{const result=await require('../../minecraft/buy').collect({id:'fixture',requested:2,sellerUsername:'FixturePlayer'});assert.equal(result.success,false);assert.equal(result.needsReview,true);assert.match(result.reason,/interrupted/);}
  finally{Object.assign(services,saved);}
});
