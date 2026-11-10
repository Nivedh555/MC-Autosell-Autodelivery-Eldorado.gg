'use strict';
const {coins}=require('./observed-offers');
                                                                               
function normalize(order,reference,offers,listing,policy){
  if(offers.sellerHref!==listing.observedSellerHref)throw Error('Seller account differs from the selected offer');
  const candidates=offers.offers.filter(offer=>offer.gameLabel==='DonutSMP');
  if(candidates.length!==1||candidates[0].id!==listing.offerId)throw Error('Automatic order routing requires exactly one selected DonutSMP currency offer in this seller account');
  if(!order.marketplaceIdCaptured||order.typeDisplay!=='Currency'||order.gameLabel!=='DonutSMP'||reference.id!==order.id||reference.buyerName!==order.buyerName||reference.quantityDisplay!==order.quantityDisplay||reference.gameLabel!==order.gameLabel)throw Error('Order detail does not match its captured Sold Orders row');
  if(order.status!=='Pending delivery'||reference.status!=='Pending delivery'||!reference.controls.includes('Order delivered'))throw Error('This order is not awaiting seller delivery');
  const intents=reference.messages.filter(message=>message.peer&&message.kind!=='attachment').map(message=>require('../chat-rules').classify(message.text).intent);
  if(intents.some(intent=>['cancel','escalation','missing'].includes(intent)))throw Error('Buyer requested cancellation or raised a delivery dispute; review before sending money');
  const flow=require('../order-chat-flow'),recipient=flow.selection(reference.messages,{...policy.chat,amount:flow.quantityForOrder(order,reference),orderId:order.id});
  if(!recipient.latest||recipient.requiresClarification)return null;
  if(!recipient.confirmed)return null;
  const amount=coins(reference.quantityDisplay);
  if(BigInt(amount)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Order amount exceeds exact supported integer storage');
  return {id:order.id,buyerIgn:recipient.latest.ign,buyerMarketplaceId:order.buyerName,amount,unitSize:'1000000',offerId:listing.offerId,
    gameId:'DonutSMP',serverId:'DonutSMP',status:reference.status,browserWorkflow:true,
    orderReference:reference,browserOrder:order,browserBinding:{sellerHref:offers.sellerHref,offerId:listing.offerId,
      scope:'Local routing to the sole selected DonutSMP currency offer; no remote offer ID is claimed from the order page',
      recipientSource:recipient.latest.messageId,recipientScope:'Incoming direction in the exact buyer-profile-bound private order chat'},
    source:'Captured Sold Orders, matching seller detail, and matching private buyer chat',deadlineMs:policy.deadlineMs||undefined};
}
module.exports={normalize};
