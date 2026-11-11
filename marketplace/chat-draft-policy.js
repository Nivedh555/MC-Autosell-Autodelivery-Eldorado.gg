'use strict';
const flow=require('./order-chat-flow');
function current(draft,reference,order,config){
  if(!['recipient_confirmation','recipient_correction','recipient_clarification'].includes(draft.intent))return true;
  const amount=flow.quantityForOrder(order,reference),selected=flow.selection(reference.messages,{...config,amount});
  if(selected.cancelled||selected.confirmed)return false;
  if(draft.intent==='recipient_confirmation')return Boolean(selected.latest&&!selected.requiresClarification&&!selected.rejected&&draft.text===flow.confirmationPrompt(selected.latest.ign,amount));
  if(draft.intent==='recipient_clarification')return draft.id==='ai-suggest:'+order.id+':'+flow.revision(reference.messages)&&(!selected.latest||selected.requiresClarification);
  return (!selected.latest||selected.requiresClarification)&&(!draft.id.startsWith('ign-clarify:')||draft.id==='ign-clarify:'+order.id+':'+flow.revision(reference.messages));
}
module.exports={current};
