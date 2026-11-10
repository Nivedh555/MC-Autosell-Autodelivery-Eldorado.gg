'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EldoradoSellerAdapter}=require('../../marketplace/adapters/eldorado-seller');
const ID='11111111-1111-4111-8111-111111111111';
const SELLER='22222222-2222-4222-8222-222222222222';
const HREF='https://www.eldorado.gg/users/fixture';
function fixture(quantity,browserQuantity){
 const row={id:ID,userId:SELLER,category:'Currency',gameId:'donut',unitSystem:'Unit1000000',offerState:'Closed',quantity,minQuantity:100,pricePerUnit:{amount:0.012,currency:'USD'},description:'Fixture',guaranteedDeliveryTime:'Hour1',deliveryMethod:'MailTrade',volumeDiscounts:[],tradeEnvironmentValues:[]};
 const view={id:ID,gameLabel:'DonutSMP',status:'Closed',quantityCoins:browserQuantity,minimumCoins:'100000000'};
 const browser={sellerHref:HREF,offers:[view]};
 const adapter=new EldoradoSellerAdapter({services:{browserBridge:{inspectOffers:async()=>browser}}});
 adapter.listOffers=async()=>[row];adapter.getOffer=async()=>({offer:row,user:{username:'fixture'}});
 return {adapter,row,view,browser};
}
test('Closed zero stock links using its positive minimum and private API owner',async()=>{
 const f=fixture(0,'0'),result=await f.adapter.inspectOffersForSetup();
 assert.equal(result.offers[0].quantityCoins,'0');assert.equal(result.offers[0].apiBinding.unitCoins,'1000000');assert.equal(result.offers[0].apiBinding.sellerId,SELLER);
});
test('Closed omitted stock display links without inventing API stock or dividing by zero',async()=>{
 for(const quantity of [0,200]){
  const f=fixture(quantity,null),result=await f.adapter.inspectOffersForSetup();
  assert.equal(result.offers[0].quantityCoins,String(quantity*1000000));
 }
});
test('setup still rejects mismatched amounts, minimum, owner, ID and nonclosed missing stock',async()=>{
 const cases=[
  f=>{f.view.quantityCoins='199000000';},
  f=>{f.view.minimumCoins='100000001';},
  f=>{f.view.minimumCoins='0';},
  f=>{f.browser.sellerHref='https://www.eldorado.gg/users/other';},
  f=>{f.adapter.getOffer=async()=>({offer:{...f.row,id:SELLER},user:{username:'fixture'}});},
  f=>{f.row.offerState='Active';f.view.quantityCoins=null;},
 ];
 for(const change of cases){const f=fixture(200,'200000000');change(f);await assert.rejects(f.adapter.inspectOffersForSetup());}
});
