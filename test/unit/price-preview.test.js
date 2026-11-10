'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compareOffers,pricingPreview}=require('../../marketplace/price-preview');

const own={id:'own-offer',sellerId:'seller',sellerHref:'https://www.eldorado.gg/users/Shop',gameId:'donut',serverId:'default',unitCoins:'1000000',minOrder:'100'};
const quote=(id,price,extra={})=>({...own,id,sellerId:id,sellerHref:'https://www.eldorado.gg/users/'+id,status:'Active',currency:'USD',pricePerBillion:price,quantityCoins:'200000000',...extra});
function fixture(){
  const policy={offerId:own.id,observedSellerHref:own.sellerHref,apiBinding:{...own}};
  const s={settings:{get:async key=>key==='listing.policy'?policy:'hybrid'},marketplace:{documentedSellerApi:true,getOffer:async()=>own,normalizeOffer:row=>row,listCompetitorOffers:async()=>[]}};
  return {s,policy};
}
test('preview compares distinct active sellers who can actually fill this order size',()=>{
  const result=compareOffers([
    quote('a','12'),quote('b','11'),quote('a2','10',{sellerId:'a',sellerHref:'https://www.eldorado.gg/users/a'}),
    quote('owner-alias','1',{sellerId:own.sellerId}),quote('own-offer','1'),quote('low-stock','1',{quantityCoins:'99999999'}),
    quote('large-min','1',{minOrder:'101'}),quote('inactive','1',{status:'Paused'}),quote('currency','1',{currency:'EUR'}),
    quote('other-game','1',{gameId:'another'}),quote('other-server','1',{serverId:'extra'})
  ],own,100000000n);
  assert.equal(result.eligibleOffers,3);assert.equal(result.distinctSellers,2);
  assert.deepEqual(result.rows.map(row=>[row.seller,row.pricePerMillion]),[['a','0.01'],['b','0.011']]);
});
test('concurrent comparison uses a single read and does not modify price, stock or automation',async()=>{
  const {s}=fixture();let scans=0,reads=0;const a=s.marketplace;
  a.getOffer=async()=>{reads++;return own;};a.listCompetitorOffers=async()=>{scans++;await new Promise(resolve=>setImmediate(resolve));return [quote('shop','0.125001')];};
  const [first,second]=await Promise.all([pricingPreview(s),pricingPreview(s)]);assert.deepEqual(first,second);assert.equal(first.rows[0].pricePerMillion,'0.000125001');
  assert.equal((await pricingPreview(s)).checkedAt,first.checkedAt);assert.equal(reads,1);assert.equal(scans,1);
});
test('upstream failures, changed binding and mismatched ownership never return stale prices',async()=>{
  const {s,policy}=fixture();let calls=0;
  s.marketplace.listCompetitorOffers=async()=>{calls++;throw Object.assign(Error('rate limited'),{status:429});};
  await assert.rejects(pricingPreview(s),{status:429});
  s.marketplace.listCompetitorOffers=async()=>{calls++;policy.offerId='replaced';return [];};
  await assert.rejects(pricingPreview(s),/changed while prices/);
  await assert.rejects(pricingPreview(s),/identity changed/);assert.equal(calls,2);
});
