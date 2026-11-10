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
async function sendStage(services,order,stage,authorize){
  const id='customer-'+stage+':'+order.id;
  const engine=require('./customer-message-config').forServices(services);
  const beforeSend=async reference=>{
    await authorize();
    const config=await services.settings.get('eldorado.chat.local');
    if(!config.autoSend)throw Error('Automatic buyer chat is paused');
    if(stage==='sending'){
      const flow=require('./order-chat-flow'),selected=flow.ownerRecipient(services,order,reference)||flow.selection(reference.messages,{...config,amount:order.amount,confirmIgn:true,orderId:order.id,services});
      if(!selected.confirmed||selected.latest?.ign!==order.buyerIgn)throw Error('Buyer changed their recipient or confirmation before payment');
    }
  };
  if(stage==='sending'&&engine){
    const confirmed=engine.schedule('buyer_confirmed',order,'customer-buyer-confirmed:'+order.id);
    if(confirmed.enabled){await services.browserBridge.sendOrderMessageObserved(order.browserOrder,confirmed.text,confirmed.id,order.browserBinding.sellerHref,beforeSend);engine.finish(confirmed.id);}
  }
  const scheduled=engine?.schedule({sending:'payment_started',proof:'proof_ready'}[stage],order,id);
  // Old requests retain their exact text for reconciliation after upgrading.
  const old=services.db?.raw().prepare("SELECT request FROM browser_actions WHERE operation='sendMessageObserved' AND resource_id=? AND json_extract(request,'$.messageId')=? LIMIT 1").get(order.id,id);
  const text=old?JSON.parse(old.request).text:scheduled?scheduled.text:render(stage,{amount:order.amount,ign:order.buyerIgn});
  if(scheduled&&!scheduled.enabled&&!old)return Promise.resolve({skipped:true});
  const result=await services.browserBridge.sendOrderMessageObserved(order.browserOrder,text,id,order.browserBinding.sellerHref,beforeSend);engine?.finish(id);return result;
}
function sendNameGuide(services,order,sellerHref){
  return services.browserBridge.uploadOrderEvidenceObserved(order,path.join(guideDirectory,'which-name.jpg'),sellerHref,async()=>{
    const policy=await services.settings.get('listing.policy');
    if(!await require('../treasury/trading-controls').globallyEnabled(services.settings)||!(await services.settings.get('eldorado.chat.local')).autoSend||policy.observedSellerHref!==sellerHref)throw Error('Buyer chat was paused or the seller changed');
  });
}
module.exports={templates,guideDirectory,render,displayAmount,sendStage,sendNameGuide};

