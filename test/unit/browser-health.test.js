'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {BrowserHealth}=require('../../marketplace/browser/health');
test('browser infrastructure failures trigger bounded cooldown and one successful recovery clears it',()=>{
  let now=0;const health=new BrowserHealth({now:()=>now});
  for(let i=0;i<3;i++)health.failure(Object.assign(Error('locator failed'),{name:'TimeoutError'}));
  assert.throws(()=>health.assertAvailable(),/cooldown/);assert.equal(health.status().retryAt,30000);
  now=30000;health.assertAvailable();health.failure(Object.assign(Error('locator failed'),{name:'TimeoutError'}));assert.equal(health.status().retryAt,90000);
  now=90000;health.assertAvailable();health.success();assert.equal(health.status().state,'READY');assert.equal(health.status().consecutiveFailures,0);
});
test('uncertain outgoing message receipts are order-specific and never clear or trip browser health',()=>{
  const health=new BrowserHealth();for(let i=0;i<20;i++)health.failure(Error('Earlier reply not uniquely visible; inspect journal'));
  assert.equal(health.status().consecutiveFailures,0);
});
