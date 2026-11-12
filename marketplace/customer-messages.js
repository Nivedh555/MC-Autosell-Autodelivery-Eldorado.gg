'use strict';
const path=require('node:path');
const fs=require('node:fs');
const templates=require('../web/dist/buyer-guides/messages.json');
const guideDirectory=path.resolve(__dirname,'../web/dist/buyer-guides');
const customGuideDirectory=path.join(require('../constants').DEFAULT_DATA_DIR,'buyer-guides');
const guideSlots=Object.freeze({'username':'which-name.jpg','confirm':'how-to-confirm-1.png','feedback':'how-to-confirm-2.png'});
function guidePath(slot){
  const name=guideSlots[slot];
  if(!name)throw Error('Unknown buyer guide image');
  const custom=path.join(customGuideDirectory,slot+'.png');
  return fs.existsSync(custom)?custom:path.join(guideDirectory,name);
}
function saveGuide(slot,dataUrl,directory=customGuideDirectory){
  if(!Object.hasOwn(guideSlots,slot))throw Error('Unknown guide image');
  const match=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl||'');
  if(!match)throw Error('Choose a PNG image');
  const image=Buffer.from(match[1],'base64');
  const width=image.length>=24?image.readUInt32BE(16):0,height=image.length>=24?image.readUInt32BE(20):0;
  if(image.length>1024*1024||image.length<50||!image.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||!width||!height||width>4096||height>4096)
    throw Error('PNG must be under 1 MB and at most 4096 × 4096 pixels');
  require('pngjs').PNG.sync.read(image,{checkCRC:true});
  fs.mkdirSync(directory,{recursive:true});
  const target=path.join(directory,slot+'.png'),temporary=target+'.tmp-'+require('node:crypto').randomUUID();
  fs.writeFileSync(temporary,image,{flag:'wx'});
  try{fs.renameSync(temporary,target);}catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
  return 'data:image/png;base64,'+image.toString('base64');
}
function validateTemplates(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==Object.keys(templates).sort().join())throw Error('Provide all five buyer message stages');
  for(const [key,text] of Object.entries(value)){
    if(typeof text!=='string'||!text.trim()||text.length>(key==='opening'?500:4000))throw Error('Invalid '+key+' message length');
    const allowed=key==='opening'?new Set(['buyer','amount','url']):key==='confirm'?new Set(['amount','ign']):new Set(['buyer','amount','ign','url']);
    for(const match of text.matchAll(/\{([^{}]+)\}/g))if(!allowed.has(match[1]))throw Error('Unknown '+key+' placeholder: '+match[1]);
    if(key==='opening'&&/i(?:'m| am) (?:a )?human|not (?:a )?(?:bot|automated)|official proof|(?:attached|uploaded|included|sent).{0,30}(?:pic(?:ture)?|screenshot|attachment|proof)/i.test(text))throw Error('Greeting must not claim a proof or attachment was sent before upload');
  }
  if(!value.confirm.includes('{ign}')||!value.confirm.includes('{amount}'))throw Error('Recipient confirmation must include {ign} and {amount}');
  if(!value.delivered.includes('{url}'))throw Error('Delivery message must include {url}');
  return value;
}
function displayAmount(value){
  if(!/^[1-9][0-9]*$/.test(String(value)))throw Error('A funded order amount is required for buyer chat');
  const coins=BigInt(value);
  for(const [unit,zeros]of [['T',12],['B',9],['M',6],['K',3]]){
    const scale=10n**BigInt(zeros);
    if(coins>=scale){const fraction=String(coins%scale).padStart(zeros,'0').replace(/0+$/,'');return String(coins/scale)+(fraction?'.'+fraction:'')+unit;}
  }
  return String(coins);
}
function render(kind,{buyer,amount,ign,url}={},selected=templates){
  const fields={buyer,ign,url};
  if(amount!=null)fields.amount=displayAmount(amount);
  return selected[kind].replace(/\{(buyer|ign|amount|url)\}/g,(_match,key)=>{
    if(!fields[key])throw Error('Missing '+key+' for '+kind+' message');
    return String(fields[key]).replace(/[\r\n\t]+/g,' ').slice(0,200);
  });
}
async function renderConfigured(services,kind,fields){
  const selected=await services.settings?.get?.('eldorado.chat.templates');
  return render(kind,fields,selected==null?templates:validateTemplates(selected));
}
async function sendStage(services,order,stage,authorize){
  const recipientAmount=require('./order-chat-flow').quantityForOrder(order,order.browserOrder?.orderReference);
  const text=await renderConfigured(services,stage,{buyer:order.buyerName||order.buyerMarketplaceId,amount:recipientAmount||order.amount,ign:order.buyerIgn,url:'https://www.eldorado.gg/order/'+order.id});
  return services.browserBridge.sendOrderMessageObserved(order.browserOrder,text,'customer-'+stage+':'+order.id,order.browserBinding.sellerHref,async reference=>{
    await authorize();
    const config=await services.settings.get('eldorado.chat.local');
    if(!config.autoSend)throw Error('Automatic buyer chat is paused');
    if(stage==='sending'){
      const flow=require('./order-chat-flow'),selected=flow.ownerRecipient(services,order,reference)||flow.selection(reference.messages,{...config,amount:recipientAmount||order.amount,confirmIgn:true});
      if(!selected.confirmed||selected.latest?.ign!==order.buyerIgn)throw Error('Buyer changed their recipient or confirmation before payment');
    }
  });
}
function sendNameGuide(services,order,sellerHref){
  return services.browserBridge.uploadOrderEvidenceObserved(order,guidePath('username'),sellerHref,async()=>{
    const policy=await services.settings.get('listing.policy');
    if(!await require('../treasury/trading-controls').globallyEnabled(services.settings)||!(await services.settings.get('eldorado.chat.local')).autoSend||policy.observedSellerHref!==sellerHref)throw Error('Buyer chat was paused or the seller changed');
  });
}
module.exports={templates,guideDirectory,customGuideDirectory,guideSlots,guidePath,saveGuide,validateTemplates,render,renderConfigured,displayAmount,sendStage,sendNameGuide};

