'use strict';
const DEFAULT_OPENING='Thanks for the order!\n\nPlease reply with only your Minecraft IGN — the name on the scoreboard on the right (example picture attached).\n\n• If your name contains an underscore (_), put the whole name in quotes: "_Steve" or "_MS_2".\n• Bedrock: include the dot at the start, e.g. .Steve.\n\nI’ll ask you to confirm with Y or N, then send the coins.\n\nType cancel if you want this order cancelled.';
function confirmationPrompt(ign,amount){
 if(amount!=null)return require('./customer-messages').render('confirm',{amount,ign});
 const amountLine=/^[1-9][0-9]*$/.test(String(amount))?'Sending '+BigInt(amount).toLocaleString('en-US')+' Donut dollars to "'+ign+'".':'Confirm your Minecraft IGN: "'+ign+'".';
 return amountLine+'\nReply Y to confirm or N to enter it again.';
}
function quantityForOrder(order,reference){
 if(!require('../services').gameBridge)return undefined;
 const amount=/^[1-9][0-9]*$/.test(String(order?.amount))?String(order.amount):require('./browser/observed-offers').coins(reference?.quantityDisplay||order?.quantityDisplay||'');
 if(!amount||!/^\d+$/.test(amount)||BigInt(amount)<1n)throw Error('The order amount is unavailable for buyer confirmation');
 return amount;
}
function selection(messages,{confirmIgn=true,...options}={}){
 if(!Array.isArray(messages)||messages.length>500)throw Error('Bounded captured message list required');
 // Even legacy confirmIgn=false cannot turn an unconfirmed candidate into authority.
 let latest=null,prompt=null,confirmed=false,confirmationMessageId=null,rejected=false,paused=false,cancelled=false,requiresClarification=false;
 const candidates=[];
 const revoke=()=>{prompt=null;confirmed=false;confirmationMessageId=null;};
 for(const message of messages){
  if(message.kind==='attachment')continue;
  if(message.peer===false){if(latest&&!paused&&!cancelled&&!rejected&&!requiresClarification&&[confirmationPrompt(latest.ign,options.amount),...(options.amount?['Sending '+BigInt(options.amount).toLocaleString('en-US')+' Donut dollars to "'+latest.ign+'".\nReply Y to confirm or N to enter it again.']:[])].includes(message.text.trim())){if(prompt!==message.id){confirmed=false;confirmationMessageId=null;}prompt=message.id;}continue;}
  if(message.peer!==true)continue;
  const result=require('./chat-rules').classify(message.text,undefined,{...options,expectIgn:true});
  if(['cancel','escalation','missing','ambiguous_cancel'].includes(result.intent)){
   revoke();paused=true;cancelled||=result.intent==='cancel';requiresClarification=true;continue;
  }
  if(['confirm_no','recipient_pause','ambiguous_ign'].includes(result.intent)){
   revoke();rejected=true;paused=true;requiresClarification=true;continue;
  }
  if(result.intent==='confirm_yes'){
   if(latest&&prompt&&!paused&&!cancelled&&!requiresClarification&&!rejected){confirmed=true;confirmationMessageId=message.id;}
   continue;
  }
  if(!['ign','recipient_correction'].includes(result.intent)||!result.entities.ign)continue;
  const candidate={messageId:message.id,ign:result.entities.ign,submitted:result.entities.submittedIgn,moneyActionsAllowed:false};
  candidates.push(candidate);
  if(!latest||latest.ign!==candidate.ign||rejected||result.intent==='recipient_correction')revoke();
  latest=candidate;rejected=false;paused=false;requiresClarification=false;
 }
 return {candidates,latest,confirmed:confirmed&&!cancelled,confirmationMessageId,promptMessageId:prompt,rejected,paused,cancelled,needsConfirmation:Boolean(latest&&!confirmed),requiresClarification:requiresClarification||cancelled,moneyActionsAllowed:false};
}
function revision(messages){return require('node:crypto').createHash('sha256').update(JSON.stringify(messages.filter(m=>m.peer===true&&m.kind!=='attachment').map(m=>[m.id,m.text]))).digest('hex');}
function ownerRecipient(services,order,reference){
 const event=services.db?.raw().prepare("SELECT data,wall_ms FROM delivery_events WHERE order_id=? AND kind='OWNER_CONFIRMED_RECIPIENT' ORDER BY wall_ms DESC LIMIT 1").get(order.id);
 if(!event)return null;
 const data=JSON.parse(event.data);
 if(data.offerId!==order.offerId||String(data.amount)!==String(order.amount)||data.buyer!==(order.buyerMarketplaceId||order.buyerName)||!require('../minecraft/verified-payments').validIgn(data.ign,'.'))throw Error('Owner recipient confirmation differs from this funded order.');
 if(!reference||!data.conversationRevision||data.conversationRevision!==revision(reference.messages))return null;
 return {latest:{ign:data.ign,messageId:'owner-confirmation:'+event.wall_ms},confirmed:true,confirmationMessageId:'owner-confirmation:'+event.wall_ms,requiresClarification:false,source:'Explicit owner confirmation, recorded separately from buyer messages'};
}
module.exports={DEFAULT_OPENING,confirmationPrompt,quantityForOrder,selection,ownerRecipient,revision};
