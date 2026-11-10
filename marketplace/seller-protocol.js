'use strict';
const spec=require('./contract/seller-openapi.json');
const schemas=spec.components.schemas;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const source='https://www.eldorado.gg/swagger/seller/index.html';
function schema(s){return s.$ref?schemas[s.$ref.split('/').at(-1)]:s;}
function validate(value,definition,at='request'){
 const s=schema(definition);if(value===null&&s.nullable)return;
 if(typeof value==='number'&&((s.minimum!==undefined&&value<s.minimum)||(s.maximum!==undefined&&value>s.maximum)))throw Error(at+' is outside the documented range');
 if(s.enum&&!s.enum.includes(value))throw Error(at+' has an unsupported value');
 if(s.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(at+' must be an object');
  for(const key of s.required||[])if(value[key]===undefined)throw Error(at+'.'+key+' is required');
  for(const [key,item]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid request property');if(!s.properties?.[key]){if(s.additionalProperties===false)throw Error(at+'.'+key+' is not in the API schema');continue;}validate(item,s.properties[key],at+'.'+key);}
 }else if(s.type==='array'){if(!Array.isArray(value)||value.length>1000)throw Error(at+' must be a bounded array');value.forEach((v,i)=>validate(v,s.items,at+'['+i+']'));}
 else if(s.type==='integer'){if(!Number.isSafeInteger(value)||(s.format==='int32'&&(value< -2147483648||value>2147483647)))throw Error(at+' must be an exact supported integer');}
 else if(s.type==='number'){if(typeof value!=='number'||!Number.isFinite(value))throw Error(at+' must be finite');}
 else if(s.type==='string'){if(typeof value!=='string'||value.length>20000||(s.format==='uuid'&&!UUID.test(value)))throw Error(at+' must be a valid '+(s.format||'string'));}
 else if(s.type==='boolean'&&typeof value!=='boolean')throw Error(at+' must be boolean');
}
function operation(path,method){const op=spec.paths[path]?.[method.toLowerCase()];if(!op)throw Error('Endpoint is absent from the supplied Seller API definition');return op;}
function requestBody(path,method,value){const op=operation(path,method),s=op.requestBody?.content?.['application/json']?.schema;if(s)validate(value,s);else if(value!==undefined)throw Error('This endpoint has no documented request body');}
function dto(value){
                                                                               
 function pick(v,s){s=schema(s);if(v===null)return v;if(s.type==='object'){const out={};for(const [key,child]of Object.entries(s.properties||{}))if(v?.[key]!==undefined)out[key]=pick(v[key],child);return out;}if(s.type==='array')return v.map(item=>pick(item,s.items));return v;}
 const definition=Object.values(schemas).find(s=>s.properties?.augmentedGame&&s.properties?.details);
 const result=pick(value,definition);validate(result,definition);return result;
}
function unitCoins(name){
 const named={Unit1Quadrillion:15,Unit1Quintillion:18,Unit1Sextillion:21,Unit1Septillion:24,Unit1Octillion:27,Unit1Nonillion:30,Unit1Decillion:33};
 if(Object.hasOwn(named,name))return 10n**BigInt(named[name]);
 if(/^Unit(?:1|1000|1000000|1000000000|1000000000000)$/.test(name))return BigInt(name.slice(4));
 throw Error('The order has an unsupported currency unit: '+String(name));
}
function decimal(value,scale=1000000n){
 let text=String(value).trim();if(text.length>256)throw Error('Price is too long');if(text.startsWith('.'))text='0'+text;
 const m=/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);if(!m)throw Error('Price must be a positive decimal');
 const digits=BigInt(m[1]+(m[2]||'')),exponent=Number(m[3]||0)-(m[2]||'').length;
 if(Math.abs(exponent)>40)throw Error('Price precision is unsupported');
 const numerator=digits*scale*(exponent>0?10n**BigInt(exponent):1n),denominator=exponent<0?10n**BigInt(-exponent):1n;
 if(numerator%denominator)throw Error('Price has more precision than this setting supports');return numerator/denominator;
}
function fixed(amount,places=6){const scale=10n**BigInt(places),n=BigInt(amount);return String(n/scale)+(places?'.'+String(n%scale).padStart(places,'0'):'');}
function priceForUnit(perBillion,unit){return Number(fixed(decimal(perBillion)*BigInt(unit),15));}
function perBillion(price,unit){return decimal(price,1000000000000000n)/BigInt(unit);}
function undercut(rows,settings,ownIds=new Set()){
 if(settings.priceMode==='market'&&settings.undercutEnabled){
  const floor=decimal(settings.floorPrice),step=decimal(settings.undercutBy||'0.01');
  if(floor<=0n||step<=0n)throw Error('Enter a positive minimum price and undercut decrement.');
  const minimum=BigInt(settings.competitorMinCoins||'0');
  const eligible=rows.filter(row=>!ownIds.has(row.id)&&!row.isOwn&&row.currency==='USD'&&BigInt(row.quantityCoins)>=minimum&&decimal(row.pricePerBillion)>0n);
  if(!eligible.length){if(!settings.fallbackPrice)throw Error('No competitor meets your stock filter. Waiting for an eligible price; optionally enter a fallback selling price.');const fallback=decimal(settings.fallbackPrice);if(fallback<floor)throw Error('Fallback selling price cannot be below the minimum price.');return fixed(fallback);}
  const best=eligible.reduce((n,row)=>{const price=decimal(row.pricePerBillion);return price<n?price:n;},decimal(eligible[0].pricePerBillion));
  return fixed(best>floor+step?best-step:floor);
 }
 const base=decimal(settings.basePrice),floor=settings.undercutEnabled?decimal(settings.floorPrice||settings.basePrice):base,step=settings.undercutEnabled?decimal(settings.undercutBy||'0.01'):1n;
 if(base<=0n||floor<=0n||floor>base||step<=0n)throw Error('Set a positive base price and decrement; minimum price cannot exceed the base price.');
 let result=base;
 if(settings.undercutEnabled){const minimum=BigInt(settings.competitorMinCoins||'0');const eligible=rows.filter(row=>!ownIds.has(row.id)&&!row.isOwn&&row.currency==='USD'&&BigInt(row.quantityCoins)>=minimum&&decimal(row.pricePerBillion)>0n);
  if(eligible.length){const best=eligible.reduce((n,row)=>{const p=decimal(row.pricePerBillion);return p<n?p:n;},decimal(eligible[0].pricePerBillion));result=best>step?best-step:floor;if(result>base)result=base;if(result<floor)result=floor;}}
 return fixed(result);
}
function automaticSettings(value={}){
 if(typeof value.enabled!=='boolean')throw Error('Choose whether to create offers automatically.');
 if(!value.enabled)return value;
 if(!/^\d+$/.test(String(value.minPurchaseCoins))||BigInt(value.minPurchaseCoins)<1n)throw Error('Minimum purchase must be positive whole coins.');
 if(value.source==='direct'&&BigInt(value.minPurchaseCoins)%1000000n)throw Error('Minimum purchase is entered in coins and must be a multiple of 1,000,000 (1M). For a 100M minimum, enter 100000000, not 100.');
 if(typeof value.undercutEnabled!=='boolean')throw Error('Choose whether undercutting is enabled.');
 if(!/^\d+$/.test(String(value.competitorMinCoins||'0')))throw Error('Competitor stock must be whole coins.');
 if(value.source==='direct'){
  if(typeof value.description!=='string'||!value.description.trim()||value.description.length>20000)throw Error('Enter the description for your automatic DonutSMP offers.');
  validate(value.guaranteedDeliveryTime,schemas['Eldorado.SharedKernel.Domain.Enums.GuaranteedDeliveryTime'],'Guaranteed delivery time');
 }
 const price=(key,label,{optional=false,fallback}={})=>{
  const raw=value[key],text=String(raw??'').trim();
  if(optional&&!text){value[key]='';return;}
  const chosen=(raw==null||raw==='')&&fallback!==undefined?fallback:text;
  try{if(decimal(chosen)<=0n)throw Error('Price must be positive');}
  catch(error){throw Error(label+' (USD per billion) must be a positive decimal with at most 6 decimal places. Enter a value such as 6.10, without a currency symbol.',{cause:error});}
  value[key]=chosen;
 };
 if(value.priceMode!=='market'||!value.undercutEnabled)price('basePrice','Selling price');
 if(value.undercutEnabled){
  price('floorPrice','Minimum price',value.priceMode==='market'?{}:{fallback:value.basePrice});
  price('undercutBy','Undercut amount',{fallback:'0.01'});
  if(value.priceMode==='market')price('fallbackPrice','Fallback selling price',{optional:true});
 }
 if(value.priceMode==='market'&&value.undercutEnabled){
  if(decimal(value.floorPrice)<=0n||decimal(value.undercutBy||'0.01')<=0n)throw Error('Enter a positive minimum price and undercut decrement.');
  if(value.fallbackPrice&&decimal(value.fallbackPrice)<decimal(value.floorPrice))throw Error('Fallback selling price cannot be below the minimum price.');
 }else undercut([],value);return value;
}
function automaticQuantities(binding,settings,stock){
 const unit=BigInt(binding.unitCoins),minimum=BigInt(settings.minPurchaseCoins),quantity=BigInt(stock),format=n=>n.toLocaleString('en-US');
 if(unit<=0n)throw Error('The seller API currency unit is missing. Reconnect the matching seller browser and check the connection.');
 if(minimum<unit||minimum%unit)throw Error('Minimum purchase is '+format(minimum)+' coins. Eldorado requires multiples of '+format(unit)+' coins per currency unit. Enter the full coin amount: 100M = 100000000 coins.');
 if(quantity<=0n||quantity%unit)throw Error('Pair threshold is '+format(quantity)+' coins. Set it to a positive multiple of '+format(unit)+' coins.');
 if(minimum>quantity)throw Error('Minimum purchase ('+format(minimum)+' coins) exceeds this pair\'s threshold ('+format(quantity)+' coins). Lower the minimum purchase or raise the pair threshold.');
 if(quantity/unit>2147483647n)throw Error('Pair threshold exceeds the Seller API quantity limit of 2,147,483,647 currency units.');
 return {unit,minimum,quantity};
}
function automaticDraft(binding,settings,stock,price){
 const {unit,minimum,quantity}=automaticQuantities(binding,settings,stock);
 const draft=binding.source==='direct'?{augmentedGame:{gameId:binding.gameId,category:'Currency',tradeEnvironmentId:null},details:{description:settings.description.trim(),guaranteedDeliveryTime:settings.guaranteedDeliveryTime,deliveryMethod:'InGameTrade'}}:structuredClone(binding.template);
 draft.details.pricing={quantity:Number(quantity/unit),minQuantity:Number(minimum/unit),pricePerUnit:{amount:priceForUnit(price,unit),currency:'USD'},volumeDiscounts:[]};
 return dto(draft);
}
function bindingKey(binding){return binding?.key||binding?.templateId;}
function sameAutomaticOffer(actual,requested){
                                                                               
                                                                                
 const canonical=value=>{
  const out=dto(value),game=out.augmentedGame,details=out.details;
  game.tradeEnvironmentId??=null;game.offerAttributes??=[];
  details.pricing.volumeDiscounts??=[];
  details.description=(details.description||'').replace(/\r\n/g,'\n').trim();
  delete details.pricing.quantity;
  return out;
 };
 return require('node:util').isDeepStrictEqual(canonical(actual),canonical(requested));
}
function createdOfferId(response){
 const data=response?.data??response;
 const ids=[typeof data==='string'?data:null,data?.id,data?.offerId,data?.offer?.id];
 const location=response?.headers?.get?.('location');
 if(location){try{const url=new URL(location,'https://www.eldorado.gg');if(url.origin==='https://www.eldorado.gg')ids.push(url.pathname.split('/').filter(Boolean).at(-1));}catch{}}
 const unique=[...new Set(ids.filter(id=>typeof id==='string'&&UUID.test(id)))];
 if(unique.length>1)throw Error('Eldorado returned conflicting IDs for the new offer. Its result must be checked before retrying.');
 return unique[0]||null;
}
module.exports={spec,source,UUID,schema,validate,operation,requestBody,dto,unitCoins,decimal,fixed,priceForUnit,perBillion,undercut,automaticSettings,automaticQuantities,automaticDraft,bindingKey,sameAutomaticOffer,createdOfferId};
