'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {incomingPattern,amount}=require('../../ops/incoming-payment-pattern');
const {matchCaptured}=require('../../payments/payment-patterns');
test('receipt format is learned from an owner-selected server capture',()=>{
  const learned=incomingPattern({raw:'Received $1,000 from TestPlayer',position:'system',sender:null},'TestPlayer','1,000');
  const pack={incoming:learned.incoming,incomingSource:'owner reviewed fixture',calibrated:true,source:'fixture',systemPositions:['system']};
  assert.equal(matchCaptured('Received $1.5M from AnotherPlayer',{position:'system'},pack).amountText,'1500000');
  assert.equal(matchCaptured('Received $1,000 from AnotherPlayer',{position:'system'},pack).amountText,'1000');
  assert.equal(matchCaptured('<Other> Received $1,000 from AnotherPlayer',{position:'system'},pack),null);
  assert.equal(matchCaptured('Received $1,000 from AnotherPlayer',{position:'chat',sender:'player-id'},pack),null);
});
test('ambiguous, player-authored, whispered and partial receipt selections are refused',()=>{
  for(const [raw,position,sender,ign,value] of [
    ['Received $1 from TestPlayer','chat','uuid','TestPlayer','1'],
    ['TestPlayer whispers: received $1','system',null,'TestPlayer','1'],
    ['Received $1 from TestPlayer; TestPlayer','system',null,'TestPlayer','1'],
    ['Received $100 from TestPlayer','system',null,'TestPlayer','10'],
  ])assert.throws(()=>incomingPattern({raw,position,sender},ign,value));
});
test('compact receipt arithmetic never rounds fractions of a coin',()=>{
  assert.equal(amount('1.234','M'),1234000n);assert.equal(amount('1,000'),1000n);
  for(const [n,u]of[['0',''],['0.1',''],['1.0000001','K'],['-1',''],['1','Q']])assert.throws(()=>amount(n,u));
});
