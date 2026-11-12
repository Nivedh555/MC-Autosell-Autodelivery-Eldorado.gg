'use strict';
// A quote is based on a real system receipt and the matching exact sender debit.
// No language model or rounded scoreboard value is allowed to authorize a payment.
const { profile } = require('./donutsmp-profile');
const receipt = new RegExp(profile().success);
const units = profile().confirmationUnits;
function amount(text,unit){
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text||''))return null;
  const [whole,fraction='']=text.replace(/,/g,'').split('.');
  if(!unit&&fraction)return null;
  const scale=BigInt(unit?units[unit]||0:1);
  if(!scale)return null;
  const numerator=BigInt(whole+fraction)*scale,divisor=10n**BigInt(fraction.length);
  return numerator%divisor?null:numerator/divisor;
}
function rateFromEvidence({line,recipient,command,debit,position='system',sender=null}){
  if(sender||position!=='system')return null;
  const match=receipt.exec(String(line||''));
  if(!match?.groups?.taxAmount||match.groups.ign.toLowerCase()!==String(recipient).toLowerCase())return null;
  const paid=amount(match.groups.amount,match.groups.unit),tax=amount(match.groups.taxAmount,match.groups.taxUnit);
  if(paid===null||tax===null||paid!==BigInt(command)||paid+tax!==BigInt(debit)||paid===0n)return null;
  const basisPoints=(tax*10000n+paid-1n)/paid;
  if(basisPoints>3000n)return null;
  return Number(basisPoints);
}
const MAX_OBSERVATION_AGE_MS=7*24*60*60*1000;
function observedRate(db,accountId){
  const rows=db.prepare(`SELECT d.id,d.account_id,d.payload,c.command_amount,c.before_balance,c.after_balance,c.result,c.state
    FROM delivery_chunks c JOIN delivery_orders d ON d.id=c.order_id
    WHERE d.mode='live' AND d.account_id IS NOT NULL AND d.updated_ms>=? ${accountId?'AND d.account_id=?':''}
    ORDER BY d.updated_ms DESC LIMIT 60`).all(Date.now()-MAX_OBSERVATION_AGE_MS,...(accountId?[accountId]:[]));
  for(const row of rows){
    const order=JSON.parse(row.payload),result=row.result?JSON.parse(row.result):null;
    if(row.state==='PAY_VERIFIED'&&result?.verified===true&&result.signal?.tax!=null){
      const debit=BigInt(result.before)-BigInt(result.after);
      const rate=rateFromEvidence({line:result.signal.capture?.raw,recipient:order.buyerIgn,command:row.command_amount,debit,position:result.signal.capture?.position,sender:result.signal.capture?.sender});
      if(rate!==null)return {basisPoints:rate,orderId:row.id,accountId:row.account_id};
    }
    if(row.state!=='PAY_SENT'||result)continue;
    const events=db.prepare('SELECT kind,data FROM delivery_events WHERE order_id=? ORDER BY sequence').all(row.id).map(event=>({kind:event.kind,data:JSON.parse(event.data)}));
    const sent=events.findIndex(event=>event.kind==='command'&&event.data.command==='/pay '+order.buyerIgn+' '+row.command_amount);
    if(sent<0||events.filter(event=>event.kind==='command'&&event.data.command.startsWith('/pay ')).length!==1)continue;
    const uncertain=events.find(event=>event.kind==='PAY_UNCERTAIN');
    if(!uncertain||String(uncertain.data.before)!==String(row.before_balance)||!/^\d+$/.test(String(uncertain.data.after))||
      BigInt(uncertain.data.before)-BigInt(uncertain.data.after)!==BigInt(uncertain.data.delta))continue;
    const post=events.findIndex((event,index)=>index>sent&&event.kind==='command'&&event.data.command==='/bal');
    if(post<0)continue;
    const matching=events.slice(sent+1,post).filter(event=>event.kind==='chat'&&rateFromEvidence({line:event.data.raw,recipient:order.buyerIgn,command:row.command_amount,debit:uncertain.data.delta,position:event.data.position,sender:event.data.sender})!==null);
    if(matching.length!==1)continue;
    const rate=rateFromEvidence({line:matching[0].data.raw,recipient:order.buyerIgn,command:row.command_amount,debit:uncertain.data.delta,position:matching[0].data.position,sender:matching[0].data.sender});
    return {basisPoints:rate,orderId:row.id,accountId:row.account_id};
  }
  return null;
}
module.exports={amount,rateFromEvidence,observedRate};
