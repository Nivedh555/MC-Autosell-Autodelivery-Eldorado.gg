'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('../../db/database'),services=require('../../services');
const {RolloutController}=require('../../marketplace/rollout');
test('hybrid readiness reflects live browser and Minecraft connectivity instead of a stale setup message',async()=>{
 const db=await Database.open(':memory:'),keys=['marketplace','browserBridge','offerQueue','gameBridge','store'],previous=Object.fromEntries(keys.map(key=>[key,services[key]]));
 try{
  let connected=true;Object.assign(services,{store:null,marketplace:{hybrid:true},browserBridge:{status:()=>({connected,state:'ATTACHED_PAUSED'})},offerQueue:{active:()=>({account_id:'seller1'})},gameBridge:{clients:new Map()}});
  const controller=new RolloutController(db,{get:async key=>key==='listing.policy'?{offerId:'offer',holderAccount:'seller1'}:key==='eldorado.connection'?'hybrid':false});controller.prerequisites=async()=>{};
  assert.equal(await controller.activateConfigured(),false);assert.match(controller.status().reason,/seller1 is offline/);
  services.gameBridge.clients.set('seller1',{});assert.equal(await controller.activateConfigured(),true);assert.equal(controller.status().reason,null);
  connected=false;assert.equal(await controller.activateConfigured(),false);assert.match(controller.status().reason,/seller browser/);
 }finally{Object.assign(services,previous);db.close();}
});
