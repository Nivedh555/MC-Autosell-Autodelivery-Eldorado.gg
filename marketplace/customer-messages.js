'use strict';
const path=require('node:path');
const templates=require('../web/dist/buyer-guides/messages.json');
const guideDirectory=path.resolve(__dirname,'../web/dist/buyer-guides');
function displayAmount(value){
  if(!/^[1-9][0-9]*$/.test(String(value)))throw Error('A funded order amount is required for buyer chat');
  const coins=BigInt(value);
  for(const [unit,zeros]of [['T',12],['B',9],['M',6],['K',3]]){
    const scale=10n**BigInt(zeros);
    if(coins>=scale){const fraction=String(coins%scale).padStart(zeros,'0').replace(/0+$/,'');return String(coins/scale)+(fraction?'.'+fraction:'')+unit;}
  }
  return String(coins);
}
function render(kind,{buyer,amount,ign,url}={}){
  const fields={buyer,ign,url};
  if(amount!=null)fields.amount=displayAmount(amount);
  return templates[kind].replace(/\{(buyer|ign|amount|url)\}/g,(_match,key)=>{
    if(!fields[key])throw Error('Missing '+key+' for '+kind+' message');
    return String(fields[key]).replace(/[\r\n\t]+/g,' ').slice(0,200);
  });
}
function sendStage(services,order,stage,authorize){
  const text=render(stage,{amount:order.amount,ign:order.buyerIgn});
  return services.browserBridge.sendOrderMessageObserved(order.browserOrder,text,'customer-'+stage+':'+order.id,order.browserBinding.sellerHref,async reference=>{
    await authorize();
    const config=await services.settings.get('eldorado.chat.local');
    if(!config.autoSend)throw Error('Automatic buyer chat is paused');
    if(stage==='sending'){
      const flow=require('./order-chat-flow'),selected=flow.ownerRecipient(services,order,reference)||flow.selection(reference.messages,{...config,amount:order.amount,confirmIgn:true});
      if(!selected.confirmed||selected.latest?.ign!==order.buyerIgn)throw Error('Buyer changed their recipient or confirmation before payment');
    }
  });
}
function sendNameGuide(services,order,sellerHref){
  return services.browserBridge.uploadOrderEvidenceObserved(order,path.join(guideDirectory,'which-name.jpg'),sellerHref,async()=>{
    const policy=await services.settings.get('listing.policy');
    if(!await require('../treasury/trading-controls').globallyEnabled(services.settings)||!(await services.settings.get('eldorado.chat.local')).autoSend||policy.observedSellerHref!==sellerHref)throw Error('Buyer chat was paused or the seller changed');
  });
}
module.exports={templates,guideDirectory,render,displayAmount,sendStage,sendNameGuide};

