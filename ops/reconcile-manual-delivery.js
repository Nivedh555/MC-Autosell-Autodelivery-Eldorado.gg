'use strict';
const path=require('node:path');
const Database=require('../db/database');
const {DeliveryRepository}=require('../db/repositories/delivery');
const Ledger=require('../ledger/ledger');
const {rateFromEvidence}=require('../minecraft/donutsmp-tax');

// For a seller who already marked one order delivered on Eldorado after the old
// tax receipt parser missed a real payment. Never dispatches a Minecraft command,
// sends a buyer message, or manufactures screenshot geometry.
function reconcile(database,orderId,recipient){
  const repo=new DeliveryRepository(database),db=database.raw();
  return repo.transaction(()=>{
    const row=repo.get(orderId),chunk=repo.chunks(orderId)[0];
    if(!row||!['NEEDS_OPERATOR','RECONCILIATION_REQUIRED'].includes(row.state)||row.mode!=='live'||
       !/^Missing anchored confirmation; observed debit |^Marketplace status Delivered after payment intent\./.test(row.reason||''))
      throw Error('Order is not the held taxed-payment case');
    const order=JSON.parse(row.payload),observed=db.prepare('SELECT payload,last_ms FROM marketplace_observations WHERE id=?').get(orderId);
    const remote=observed?JSON.parse(observed.payload):null;
    if(!remote||!['delivered','order delivered','order marked as delivered','received','order received','completed'].includes(String(remote.status||'').toLowerCase())||
      !Number.isSafeInteger(observed.last_ms)||Date.now()-observed.last_ms>15*60*1000)
      throw Error('A recent Eldorado Delivered readback is required');
    const chunks=repo.chunks(orderId);
    if(chunks.length!==1||chunk.state!=='PAY_SENT'||!row.account_id||!chunk.before_balance||chunk.after_balance||chunk.result||
      !/^[1-9][0-9]*$/.test(String(chunk.command_amount))||!/[A-Za-z]/.test(order.buyerIgn)||
      recipient.toLowerCase()!==order.buyerIgn.toLowerCase()||String(chunk.amount)!==String(order.amount))
      throw Error('Payment journal does not describe one unchanged recipient and chunk');
    const lock=db.prepare('SELECT order_id FROM delivery_account_locks WHERE account_id=?').get(row.account_id);
    if(lock?.order_id!==orderId||db.prepare('SELECT 1 FROM ledger WHERE idempotency_key=?').get('delivery:'+orderId+':0'))
      throw Error('Account lock or ledger no longer matches this held order');
    const events=repo.history(orderId).map(event=>({kind:event.kind,data:JSON.parse(event.data),sequence:event.sequence}));
    const payCommand='/pay '+recipient+' '+chunk.command_amount;
    const payIndex=events.findIndex(event=>event.kind==='command'&&event.data.command===payCommand);
    if(payIndex<0||events.filter(event=>event.kind==='command'&&String(event.data.command).startsWith('/pay ')).length!==1)
      throw Error('Expected exactly one recorded payment command');
    const authorized=events.slice(0,payIndex).findLast(event=>event.kind==='DISPATCH_AUTHORIZED');
    if(!authorized||authorized.data.recipient!==recipient||authorized.data.amount!==String(order.amount)||!authorized.data.confirmationMessageId)
      throw Error('Buyer confirmation was not bound to this payment');
    const afterCommand=events.findIndex((event,index)=>index>payIndex&&event.kind==='command'&&event.data.command==='/bal');
    const uncertain=events.find(event=>event.kind==='PAY_UNCERTAIN');
    if(afterCommand<0||!uncertain||uncertain.sequence<=events[afterCommand].sequence||uncertain.data.signal!=null||
      uncertain.data.before!==chunk.before_balance||!/^\d+$/.test(String(uncertain.data.after))||
      BigInt(uncertain.data.before)-BigInt(uncertain.data.after)!==BigInt(uncertain.data.delta))
      throw Error('Exact before and after debit evidence is missing');
    const before=events.slice(0,payIndex).findLast(event=>event.kind==='BALANCE_DISPLAY'&&event.data.exact===true&&event.data.balance===chunk.before_balance);
    const after=events.slice(afterCommand).find(event=>event.kind==='BALANCE_DISPLAY'&&event.data.exact===true&&event.data.balance===uncertain.data.after);
    if(!before||!after||after.sequence>=uncertain.sequence)throw Error('Independent exact balance observations do not bracket the payment');
    const receipts=events.slice(payIndex+1,afterCommand).filter(event=>event.kind==='chat'&&
      rateFromEvidence({line:event.data.raw,recipient,command:chunk.command_amount,debit:uncertain.data.delta,position:event.data.position,sender:event.data.sender})!==null);
    if(receipts.length!==1)throw Error('Exactly one matching system payment receipt is required');
    const taxRate=rateFromEvidence({line:receipts[0].data.raw,recipient,command:chunk.command_amount,debit:uncertain.data.delta,position:receipts[0].data.position,sender:receipts[0].data.sender});
    const debit=BigInt(uncertain.data.delta);
    if(debit>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Debit exceeds safe ledger precision');
    const result={verified:true,manualReconciliation:true,screenshotCaptured:false,reason:'Exact server receipt and independent sender balances; seller manually marked Eldorado Delivered',
      before:chunk.before_balance,after:uncertain.data.after,delta:debit.toString(),expectedDebit:debit.toString(),
      signal:{recipient,amount:chunk.command_amount,tax:(debit-BigInt(chunk.command_amount)).toString(),
        capture:{raw:receipts[0].data.raw,position:'system',sender:null,command:payCommand,wallMs:receipts[0].data.wallMs}}};
    db.prepare("UPDATE delivery_chunks SET state='PAY_VERIFIED',debit=?,after_balance=?,result=? WHERE order_id=? AND chunk_index=0")
      .run(debit.toString(),result.after,JSON.stringify(result),orderId);
    new Ledger(db).append({idempotencyKey:'delivery:'+orderId+':0',entryType:'delivery',currency:'donut',amount:Number(debit),referenceType:'marketplace_order',referenceId:orderId,accountId:row.account_id,
      metadata:{recipientAmount:chunk.command_amount,marketplaceDelivery:'seller manually confirmed',screenshotCaptured:false}});
    repo.release(orderId);
    const reason='Payment reconciled from exact DonutSMP receipt and balances; seller manually marked Eldorado Delivered. No proof image was captured or uploaded.';
    db.prepare("UPDATE delivery_orders SET state='DELIVERED',reason=?,next_attempt_ms=0,updated_ms=? WHERE id=?").run(reason,Date.now(),orderId);
    repo.event(orderId,'MANUAL_PAYMENT_RECONCILED',{recipient,commandAmount:chunk.command_amount,actualDebit:debit.toString(),taxBasisPoints:taxRate,remoteStatus:remote.status,proofImageUploaded:false,paymentRepeated:false});
    return {orderId,state:'DELIVERED',recipient,commandAmount:chunk.command_amount,actualDebit:debit.toString(),proofImageUploaded:false,paymentRepeated:false};
  });
}
async function main(){
  const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
  const dbPath=value('--db'),orderId=value('--order'),recipient=value('--recipient');
  if(!dbPath||!path.isAbsolute(dbPath)||!/^[a-f0-9-]{36}$/i.test(orderId||'')||!/^\.?[A-Za-z0-9_]{3,16}$/.test(recipient||''))
    throw Error('Usage: node ops/reconcile-manual-delivery.js --db ABSOLUTE_DB_PATH --order UUID --recipient IGN');
  const database=await Database.open(dbPath);
  try{process.stdout.write(JSON.stringify(reconcile(database,orderId,recipient))+'\n');}finally{database.close();}
}
if(require.main===module)main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
module.exports={reconcile};
