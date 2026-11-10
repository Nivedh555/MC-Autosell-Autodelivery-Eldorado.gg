'use strict';
const flow=require('./order-chat-flow');
function current(draft,reference,order,config){
  if(!['recipient_confirmation','recipient_correction','recipient_clarification'].includes(draft.intent))return true;
  const amount=flow.quantityForOrder(order,reference),selected=flow.selection(reference.messages,{...config,amount,orderId:order.id});
  if(selected.cancelled||selected.confirmed)return false;
  if(draft.intent==='recipient_confirmation')return Boolean(selected.latest&&!selected.requiresClarification&&!selected.rejected&&flow.isConfirmation(draft.text,selected.latest.ign,amount,{orderId:order.id,revision:flow.revision(reference.messages)}));
  if(draft.intent==='recipient_clarification')return draft.id==='ai-suggest:'+order.id+':'+flow.revision(reference.messages)&&(!selected.latest||selected.requiresClarification);
  return (!selected.latest||selected.requiresClarification)&&(!draft.id.startsWith('ign-clarify:')||draft.id==='ign-clarify:'+order.id+':'+flow.revision(reference.messages));
}
module.exports={current};
