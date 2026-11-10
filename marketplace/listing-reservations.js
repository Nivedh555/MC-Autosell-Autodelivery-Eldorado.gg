'use strict';
// A closed marketplace order stops reserving stock after all local financial
// exposure is settled. Keep an account with an unresolved dispatch fenced.
const reservesStockSql = `state NOT IN ('DELIVERED','TRANSFERRED','CANCELLED','EXPIRED','DRY_RUN','MARKETPLACE_CLOSED')
  AND (state!='RECONCILIATION_REQUIRED'
    OR EXISTS(SELECT 1 FROM delivery_account_locks l WHERE l.order_id=delivery_orders.id)
    OR EXISTS(SELECT 1 FROM delivery_chunks c WHERE c.order_id=delivery_orders.id AND c.state IN ('PAY_INTENT','PAY_SENT')))`;
// Reserve unpaid currency for every accepted order before advertising new stock.
function reservedCoins(pending,unresolved,execution){
  const orders=new Map(pending.map(order=>[order.id,order]));
  for(const row of unresolved)if(!orders.has(row.id))orders.set(row.id,row);
  let reserved=0n;
  for(const order of orders.values()){
    const local=execution(order.id);
    if (['CANCELLED','MARKETPLACE_CLOSED','DELIVERED'].includes(local?.state)) continue;
    if (local?.state==='RECONCILIATION_REQUIRED') {
      if (unresolved.some(row=>row.id===order.id)) throw Error('A closed order still has an unresolved debit on this account.');
      continue;
    }
    if(local?.state==='NEEDS_OPERATOR'||local?.chunks?.some(c=>['PAY_INTENT','PAY_SENT'].includes(c.state)))throw Error('An existing payment needs reconciliation before advertising more stock.');
    const amount=local?.amount??order.amount;
    if(!/^[1-9][0-9]*$/.test(String(amount)))throw Error('An accepted order has no verified currency amount; stock cannot be reserved.');
    const paid=(local?.chunks||[]).filter(c=>c.state==='PAY_VERIFIED').reduce((n,c)=>n+BigInt(c.amount),0n);
    if(paid>BigInt(amount))throw Error('Verified payments exceed the order amount.');
    reserved+=BigInt(amount)-paid;
  }
  return reserved;
}
module.exports={reservedCoins,reservesStockSql};
