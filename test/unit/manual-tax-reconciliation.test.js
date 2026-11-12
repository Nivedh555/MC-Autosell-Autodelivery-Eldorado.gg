'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('../../db/database');
const {reconcile}=require('../../ops/reconcile-manual-delivery');

async function fixture(t,{receipt='You paid 14him $ 10M (+$ 200K tax)',status='Delivered'}={}){
  const database=await Database.open(':memory:');t.after(()=>database.close());const db=database.raw(),id='taxed-order';
  const order={id,buyerIgn:'14him',amount:'10000000'};
  db.prepare('INSERT INTO delivery_orders(id,fingerprint,payload,state,reason,mode,account_id,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id,'fixture',JSON.stringify(order),'RECONCILIATION_REQUIRED','Marketplace status Delivered after payment intent. Reconcile.', 'live','seller1',Date.now(),Date.now());
  db.prepare('INSERT INTO delivery_chunks(order_id,chunk_index,amount,command_amount,debit,state,before_balance,idempotency_key) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,0,'10000000','10000000','10000000','PAY_SENT','192230515',id+':0');
  db.prepare('INSERT INTO delivery_account_locks(account_id,order_id,owner,reserved_amount,balance,acquired_ms) VALUES(?,?,?,?,?,?)')
    .run('seller1',id,'fixture','10000000','192230515',Date.now());
  db.prepare('INSERT INTO marketplace_observations(id,payload,source,first_ms,last_ms) VALUES(?,?,?,?,?)')
    .run(id,JSON.stringify({id,status}),'captured marketplace response',Date.now(),Date.now());
  const rows=[
    ['BALANCE_DISPLAY',{balance:'192230515',exact:true}],
    ['DISPATCH_AUTHORIZED',{recipient:'14him',amount:'10000000',confirmationMessageId:'buyer-yes'}],
    ['command',{command:'/pay 14him 10000000'}],
    ['chat',{raw:receipt,position:'system',sender:null,wallMs:Date.now()}],
    ['command',{command:'/bal'}],
    ['BALANCE_DISPLAY',{balance:'182030515',exact:true}],
    ['PAY_UNCERTAIN',{before:'192230515',after:'182030515',delta:'10200000',signal:null}],
  ];
  for(const [kind,data] of rows)db.prepare('INSERT INTO delivery_events(order_id,kind,data,wall_ms,monotonic_ns) VALUES(?,?,?,?,?)').run(id,kind,JSON.stringify(data),Date.now(),'1');
  return {database,db,id};
}

test('manual reconciliation records a proven taxed transfer once after marketplace delivery',async t=>{
  const {database,db,id}=await fixture(t);
  assert.equal(reconcile(database,id,'14him').actualDebit,'10200000');
  assert.equal(db.prepare('SELECT state FROM delivery_orders WHERE id=?').get(id).state,'DELIVERED');
  assert.equal(db.prepare('SELECT state,debit FROM delivery_chunks WHERE order_id=?').get(id).debit,'10200000');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_account_locks WHERE order_id=?').get(id).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger WHERE reference_id=?').get(id).n,1);
  assert.throws(()=>reconcile(database,id,'14him'),/not the held taxed-payment case/);
});

test('manual reconciliation refuses wrong recipient, unproved debit and pending marketplace',async t=>{
  const x=await fixture(t);assert.throws(()=>reconcile(x.database,x.id,'SomeoneElse'),/unchanged recipient/);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM ledger').get().n,0);
  const y=await fixture(t,{receipt:'You paid 14him $ 10M (+$ 100K tax)'});
  assert.throws(()=>reconcile(y.database,y.id,'14him'),/matching system payment receipt/);
  const z=await fixture(t,{status:'Pending delivery'});
  assert.throws(()=>reconcile(z.database,z.id,'14him'),/Delivered readback/);
});
