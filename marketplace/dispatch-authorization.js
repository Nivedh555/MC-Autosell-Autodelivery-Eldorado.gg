'use strict';
const flow=require('./order-chat-flow');
async function validateRecipient(services,order,account){
  await services.browserFulfillment.authorize(order,account);
  // This read rechecks API/seller identity in hybrid mode and the exact private
  // order room. It runs after command pacing, immediately before bot.chat.
  const reference=await services.browserBridge.inspectOrderReference(order.browserOrder,{paymentDispatch:true});
  if(reference.id===order.id&&reference.buyerName===order.buyerMarketplaceId&&reference.status!=='Pending delivery'){
    services.deliveryService.repo.applyMarketplaceStatus(order.id,reference.status);
    throw Error('Order funded status changed before payment dispatch');
  }
  if(reference.id!==order.id||reference.buyerName!==order.buyerMarketplaceId||reference.status!=='Pending delivery'||require('./browser/observed-offers').coins(reference.quantityDisplay)!==String(order.amount))throw Error('Order identity, amount or funded status changed before payment dispatch');
  const config=await services.settings.get('eldorado.chat.local');
  const selected=flow.ownerRecipient(services,order,reference)||flow.selection(reference.messages,{...config,amount:order.amount,confirmIgn:true});
  if(!selected.confirmed||selected.requiresClarification||selected.cancelled||selected.latest?.ign!==order.buyerIgn)throw Error('Buyer changed their recipient or confirmation before payment dispatch');
  await services.browserFulfillment.authorize(order,account);
  // Browser-only mode just read a freshly loaded seller history and order room.
  // In hybrid mode ask the API again after the chat read, immediately before dispatch.
  if(order.hybridWorkflow)await services.browserFulfillment.assertPending(order);
  services.deliveryService.repo.event(order.id,'DISPATCH_AUTHORIZED',{recipient:order.buyerIgn,amount:String(order.amount),conversationRevision:flow.revision(reference.messages),confirmationMessageId:selected.confirmationMessageId});
}
module.exports={validateRecipient};
