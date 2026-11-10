'use strict';
                                                                            
                                                                           
                                                                               
const OFFERS_URL='https://www.eldorado.gg/dashboard/offers/Currency';
const captures=new WeakMap(),tracked=new WeakSet();
function hasFreshRead(page,maxAgeMs){
  const capture=captures.get(page);
  return Boolean(capture&&page.url()===OFFERS_URL&&Date.now()-capture.at<=maxAgeMs);
}
function coins(text){
  const match=/^(\d+(?:,\d{3})*)(?:\.(\d{1,6}))? M$/.exec(text);
  if(!match)throw Error('Unrecognized offer quantity unit; expected the observed M display');
  return (BigInt(match[1].replaceAll(',',''))*1000000n+BigInt((match[2]||'').padEnd(6,'0'))).toString();
}
function normalize(snapshot,{availabilityOnly=false}={}){
  if(!snapshot.sellerHref||new URL(snapshot.sellerHref).origin!=='https://www.eldorado.gg'||!/^\/users\/[^/]+$/.test(new URL(snapshot.sellerHref).pathname))throw Error('Logged-in seller identity was not captured');
  if(snapshot.rows.length>200)throw Error('Offer count exceeds the bounded reader');
  if(!snapshot.rows.length&&!snapshot.empty)throw Error('Offer list is missing or still loading; no offers were inferred');
  const ids=new Set();
  const offers=snapshot.rows.map(row=>{
    const link=new URL(row.editHref);const match=/^\/dashboard\/offers\/Currency\/edit\/([0-9a-f-]{36})$/.exec(link.pathname);
    if(link.origin!=='https://www.eldorado.gg'||!match||ids.has(match[1]))throw Error('Offer identity is missing, duplicated or changed');ids.add(match[1]);
                                                                            
                                                                                  
                                                                               
                                                                               
    const closed=row.status===require('./availability-pack.json').closed?.status;
    if(!row.game||!row.status||(!availabilityOnly&&((!row.quantity&&!closed)||!row.minimum)))throw Error('Offer fields are missing; review the seller page');
    const parse=text=>{if(!text)return null;try{return coins(text);}catch(error){if(!availabilityOnly)throw error;return null;}};
    return {id:match[1],gameLabel:row.game,status:row.status,quantityDisplay:row.quantity||null,minimumDisplay:row.minimum||null,quantityCoins:parse(row.quantity),minimumCoins:parse(row.minimum),deliveryTimeDisplay:row.deliveryTime||'not captured',buttons:row.buttons||[],sellerHref:snapshot.sellerHref,source:'captured Currency Offers DOM',liveVerified:false};
  });
  return {offers,sellerHref:snapshot.sellerHref,liveVerified:false};
}
async function readOffers(page,timeoutMs=15000,options={}){
  if(!tracked.has(page)){
    tracked.add(page);
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())captures.delete(page);});
  }
  captures.delete(page);
  const refresh=options.refresh!==false;
  const load=async()=>{
    if(page.url()!==OFFERS_URL)await page.goto(OFFERS_URL,{waitUntil:'domcontentloaded',timeout:timeoutMs});
    else if(refresh)await page.reload({waitUntil:'domcontentloaded',timeout:timeoutMs});
                                                                            
                                                                                
    await page.waitForFunction(({availabilityOnly})=>{
      const visible=node=>Boolean(node.getClientRects().length)&&getComputedStyle(node).visibility!=='hidden';
      if([...document.querySelectorAll('eld-dashboard-offers-list-skeleton, eld-dashboard-sidenav-user ngx-skeleton-loader')].some(visible))return false;
      if(!document.querySelector('eld-dashboard-sidenav-user a[href]')?.href)return false;
      const rows=[...document.querySelectorAll('eld-dashboard-offers-list-item')].filter(visible);
      if(!rows.length)return [...document.querySelectorAll('h1,h2,h3,p')].some(node=>visible(node)&&node.textContent.trim()==='Nothing found');
      return rows.every(row=>{
        const status=row.querySelector('eld-chip')?.textContent.trim();
        if(!row.querySelector('a[aria-label="Edit"][href]')?.href||!row.querySelector('p')?.textContent.trim()||!status)return false;
        const label=status==='Paused'?'Resume':status==='Active'?'Pause':null;
        if(label&&![...row.querySelectorAll('button[aria-label]')].some(node=>visible(node)&&node.getAttribute('aria-label')===label))return false;
        if(availabilityOnly)return true;
        const field=label=>[...row.querySelectorAll('p')].find(node=>node.textContent.trim()===label)?.parentElement.querySelector('strong')?.textContent.trim();
        return Boolean((status==='Closed'||field('Quantity:'))&&field('Min qty.:'));
      });
    },{availabilityOnly:options.availabilityOnly===true},{timeout:timeoutMs});
  };
  try{await load();}
  catch(error){
    if(error.name!=='TimeoutError')throw error;
                                                                             
                                                                                     
    if(refresh){try{await load();}catch(retry){if(retry.name!=='TimeoutError')throw retry;throw loadingError(timeoutMs,retry);}}
    else throw loadingError(timeoutMs,error);
  }
                                                                            
                                                                             
                                                                        
                                                                            
                                                                       
  await page.locator('eld-dashboard-sidenav-user a[href]').waitFor({state:'attached',timeout:timeoutMs});
  const snapshot=await page.evaluate(()=>{
    const visible=node=>Boolean(node?.getClientRects().length);
    const rows=[...document.querySelectorAll('eld-dashboard-offers-list-item')].filter(visible);
    return {sellerHref:document.querySelector('eld-dashboard-sidenav-user a[href]')?.href,empty:[...document.querySelectorAll('h1,h2,h3,p')].some(node=>visible(node)&&node.textContent.trim()==='Nothing found'),rows:rows.map(row=>{
      const field=label=>{const nodes=[...row.querySelectorAll('p')].filter(node=>node.textContent.trim()===label);if(nodes.length!==1)return null;return nodes[0].parentElement.querySelector('strong')?.textContent.trim();};
      return {editHref:row.querySelector('a[aria-label="Edit"]')?.href,game:row.querySelector('p')?.textContent.trim(),status:row.querySelector('eld-chip')?.textContent.trim(),buttons:[...row.querySelectorAll('button[aria-label]')].filter(visible).map(node=>node.getAttribute('aria-label')),quantity:field('Quantity:'),minimum:field('Min qty.:'),deliveryTime:field('Delivery time:')};
    })};
  });
  if(page.url()!==OFFERS_URL)throw Error('Seller page changed while reading offers');
  const result=normalize(snapshot,options);
  captures.set(page,{at:Date.now()});
  return result;
}
function loadingError(timeoutMs,cause){
  const error=new Error(`Eldorado’s Offers page did not finish loading within ${Math.ceil(timeoutMs/1000)} seconds per attempt. Your balance is not the blocker. Autosell will check again automatically; open Offers → Currency in the connected seller browser and check whether it loads or asks you to sign in. No offer toggle was sent by this read.`,{cause});
  error.code='ELDORADO_OFFERS_LOADING';return error;
}
module.exports={readOffers,hasFreshRead,normalize,coins,URL:OFFERS_URL};
