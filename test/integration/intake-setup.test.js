'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const Database=require('../../db/database');const {CalibrationRecorder}=require('../../ops/calibration');
const {validate,recipientAllowed,preflight}=require('../../payments/payout-policy');
test('receipt setup saves only an owner-selected trusted captured event',async t=>{
 const db=await Database.open(':memory:');t.after(()=>db.close());let saved;const values={'general.bot.paused':true,'treasury.accountRoles':{buyer1:{role:'intake'}},'delivery.patternPack':{balanceCalibrated:true,calibrated:false,balance:'^Balance: (?<amount>\\d+)$',source:'reviewed balance',systemPositions:['system']}};
 const settings={get:async key=>values[key],set:async(key,value)=>{values[key]=value;saved=value;}};
 const ctx={db,settings};const recorder=new CalibrationRecorder(ctx);recorder.assertAvailable=async()=>{};
 db.raw().prepare('INSERT INTO calibration_runs VALUES(?,?,?,NULL,?)').run('fixture-capture','buyer1',Date.now(),'CAPTURED_UNREVIEWED');
 const id=db.raw().prepare('INSERT INTO calibration_events(run_id,kind,data,wall_ms,monotonic_ns) VALUES(?,?,?,?,?)').run('fixture-capture','chat',JSON.stringify({raw:'Received $1 from TestPlayer',position:'system',sender:null}),Date.now(),'1').lastInsertRowid;
 const result=await recorder.reviewIncoming('fixture-capture',Number(id),'TestPlayer','1','USE CAPTURED INCOMING RECEIPT');assert.equal(result.success,true);assert.equal(saved.incomingCalibrated,true);assert.equal(saved.calibrated,false);assert.equal(saved.balanceCalibrated,true);
 assert.match(saved.incomingSource,/Owner reviewed/);await assert.rejects(recorder.reviewIncoming('fixture-capture',Number(id),'TestPlayer','1','wrong confirmation'),/Confirm/);
});
test('payout policy supports explicitly chosen linked sellers and retains strict caps',()=>{
 const ctx={store:{getSeller:id=>id==='known'?{ltcAddress:'saved-address'}:null},wallet:{isValidAddress:()=>true}};
 const p=validate({enabled:true,addressMode:'linked-seller',maxPerTxFiatMicros:'1000000',maxPerDayFiatMicros:'2000000'});
 assert.equal(recipientAllowed(p,'known','saved-address',ctx),true);assert.equal(recipientAllowed(p,'known','changed-address',ctx),false);assert.equal(recipientAllowed(p,'unknown','saved-address',ctx),false);
 assert.throws(()=>validate({enabled:true,addressMode:'linked-seller',maxPerTxFiatMicros:'2',maxPerDayFiatMicros:'1'}),/daily cap/);
});
test('disabled or unfunded payouts fail before customers are instructed to send',async t=>{
 const db=await Database.open(':memory:');t.after(()=>db.close());const policy={enabled:true,addressMode:'linked-seller',maxPerTxFiatMicros:'10000000',maxPerDayFiatMicros:'100000000'};
 const ctx={db,settings:{get:async key=>key==='payout.policy'?policy:0},store:{sendEnabled:()=>false,getSeller:()=>({ltcAddress:'address'})},wallet:{enabled:true,isValidAddress:()=>true,usdToLitoshi:async()=>100000,_availableUtxos:async()=>[],_feeRate:async()=>1},ledger:{query:()=>[]}};
 await assert.rejects(preflight(ctx,'fixture',1),/enable Send LTC/);ctx.store.sendEnabled=()=>true;await assert.rejects(preflight(ctx,'fixture',1),/cannot currently cover/);
});
