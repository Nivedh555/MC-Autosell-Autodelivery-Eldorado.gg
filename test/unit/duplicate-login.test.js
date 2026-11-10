'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const services=require('../../services');const AccountClient=require('../../minecraft/account-client');
test('direct reconnect cannot compete with the same login in another role',async()=>{
  const client=new AccountClient('seller1');client._getEmail=()=> 'same@example.invalid';client._shouldRun=true;
  const peer={bot:{username:'FixturePlayer'},_getEmail:()=> 'SAME@example.invalid'};
  services.sessions={clients:new Map([['buyer1',peer],['seller1',client]])};services.mcBot=peer;
  await assert.rejects(client._createBot(),error=>error.code==='DUPLICATE_MC_LOGIN');assert.equal(client._shouldRun,false);assert.equal(client.bot,null);assert.equal(client.state,'offline');
});
test('a reserved reconnect also blocks duplicate login while the first role is in backoff',async()=>{
  const client=new AccountClient('seller1');client._getEmail=()=> 'same@example.invalid';client._shouldRun=true;
  const peer={_shouldRun:true,_reconnectTimer:{},_getEmail:()=> 'same@example.invalid'};
  services.sessions={clients:new Map([['buyer1',peer]])};services.mcBot=peer;
  await assert.rejects(client._createBot(),/already managed/);assert.equal(client._shouldRun,false);
});

test('blank optional accounts cancel old retry timers and fail once before cooldown or network work',async()=>{
  const client=new AccountClient('buyer2');client._getEmail=()=> '   ';
  client._reconnectTimer=setTimeout(()=>{},60000);client._reconnectNotBefore=Date.now()+60000;client._consecutiveFailures=9;
  client._startWatchdog();let creations=0;client._createBot=async()=>{creations++;};
  try{
    await assert.rejects(client.connect(),error=>error.code==='MC_EMAIL_MISSING'&&/No reconnect/.test(error.message));
    assert.equal(client._shouldRun,false);assert.equal(client._reconnectTimer,null);assert.equal(client._watchdog,null);assert.equal(client._reconnectNotBefore,0);assert.equal(creations,0);assert.equal(client.state,'offline');
    client._scheduleReconnect();assert.equal(client._reconnectTimer,null);
  }finally{await client.disconnect();}
});

test('credentials cleared immediately before bot creation do not schedule reconnects or log recurring warnings',async()=>{
  const client=new AccountClient('buyer2');client._getEmail=()=> '';client._shouldRun=true;
  services.sessions={clients:new Map()};services.mcBot=null;services.buyer2Bot=null;
  services.settings={getSync:()=>undefined};services.logger={warn:()=>{throw Error('Unexpected recurring warning');}};
  try{await assert.rejects(client._createBot(),error=>error.code==='MC_EMAIL_MISSING');assert.equal(client._shouldRun,false);assert.equal(client._reconnectTimer,null);assert.equal(client.bot,null);}
  finally{await client.disconnect();}
});

test('automatic listing skips an unconfigured optional pair before acquiring its session',async()=>{
  const saved=services.pairManager;
  const pair={pairIndex:2,buyerId:'buyer2',sellerId:'seller2',buyerEmail:'',sellerEmail:'',buyerIgn:'',sellerIgn:'',disabled:false};
  services.pairManager={getPairs:()=>[pair]};services.settings={get:async()=>false};services.store=null;
  try{
    const controls=require('../../treasury/trading-controls');assert.equal((await controls.deliveryAllowed('buyer2')).allowed,false);
    pair.buyerEmail='fixture@example.invalid';assert.equal((await controls.deliveryAllowed('buyer2')).allowed,true);
  }finally{services.pairManager=saved;}
});
