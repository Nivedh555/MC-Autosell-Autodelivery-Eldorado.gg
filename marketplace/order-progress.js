'use strict';
const {closedStatus,closure,stoppedStates} = require('./order-status');
function orderProgress(db,id,now=Date.now()){
  const row=db.prepare('SELECT * FROM delivery_orders WHERE id=?').get(id);
  const observed=db.prepare('SELECT payload,first_ms FROM marketplace_observations WHERE id=?').get(id);
  if(!row&&!observed)return null;
  const capture=observed?JSON.parse(observed.payload):{},order=row?JSON.parse(row.payload):capture;
  const chunks=db.prepare('SELECT chunk_index,state,amount FROM delivery_chunks WHERE order_id=? ORDER BY chunk_index').all(id);
  const events=db.prepare('SELECT kind,data,wall_ms FROM delivery_events WHERE order_id=? ORDER BY sequence').all(id);
  const stages={};let previous={state:'DETECTED',at:row?.created_ms||observed.first_ms};
  for(const event of events.filter(e=>e.kind==='STATE')){const state=JSON.parse(event.data).state;stages[previous.state]=(stages[previous.state]||0)+Math.max(0,event.wall_ms-previous.at);previous={state,at:event.wall_ms};}
  if(row&&!stoppedStates.has(row.state)&&!['DELIVERED','TRANSFERRED','EXPIRED','DRY_RUN'].includes(row.state))stages[previous.state]=(stages[previous.state]||0)+Math.max(0,now-previous.at);
  const verified=chunks.filter(c=>c.state==='PAY_VERIFIED'),paid=verified.reduce((sum,c)=>sum+BigInt(c.amount),0n);
  const actions=db.prepare("SELECT state,operation,request,reason FROM browser_actions WHERE resource_id=? AND operation IN ('uploadEvidenceObserved','sendMessageObserved')").all(id);
  const receipt=actions.filter(a=>a.operation==='uploadEvidenceObserved'&&/^receipt-/.test(JSON.parse(a.request||'{}').name||''));
  const evidence=row?.evidence?JSON.parse(row.evidence):null;
  const selected=require('./order-chat-flow').selection(capture.orderReference?.messages||[],{amount:order.amount,confirmIgn:true});
  const commands=events.filter(e=>e.kind==='command').map(e=>JSON.parse(e.data).command);
  const messages=db.prepare(`SELECT logical_key,state,reason,updated_ms,next_check_ms,checks
    FROM message_outbox WHERE order_id=? ORDER BY updated_ms,logical_key`).all(id);
  const uncertainMessage=messages.find(message=>['UNKNOWN','FAILED'].includes(message.state));
  const remoteStatus=closedStatus(capture.apiStatus,capture.status) || capture.apiStatus || capture.status || null;
  const remoteClosure=closure(remoteStatus);
  const state=row?.state || (remoteClosure==='canceled'?'CANCELLED':remoteClosure==='completed'?'MARKETPLACE_CLOSED':'WAITING_FOR_CONFIRMATION');
  let nextAction;
  if(state==='RECONCILIATION_REQUIRED')nextAction='Compare the payment journal with the closed Eldorado order. Automatic delivery has stopped.';
  else if(state==='CANCELLED'||state==='MARKETPLACE_CLOSED')nextAction='The marketplace closed this order. No delivery is scheduled.';
  else if(state==='NEEDS_OPERATOR')nextAction=row.reason||'Review the recorded payment and proof before taking action.';
  else if(uncertainMessage)nextAction='Inspect the outgoing conversation for '+uncertainMessage.logical_key+' and reconcile its receipt.';
  else if(state==='DELIVERED')nextAction='Delivery acknowledged. The outbox tracks any remaining instructions.';
  else if(paid>0n&&String(paid)===String(order.amount))nextAction='Complete proof and marketplace acknowledgement only.';
  else if(selected.requiresClarification)nextAction='Ask the buyer for the exact recipient and confirm again.';
  else if(selected.confirmed)nextAction='Run funded-order, stock, account and dispatch checks.';
  else nextAction='Wait for the exact recipient and amount confirmation.';
  return {orderId:id,buyer:order.buyerMarketplaceId||order.buyerName,amount:String(order.amount||''),recipient:order.buyerIgn||selected.latest?.ign||null,latestObservedRecipient:selected.latest?.ign||null,
    confirmation:{confirmed:selected.confirmed,requiresClarification:selected.requiresClarification,source:'Last captured room; dispatch requires a fresh read'},state,marketplaceStatus:remoteStatus,messages,account:row?.account_id||null,
    payment:{verifiedChunks:verified.length,totalRecordedChunks:chunks.length,verifiedCoins:String(paid),uncertain:chunks.some(c=>['PAY_INTENT','PAY_SENT'].includes(c.state))},
    screenshot:events.some(e=>e.kind==='SCREENSHOT')?'CAPTURED':'PENDING',proof:evidence?'BUILT':'PENDING',upload:receipt.some(a=>a.state==='CONFIRMED')?'CONFIRMED':receipt.at(-1)?.state||'PENDING',
    marketplaceAcknowledgement:state==='DELIVERED'?'CONFIRMED':stoppedStates.has(state)?'STOPPED':'PENDING',lastError:row?.reason||uncertainMessage?.reason||capture.chatReason||capture.routingReason||null,nextAction,nextAttemptMs:row?.next_attempt_ms||null,stageMs:stages,
    commands:{balance:commands.filter(c=>c==='/bal').length,recipientBalance:commands.filter(c=>c.startsWith('/bal ')).length,payment:commands.filter(c=>c.startsWith('/pay ')).length}};
}
module.exports={orderProgress};
