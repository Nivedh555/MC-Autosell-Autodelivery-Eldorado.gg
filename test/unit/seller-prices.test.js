'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const p=require('../../marketplace/seller-protocol');
const defaults={enabled:true,minPurchaseCoins:'100000000',undercutEnabled:false,competitorMinCoins:'0',basePrice:'6.10'};
test('seller prices accept surrounding whitespace, leading decimal points and trailing decimal points exactly',()=>{
  for(const [input,expected]of [[' .01 ',10000n],['6.',6000000n],[' 6.10 ',6100000n],['1e-6',1n]])assert.equal(p.decimal(input),expected);
  assert.equal(p.undercut([],{...defaults,basePrice:' .01 '}),'0.010000');
});
test('missing or malformed settings prices identify the actual field without choosing a price',()=>{
  for(const value of ['',undefined,'$6.10','-1','0','0.0000001'])assert.throws(()=>p.automaticSettings({...defaults,basePrice:value}),/Selling price.*USD per billion/);
  const market={...defaults,priceMode:'market',undercutEnabled:true,floorPrice:'5',undercutBy:'.01'};
  assert.throws(()=>p.automaticSettings({...market,floorPrice:''}),/Minimum price.*USD per billion/);
  assert.throws(()=>p.automaticSettings({...market,undercutBy:' '}),/Undercut amount.*USD per billion/);
  assert.throws(()=>p.automaticSettings({...market,fallbackPrice:'$5'}),/Fallback selling price.*USD per billion/);
  assert.doesNotThrow(()=>p.automaticSettings({...market,fallbackPrice:' '}));
  assert.doesNotThrow(()=>p.automaticSettings({...market,fallbackPrice:'.5',floorPrice:'.1'}));
  assert.throws(()=>p.automaticSettings({...market,fallbackPrice:'4'}),/below the minimum/);
  assert.doesNotThrow(()=>p.automaticSettings({enabled:false}));
});
test('price parsing retains exact precision limits and rejects malformed or oversized inputs',()=>{
  for(const input of ['0.0000001','NaN','Infinity','1e100','1,000','1'.repeat(300)])assert.throws(()=>p.decimal(input));
  assert.equal(p.priceForUnit('6.10',1000000n),0.0061);
});
test('market pricing retains minimum price, own-offer exclusion and explicit fallback rules',()=>{
  const settings={...defaults,priceMode:'market',undercutEnabled:true,floorPrice:'5',undercutBy:' .01 ',fallbackPrice:'6.10'};p.automaticSettings(settings);
  const competitor={id:'competitor',currency:'USD',quantityCoins:'1000000000',pricePerBillion:'6.00'};
  assert.equal(p.undercut([competitor],settings),'5.990000');assert.equal(p.undercut([{...competitor,pricePerBillion:'4.00'}],settings),'5.000000');
  assert.equal(p.undercut([{...competitor,isOwn:true}],settings),'6.100000');assert.throws(()=>p.undercut([],{...settings,fallbackPrice:''}),/No competitor meets/);
});
