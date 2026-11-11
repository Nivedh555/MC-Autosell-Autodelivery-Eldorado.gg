'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),path=require('node:path');
const {chromium}=require('playwright');

async function fixture(t,{missing=false,verified=true,opened=true,linkedApi=false}={}){
  const app=express(),calls=[],errors=[];
  const state={enabled:true,verified,opened,offer:'Closed',missing,delay:0};
  const bridge=()=>({state:state.opened?'ATTACHED_PAUSED':'CLOSED',connected:state.opened,
    sellerCheck:{compatible:state.verified,identityMatched:state.verified},channel:'chromium'});
  function readiness(){
    const steps=[
      {id:'browser',label:'Seller browser',state:state.opened&&state.verified?'ready':'blocked',
        detail:state.opened&&state.verified?'Connected and seller login verified.':'The seller account has not been verified.',
        nextAction:'Sign in to Eldorado, then click Check startup.'},
      {id:'game',label:'Minecraft and stock',state:'ready',detail:'seller1 connected; 500,000,000 coins available.'},
      {id:'offer',label:'Eldorado offer',state:state.offer==='Active'?'ready':'blocked',
        detail:'The linked offer is '+state.offer+' on Eldorado.',nextAction:'Resume or correct this same offer on Eldorado.'},
      {id:'automation',label:'Automation',state:state.enabled?'ready':'blocked',
        detail:state.enabled?'Global Autosell and incoming-order monitoring are on.':'Global Autosell is off.',nextAction:'Turn on Global Autosell.'}
    ];
    const first=steps.find(step=>step.state!=='ready');
    return {ready:!first,headline:first?.detail||'Ready for incoming orders',nextAction:first?.nextAction||'Keep the seller browser and Minecraft running.',steps,globalEnabled:state.enabled,generatedAt:Date.now()};
  }
  app.use(express.json());
  app.use('/api',(req,res)=>{
    calls.push({method:req.method,path:req.path,body:req.body});
    if(req.path==='/events'){res.setHeader('Content-Type','text/event-stream');return res.end(': connected\n\n');}
    if(req.path==='/marketplace/startup'||req.path==='/marketplace/startup/check'){
      if(state.missing)return res.status(404).json({error:'Not found'});
      return setTimeout(()=>res.json(readiness()),req.method==='POST'?state.delay:0);
    }
    if(req.path==='/marketplace/controls'){state.enabled=req.body.enabled;return res.json({success:true});}
    if(req.path==='/marketplace/setup')return res.json({connection:linkedApi?'hybrid':'browser',listing:{offerId:'fixture-offer',...(linkedApi?{apiBinding:{gameId:'fixture-game',serverId:'default'}}:{})},browserOptions:{channel:'chromium',sessionMode:'persistent',actionMs:750,characterMs:1,timeoutMs:30000},chat:{autoSend:true},pairs:[],browser:bridge()});
    if(req.path==='/marketplace/pricing/preview')return res.status(state.previewStatus||200).json(state.preview);
    // Legacy readiness deliberately conflicts with the startup result: it must not claim live trading.
    if(req.path==='/marketplace/status')return res.json({success:true,deliveryReady:true,listing:{state:'ACTIVE',availabilityOnly:true}});
    if(req.path==='/ops/browser/open'){state.opened=true;return res.json(bridge());}
    if(req.path==='/v3/eldorado/offers')return res.json({offers:[{id:'listing-a',gameLabel:'DonutSMP',status:'Paused',quantityDisplay:'200 M',pricePerMillion:0.011},{id:'listing-b',gameLabel:'DonutSMP',status:'Closed',quantityDisplay:'200 M',pricePerMillion:0.012}],accounts:['seller1','seller2']});
    if(req.path==='/ops/browser')return res.json({bridge:bridge()});
    if(req.path==='/config')return res.json({botPaused:false});
    return res.json({success:true,pairs:[],orders:[],sellers:[],accounts:[],sales:[]});
  });
  const dist=path.resolve(__dirname,'../../web/dist');app.use(express.static(dist));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,route=>route.abort());
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/#eldorado-setup');
  const panel=page.getByRole('region',{name:'Delivery readiness'});
  await panel.waitFor();
  t.after(()=>assert.deepEqual(errors,[]));
  return {page,panel,calls,state};
}

test('startup keeps browser connection, offer availability and automation distinct',async t=>{
  const {page,panel,calls,state}=await fixture(t);
  await panel.locator('[data-startup-step="offer"]').getByText('The linked offer is Closed on Eldorado.',{exact:true}).waitFor();
  assert.equal(await panel.locator('[data-startup-step]').count(),4);
  assert.equal(await panel.locator('[data-startup-step="browser"]').getByText('Ready',{exact:true}).count(),1);
  assert.equal(await panel.locator('[data-startup-step="offer"]').getByText('Action needed',{exact:true}).count(),1);
  await page.getByText('Seller browser connected',{exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'AUTOMATION ON',exact:true}).count(),1);
  assert.doesNotMatch(await page.locator('body').innerText(),/ATTACHED_PAUSED|REAL TRADING ENABLED|LIVE DELIVERY/);
  assert.equal(calls.filter(call=>call.method==='POST').length,0,'Opening setup must only read local state');
  assert.equal(await page.getByRole('button',{name:'Compare competitor prices'}).count(),0,'A linked Seller API offer is required');
  await panel.getByRole('button',{name:'Offer settings',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'currency-offer-setup');
  if(process.env.AUTOSELL_UI_CAPTURE_DIR){
    await page.locator('main').evaluate(node=>{node.scrollTop=0;});
    await page.screenshot({path:path.join(process.env.AUTOSELL_UI_CAPTURE_DIR,'startup-readiness.png'),fullPage:true});
  }
  state.delay=250;state.offer='Active';
  await panel.getByRole('button',{name:'Check startup',exact:true}).click();
  assert.equal(await panel.getByRole('button',{name:'Checking startup…',exact:true}).isDisabled(),true);
  await panel.getByText('Ready for incoming orders',{exact:true}).waitFor();
  assert.deepEqual(calls.filter(call=>call.method==='POST').map(call=>call.path),['/marketplace/startup/check']);
  await panel.getByRole('button',{name:'Pause automation',exact:true}).click();
  await page.getByRole('link',{name:'AUTOMATION OFF',exact:true}).waitFor();
  await panel.getByRole('button',{name:'Enable automation',exact:true}).waitFor();
  assert.deepEqual(calls.filter(call=>call.path==='/marketplace/controls').map(call=>call.body),[{enabled:false}]);
});

test('linked offer compares prices only on demand and shows snapshot units, time, missing matches and API errors',async t=>{
  const {page,calls,state}=await fixture(t,{linkedApi:true});
  const compare=page.getByRole('button',{name:'Compare competitor prices'});
  await compare.waitFor();assert.equal(calls.filter(c=>c.path==='/marketplace/pricing/preview').length,0);
  state.preview={checkedAt:'2026-10-01T09:05:00.000Z',currency:'USD',unit:'1M',eligibleOffers:3,distinctSellers:2,comparisonCoins:'100000000',source:'Eldorado Seller API',rows:[
    {seller:'Fixture A',pricePerMillion:'0.000005',stockCoins:'10000000000000000000',minimumCoins:'2000000'},
    {seller:'Fixture B',pricePerMillion:'0.0123',stockCoins:'500000000',minimumCoins:'100000000'}]};
  await compare.click();
  const region=page.getByRole('region',{name:'Competitor price comparison'});
  await region.getByText('For 100,000,000 coins: 2 qualifying sellers across 3 offers.',{exact:true}).waitFor();
  const sellerRow=region.getByRole('row',{name:/Fixture A/});
  assert.equal(await sellerRow.getByText('$0.000005/M',{exact:true}).count(),1);
  assert.equal(await sellerRow.getByText('10,000,000,000,000,000,000',{exact:true}).count(),1);
  assert.equal(await sellerRow.getByText('2,000,000',{exact:true}).count(),1);
  assert.equal(await region.locator('time').getAttribute('datetime'),state.preview.checkedAt);
  assert.equal(await region.getByText(/Eldorado Seller API/).count(),1);
  state.preview={...state.preview,eligibleOffers:0,distinctSellers:0,rows:[]};
  await compare.click();await region.getByText(/No other active seller offers matched/).waitFor();
  assert.equal(await page.getByText('Fixture A',{exact:true}).count(),0);
  for(const [status,message] of [[403,'Seller permission unavailable.'],[429,'Rate limit reached.'],[409,'Link your existing currency offer first.']]){
    state.previewStatus=status;state.preview={error:message};await compare.click();
    await page.getByRole('alert').filter({hasText:message}).waitFor();
    assert.equal(await region.count(),0,'A failed read must not present previous prices as current');
  }
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>[c.path,c.body]),Array.from({length:5},()=>['/marketplace/pricing/preview',{}]));
});

test('link sends only the explicitly selected listing and account',async t=>{
  const {page,calls}=await fixture(t);
  await page.getByRole('button',{name:'Find existing offers',exact:true}).click();
  const listing=page.getByRole('combobox',{name:'Currency offer',exact:true});
  assert.equal(await listing.inputValue(),'');
  await listing.selectOption({label:'DonutSMP · Closed · 200 M · $0.012/M · listing-b'});
  await page.getByRole('combobox',{name:'Delivery account',exact:true}).selectOption('seller2');
  await page.getByRole('button',{name:'Link offer',exact:true}).click();
  await page.getByText('Offer linked to seller2. Open Delivery readiness and click Check startup.',{exact:true}).waitFor();
  assert.deepEqual(calls.filter(x=>x.method==='POST').map(x=>[x.path,x.body]),[['/v3/eldorado/offer',{offerId:'listing-b',accountId:'seller2'}]]);
});

test('opening the seller browser checks once and gives a sign-in recovery path',async t=>{
  const {page,panel,calls,state}=await fixture(t,{verified:false,opened:false});
  await page.getByRole('button',{name:'Open seller browser',exact:true}).click();
  await page.getByText('Seller browser opened. Sign in to Eldorado in that browser, then click Check startup. The seller account has not been verified.',{exact:true}).first().waitFor();
  await page.getByText('Seller browser connected',{exact:true}).waitFor();
  assert.deepEqual(calls.filter(call=>call.method==='POST').map(call=>call.path),['/ops/browser/open','/marketplace/startup/check']);
  assert.equal(await panel.locator('[data-startup-step="browser"]').getByText('Action needed',{exact:true}).count(),1);
  state.verified=true;state.offer='Active';
  await panel.getByRole('button',{name:'Check startup',exact:true}).click();
  await panel.getByText('Ready for incoming orders',{exact:true}).waitFor();
  assert.equal(calls.filter(call=>call.path==='/marketplace/startup/check').length,2);
  assert.equal(calls.filter(call=>call.path==='/marketplace/controls').length,0);
});

test('an older running server gives a concrete restart instruction without claiming automation is on',async t=>{
  const {page,panel,calls}=await fixture(t,{missing:true,opened:false,verified:false});
  await panel.getByRole('alert').getByText('Restart Start-Windows.cmd to load startup checks.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'STARTUP UNCHECKED',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Enable automation',exact:true}).count(),0);
  await panel.getByRole('button',{name:'Check startup',exact:true}).click();
  await panel.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Open seller browser',exact:true}).click();
  await page.getByText('Seller browser opened. Sign in to Eldorado in that browser, then click Check startup. Restart Start-Windows.cmd to load startup checks.',{exact:true}).first().waitFor();
  assert.equal(calls.filter(call=>call.path==='/marketplace/startup/check').length,2);
  assert.equal(calls.filter(call=>call.path==='/marketplace/controls').length,0);
});
