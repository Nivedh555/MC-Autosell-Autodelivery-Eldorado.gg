'use strict';
const {decimal,fixed}=require('./seller-protocol');
const {connectionState}=require('./connection-state');

// One shared read per linked offer. Rendering or refreshing the dashboard never calls this.
const scans=new WeakMap();
const reuseMs=30000;
const wholeCoins=value=>/^\d+$/.test(String(value))?BigInt(value):null;

function sellerLabel(row){
  try {
    const url=new URL(row.sellerHref);
    if(url.origin==='https://www.eldorado.gg'&&/^\/users\/[^/]+$/.test(url.pathname))return decodeURIComponent(url.pathname.slice(7));
  }catch { /* Some grouped rows expose only the seller ID. */ }
  return row.sellerId;
}

function compareOffers(offers,own,comparisonCoins){
  const bestBySeller=new Map();
  let eligibleOffers=0;
  for(const row of offers){
    if(!row.sellerId||row.sellerId===own.sellerId||row.isOwn||row.id===own.id)continue;
    if(row.gameId!==own.gameId||row.serverId!==own.serverId||row.status!=='Active'||row.currency!=='USD')continue;
    const stock=wholeCoins(row.quantityCoins),minimum=wholeCoins(row.minOrder),unit=wholeCoins(row.unitCoins);
    if(stock===null||minimum===null||unit===null||unit<1n||minimum<1n)continue;
    const minimumCoins=minimum*unit;
    if(stock<comparisonCoins||minimumCoins>comparisonCoins)continue;
    const price=decimal(row.pricePerBillion);
    if(price<=0n)continue;
    eligibleOffers++;
    const previous=bestBySeller.get(row.sellerId);
    if(previous&&(previous.price<price||previous.price===price&&previous.id<=row.id))continue;
    bestBySeller.set(row.sellerId,{id:row.id,seller:sellerLabel(row),price,stockCoins:String(stock),minimumCoins:String(minimumCoins)});
  }
  const ordered=[...bestBySeller.values()].sort((a,b)=>a.price===b.price?a.id.localeCompare(b.id):a.price<b.price?-1:1);
  const rows=ordered.slice(0,5).map(({price,seller,stockCoins,minimumCoins})=>({
    seller,stockCoins,minimumCoins,pricePerMillion:fixed(price,9).replace(/0+$/,'').replace(/\.$/,'')
  }));
  return {eligibleOffers,distinctSellers:ordered.length,rows};
}

function linkKey(policy){
  const binding=policy?.apiBinding;
  return JSON.stringify([policy?.offerId,policy?.observedSellerHref,binding?.sellerId,binding?.gameId,binding?.serverId,binding?.unitCoins]);
}

async function pricingPreview(services){
  const adapter=services.marketplace;
  const state=connectionState(await services.settings.get('eldorado.connection'),services);
  if(state.restartRequired)throw Error(state.reason);
  if(!adapter?.documentedSellerApi)throw Error('Select Browser + API in Eldorado Setup to compare competitor prices.');
  const policy=await services.settings.get('listing.policy');
  const binding=policy?.apiBinding;
  if(!policy?.offerId||!binding?.sellerId||!binding.sellerHref)throw Error('Link your DonutSMP offer first so prices can be compared for its game and order size.');
  const key=linkKey(policy);
  const previous=scans.get(adapter);
  if(previous?.key===key){
    if(previous.work)return previous.work;
    if(previous.result&&Date.now()-previous.result.checkedAt<reuseMs)return previous.result;
  }
  const scan={key};
  const work=(async()=>{
    const own=adapter.normalizeOffer(await adapter.getOffer(policy.offerId));
    if(own.id!==policy.offerId||own.sellerId!==binding.sellerId||own.sellerHref!==binding.sellerHref||own.sellerHref!==policy.observedSellerHref||own.gameId!==binding.gameId||own.serverId!==binding.serverId||own.unitCoins!==binding.unitCoins)throw Error('The listing or seller identity changed. Check the linked offer and try again.');
    const minimum=wholeCoins(own.minOrder),unit=wholeCoins(own.unitCoins);
    if(minimum===null||unit===null||minimum<1n||unit<1n)throw Error('Eldorado did not provide a valid minimum order size for this offer.');
    const comparisonCoins=minimum*unit;
    const offers=await adapter.listCompetitorOffers(binding);
    if(adapter!==services.marketplace||key!==linkKey(await services.settings.get('listing.policy')))throw Error('The linked offer changed while prices were loading. Compare prices for the new selection.');
    return {checkedAt:Date.now(),offerId:own.id,source:'Eldorado Seller API',currency:'USD',unit:'1M',comparisonCoins:String(comparisonCoins),...compareOffers(offers,own,comparisonCoins)};
  })();
  scan.work=work;scans.set(adapter,scan);
  try {scan.result=await work;return scan.result;}
  finally {scan.work=null;if(!scan.result&&scans.get(adapter)===scan)scans.delete(adapter);}
}
module.exports={pricingPreview,compareOffers};
