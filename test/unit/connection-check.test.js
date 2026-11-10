'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {checkSavedConnection}=require('../../marketplace/connection-check');
test('API checks use the latest saved secret without using the worker token or changing offers',async()=>{
  let secret='first',rejected=false;const calls=[];
  const worker={documentedSellerApi:true,auth:{token:{value:'obsolete'}}};
  const services={marketplace:worker,marketplacePendingRestart:{adapter:worker,reason:'Restart required'},settings:{get:async()=> 'hybrid'},vault:{retrieve:async key=>key.endsWith('clientId')?'fixture-id':secret}};
  const transport={request:async(url,options)=>{
    calls.push({url,method:options.method});
    if(url.endsWith('/seller/token')){
      assert.equal(JSON.parse(options.body).clientSecret,secret);
      assert.equal(Number(options.headers['Content-Length']),Buffer.byteLength(options.body));
      return {status:rejected?401:200,json:async()=>({accessToken:'fixture-token',expiresIn:900})};
    }
    assert.equal(options.method,'GET');return {status:200,text:async()=>JSON.stringify({results:[]})};
  }};
  assert.equal((await checkSavedConnection(services,{transport})).success,true);
  secret='replacement';assert.equal((await checkSavedConnection(services,{transport})).restartRequired,true);
  rejected=true;const failed=await checkSavedConnection(services,{transport});assert.equal(failed.success,false);assert.match(failed.error,/HTTP 401/);
  assert.equal(calls.filter(c=>c.url.endsWith('/seller/token')).length,3);
  assert.equal(worker.auth.token.value,'obsolete');
});
