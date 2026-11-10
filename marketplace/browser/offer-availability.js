'use strict';
const {readOffers,hasFreshRead,URL}=require('./observed-offers');
function requirePack(pack){
  if(!pack?.verified||!pack.source||!pack.paused?.status||!pack.paused.button||!pack.active?.status||!pack.active.button)throw Error('The observed offer resume/pause result still needs review. This does not require a funded-order or payment setup.');
}
function state(offer,pack){
  requirePack(pack);
  if(pack.closed?.source&&offer.status===pack.closed.status)return 'closed';
  for(const [name,entry] of Object.entries({paused:pack.paused,active:pack.active})){
    if(offer.status===entry.status && offer.buttons.filter(label=>label===entry.button).length===1)return name;
  }
  throw Error('Offer status/control changed: '+offer.status+'. No toggle was inferred.');
}
function select(result,id,sellerHref){
  if(result.sellerHref!==sellerHref)throw Error('This seller identity differs from the account where you selected the offer. No offer action was performed.');
  const matches=result.offers.filter(offer=>offer.id===id);
  if(matches.length!==1)throw Error('The exact selected offer is missing or ambiguous. Select it from Find my existing offers.');
  return matches[0];
}
function stockDecision(offer,balance,threshold,reserve='0',{availabilityOnly=false}={}){
  const {integer}=require('../../minecraft/verified-payments');
  const available=integer(balance)>integer(reserve)?integer(balance)-integer(reserve):0n;
  const eligible=available>=integer(threshold);
                                                                         
                                                                              
  if(!availabilityOnly){
    const quantity=integer(offer.quantityCoins),minimum=integer(offer.minimumCoins);
    if(!quantity||!minimum||minimum>quantity)throw Error('The offer quantity or minimum is invalid. Edit the existing offer in Eldorado.');
    if(eligible&&(quantity>available||minimum>available))throw Error(`Your offer lists ${quantity} coins with minimum ${minimum}, but this pair has ${available} available. Reduce the offer quantity/minimum or add stock.`);
  }
  return {eligible,available:available.toString(),balance:String(balance),threshold:String(threshold)};
}
async function setAvailability(page,{id,paused,sellerHref,pack,timeoutMs=15000,beforeClick=async()=>{},check=()=>{}}){
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||typeof paused!=='boolean')throw Error('A captured offer UUID and boolean availability are required.');
  requirePack(pack);check();
                                                                          
                                                                              
                                                                     
  const before=select(await readOffers(page,timeoutMs,{availabilityOnly:true,refresh:!hasFreshRead(page,timeoutMs)}),id,sellerHref);
  const desired=paused?'paused':'active',current=state(before,pack);
  if(current==='closed'){
    if(paused)return {confirmed:true,changed:false,offer:before,paused:null,closed:true};
    throw Error('Your offer is Closed. Check Sold Orders for the incoming order. After resolving it, replenish or edit the existing offer in Eldorado; no Resume click was inferred for a closed listing.');
  }
  if(current===desired)return {confirmed:true,changed:false,offer:before,paused};
  const row=page.locator('eld-dashboard-offers-list-item').filter({has:page.locator(`a[aria-label="Edit"][href="/dashboard/offers/Currency/edit/${id}"]`)});
  if(await row.count()!==1)throw Error('Selected offer row changed before its toggle.');
  const button=row.getByRole('button',{name:pack[current].button,exact:true});
  if(await button.count()!==1||!await button.isEnabled())throw Error('The observed offer toggle is missing, duplicated or disabled.');
                                                                             
                                                                            
  try{await button.click({trial:true,timeout:timeoutMs});}catch(error){throw new Error(`Eldorado’s ${pack[current].button} button is not ready. Reconnect the seller browser if its background connection was lost, or check for a login challenge or page overlay. No offer click was sent by this readiness check.`,{cause:error});}check();
  await beforeClick(before);check();
  if(page.url()!==URL)throw Error('Offer page changed before its toggle; no click was sent.');
  await button.click({timeout:timeoutMs});
  await page.waitForFunction(({id,status,label})=>{
    const rows=[...document.querySelectorAll('eld-dashboard-offers-list-item')].filter(row=>row.getClientRects().length&&row.querySelector(`a[aria-label="Edit"][href="/dashboard/offers/Currency/edit/${id}"]`));
    return rows.length===1&&rows[0].querySelector('eld-chip')?.textContent.trim()===status&&[...rows[0].querySelectorAll('button[aria-label]')].filter(button=>button.getClientRects().length&&button.getAttribute('aria-label')===label).length===1;
  },{id,status:pack[desired].status,label:pack[desired].button},{timeout:timeoutMs});
  check();
  const after=select(await readOffers(page,timeoutMs,{availabilityOnly:true,refresh:false}),id,sellerHref);
  if(page.url()!==URL||state(after,pack)!==desired)throw Error('Offer toggle result changed or is unconfirmed; inspect it before retrying.');
  return {confirmed:true,changed:true,offer:after,paused};
}
module.exports={requirePack,state,select,stockDecision,setAvailability};
