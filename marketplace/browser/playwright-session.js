'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PlaywrightRunner } = require('./playwright-runner');
const { missing } = require('./profile');
const DEFAULTS = Object.freeze({channel:'chrome',sessionMode:'persistent',chromeProfile:'',actionMs:750,characterMs:60,timeoutMs:15000});
async function readDashboardSellerIdentity(page,timeoutMs){
  const dashboard='https://www.eldorado.gg/dashboard/orders/sold';
  const isDashboard=()=>{try{const url=new URL(page.url());return url.origin==='https://www.eldorado.gg'&&url.pathname.startsWith('/dashboard/');}catch{return false;}};
  try{
    // Leave an in-progress login or human verification on its current page.
    // Repeated connection checks must not restart the authentication redirect.
    const current=new URL(page.url());
    const title=typeof page.title==='function' ? await page.title() : '';
    if(current.hostname==='login.eldorado.gg' || /just a moment|performing security verification|attention required.*cloudflare/i.test(title)) {
      throw Error('Finish the sign-in or security verification in your seller browser, then click Check connection. This page has been left open.');
    }
    if(!isDashboard())await page.goto(dashboard,{waitUntil:'domcontentloaded',timeout:timeoutMs});
    if(!isDashboard())throw Error('Sign in to the selected Eldorado seller Chrome profile, then check its connection again.');
    const identity=page.locator('eld-dashboard-sidenav-user a[href]');
    await identity.first().waitFor({state:'attached',timeout:timeoutMs});
    const hrefs=await identity.evaluateAll(nodes=>nodes.map(node=>node.href));
    const valid=hrefs.filter(href=>{try{const url=new URL(href);return url.origin==='https://www.eldorado.gg'&&/^\/users\/[^/]+$/.test(url.pathname)&&!url.search&&!url.hash;}catch{return false;}});
    const unique=[...new Set(valid)];
    if(unique.length!==1||valid.length!==hrefs.length)throw Error('The seller dashboard did not identify one signed-in account. Check the selected Chrome profile and sign in again.');
    if(!isDashboard())throw Error('The seller page changed while its account was being read. Check the browser connection again.');
    return {sellerHref:unique[0],source:'Captured signed-in dashboard account link'};
  }catch(error){
    if(error.name!=='TimeoutError')throw error;
    throw Error('The signed-in seller account did not load in the dashboard. Open Sold Orders in the selected Chrome profile, finish any sign-in prompt and click Check connection. No chat message was sent.',{cause:error});
  }
}
async function cleanupWithin(work,timeoutMs=5000){
  let timer;
  try { await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser cleanup timed out')),timeoutMs);})]);return true; }
  catch { return false; }
  finally { clearTimeout(timer); }
}
async function readProfilePath(page,timeoutMs){
  const deadline=Date.now()+timeoutMs;
  for(;;){
                                                                           
                                                                   
    const value=(await page.locator('#profile_path').innerText({timeout:Math.max(1,deadline-Date.now())})).trim();
    if(value)return value;
    if(Date.now()>=deadline)throw Error('Chrome did not provide its selected profile path before the connection timeout');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
function validateOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!Object.hasOwn(DEFAULTS,k))) throw Error('Unsupported browser configuration');
  const result = {...DEFAULTS,...value};
  if (!['chrome','msedge','chromium'].includes(result.channel)) throw Error('Choose Chrome, Edge or bundled Chromium');
  if (!['persistent','private','existing'].includes(result.sessionMode)) throw Error('Choose a saved profile, private session or existing Chrome profile');
  if(typeof result.chromeProfile!=='string' || (result.chromeProfile && !require('./chrome-profiles').profileId(result.chromeProfile)))throw Error('Select a detected Chrome profile');
  if(result.sessionMode==='existing' && (result.channel!=='chrome'||!result.chromeProfile))throw Error('Existing profile requires Google Chrome and a selected profile');
  for (const key of ['actionMs','characterMs','timeoutMs']) if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'timeoutMs' ? 100 : 1) || result[key] > 60000) throw Error('Browser timing is outside bounded limits');
  return result;
}
function validateProfileOptions(value={}){
  const config=validateOptions({...DEFAULTS,sessionMode:'existing',...value});
  if(config.sessionMode==='persistent'&&['chromium','chrome','msedge'].includes(config.channel))return config;
  if(config.channel!=='chrome'||config.sessionMode!=='existing')throw Error('Choose a saved Chromium profile or an existing Chrome profile');
  return config;
}
class PlaywrightSession {
  constructor(services, options = {}) {
    this.services=services; this.options=options; this.state='CLOSED'; this.reason='Open the seller browser from Eldorado setup';
    this.context=null; this.page=null; this.busy=false; this.opening=null; this.epoch=0; this.active=null;
    this.history=[];this.observedTail=Promise.resolve();this.backgroundReady=false;this.recordsChatSubmitIntents=true;this.reconcilesChatSendOutcomes=true;
    this.health=new(require('./health').BrowserHealth)();this.queued=0;
  }
  observedExclusive(fn){
    if(this.queued>=32)return Promise.reject(Object.assign(Error('Browser queue is full; work will retry on the next cycle'),{code:'BROWSER_BACKPRESSURE'}));
    this.queued++;const queuedAt=performance.now();
    const task=this.observedTail.then(async()=>{
      this.health.assertAvailable();const started=performance.now();
      try{const result=await fn();this.health.success();this.services.ops?.metric(null,'browser_queue_wait',started-queuedAt,'ok');this.services.ops?.metric(null,'browser_operation',performance.now()-started,'ok');return result;}
      catch(error){this.health.failure(error);throw error;}
    }).finally(()=>this.queued--);
    this.observedTail=task.catch(()=>{});return task;
  }
  status() { return {transport:'playwright',headed:true,state:this.state,reason:this.reason,connected:Boolean(this.context),sellerCheck:this.context&&this.sellerCheck?.epoch===this.epoch?{...this.sellerCheck}:null,channel:this.context?this.config?.channel:null,sessionMode:this.context?this.config?.sessionMode:null,chromeProfile:this.context?this.config?.chromeProfile:null,browserVersion:this.context?this.browserVersion:null,busy:this.busy,pending:this.queued,health:this.health.status(),backgroundSupported:Boolean(this.context&&this.page&&!this.page.isClosed()&&this.backgroundReady),currentOperation:this.active,history:this.history.slice(-12)}; }
  record(operation,state) {
    const event={operation,state,at:Date.now()}; this.history.push(event); this.history=this.history.slice(-50);
    this.services.events?.emit('browser:activity',event);
  }
  async start() { return this; }                                                       
  async open(selected) {
    const requested=selected===undefined?undefined:validateOptions(selected);
    if (this.opening) {
      if(requested && JSON.stringify(requested)!==JSON.stringify(this.openingConfig)) throw Error('Wait for browser opening to finish before changing browser settings');
      return this.opening;
    }
    if (this.context) {
      if(requested && JSON.stringify(requested)!==JSON.stringify(this.config)) throw Error('Close seller browser before changing its browser or session settings; the existing session has been left untouched');
      return this.status();
    }
    const generation=++this.epoch; this.state='OPENING'; this.openingConfig=requested;
    const opening=this.launch(generation,requested); this.opening=opening;
    try { return await opening; } finally { if(this.opening===opening){this.opening=null;this.openingConfig=null;} }
  }
  async launch(generation,selected) {
    let privateBrowser,chromeAttached=false;
    try {
      this.expectedProfilePath=null;
      const config=selected || validateOptions(await this.services.settings.get('eldorado.browser.options'));
      if(this.epoch!==generation)throw Error('Browser opening was cancelled');
      if(selected)await this.services.settings.set('eldorado.browser.options',config,'owner');
      if(this.epoch!==generation)throw Error('Browser opening was cancelled');
      this.reason='Opening '+({chrome:'Google Chrome',msedge:'Microsoft Edge',chromium:'bundled Chromium'}[config.channel])+' with '+(config.sessionMode==='existing'?'selected Chrome profile '+config.chromeProfile:config.sessionMode==='private'?'a private session':'a saved seller profile');
      const chromium=this.options.chromium || require('playwright').chromium;
      const launchOptions={headless:false,...(config.channel==='chromium'?{}:{channel:config.channel}),timeout:30000};
      let context,verifiedPage;
      if(config.sessionMode==='existing') {
        const selected=await (this.options.profiles || require('./chrome-profiles')).prepare(config.chromeProfile,{mode:'attach'});
        const launch=this.options.launchChrome || ((exe,args)=>new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(exe,args,{stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});}));
                                                                             
                                                                           
        if(this.epoch!==generation)throw Error('Browser opening was cancelled');
        this.state='AWAITING_CHROME_PERMISSION';
        this.reason='Waiting for Chrome permission. Approve its debugging connection prompt, which may appear in another profile window.';
        const profileTimeoutMs=Math.max(30000,config.timeoutMs);
        const profileTabs=selected.executable?{openTab:url=>(this.options.activateProfile || launch)(selected.executable,['--profile-directory='+selected.id,url]),timeoutMs:profileTimeoutMs}:undefined;
        const attached=await (this.options.connectChrome || require('./owned-cdp').connectChrome)(chromium,{timeout:60000,noDefaults:true},profileTabs);this.attachedBrowser=attached;chromeAttached=true;
        attached.on?.('disconnected',()=>{if(this.attachedBrowser===attached){this.attachedBrowser=null;this.context=null;this.page=null;++this.epoch;this.state='CLOSED';this.reason='Chrome debugging connection ended; incomplete actions require review';this.record('connection','CLOSED');}});
        try {
          const matches=[],observed=[];
          const contexts=attached.contexts();if(contexts.length>16)throw Error('Too many Chrome contexts for a bounded profile check');
          for(const candidate of contexts){
            if(this.epoch!==generation)throw Error('Browser opening was cancelled');
            const probe=await candidate.newPage();
            let keep=false;
            try{await probe.goto('chrome://version/',{waitUntil:'commit',timeout:profileTimeoutMs});const actual=await readProfilePath(probe,profileTimeoutMs);observed.push(path.basename(actual));if(path.normalize(actual).toLowerCase()===path.normalize(selected.expectedPath).toLowerCase()){matches.push(candidate);if(!verifiedPage){verifiedPage=probe;keep=true;}}}finally{if(!keep)await cleanupWithin(probe.close());}
          }
          if(matches.length!==1)throw Object.assign(Error('Attached Chrome did not expose exactly the selected profile '+selected.id+' (observed: '+observed.join(', ')+'). Open that profile’s window, then retry. No marketplace actions were performed'),{code:'CHROME_PROFILE_MISMATCH'});
          context=matches[0];this.expectedProfilePath=selected.expectedPath;this.ownedPages=new Set([verifiedPage]);
        }catch(error){attached.autosellDisconnect?.();if(!await cleanupWithin(attached.close()))this.record('connection','CLEANUP_INCOMPLETE');this.attachedBrowser=null;throw error;}
      } else if(config.sessionMode==='private') {
        privateBrowser=await chromium.launch(launchOptions);
        if(this.epoch!==generation)throw Error('Browser opening was cancelled');
        context=await privateBrowser.newContext({viewport:null,acceptDownloads:false});
      } else {
        const base=path.resolve(this.options.root || path.join(process.cwd(),'data','browser','playwright-profile'));
                                                                                     
        const directory=config.channel==='chrome'?base:path.join(base,config.channel);
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        context=await chromium.launchPersistentContext(directory,{...launchOptions,viewport:null,acceptDownloads:false});
      }
      if(this.epoch!==generation){if(this.attachedBrowser){await cleanupWithin(this.attachedBrowser.close());this.attachedBrowser=null;}else await cleanupWithin(context.close(),30000);throw Error('Browser opening was cancelled');}
      this.context=context; this.config=config;
      this.privateBrowser=privateBrowser || null;
      this.browserVersion=(this.attachedBrowser || privateBrowser || context.browser?.())?.version?.() || 'not captured';
      context.setDefaultTimeout(config.timeoutMs); context.setDefaultNavigationTimeout(config.timeoutMs);
      context.on('close',()=>{if(this.context===context){this.context=null;this.page=null;this.privateBrowser=null;++this.epoch;this.state='CLOSED';this.reason='Seller browser closed; incomplete actions require review';this.record('connection','CLOSED');privateBrowser?.close().catch(()=>{});}});
                                                                                 
                                                                                        
      const existing=context.pages().filter(p=>!p.isClosed());
      const restored=config.sessionMode==='existing'?null:existing.find(p=>{try{return new URL(p.url()).origin==='https://www.eldorado.gg';}catch{return false;}});
      this.homePage=config.sessionMode==='existing'?null:existing.find(p=>p!==restored && p.url()==='about:blank') || await context.newPage();
      this.page=verifiedPage || restored || await this.newPage(context);
      if(verifiedPage || restored)await this.preparePage(context,this.page);
      this.ownedPages?.add(this.page);
      this.state='ATTACHED_PAUSED'; this.reason='Browser connected. Sign in to Eldorado if needed, then check the connection to verify the seller account.';
                                                                                   
      if(!restored && this.options.mode!=='mock') {
        try { await this.page.goto('https://www.eldorado.gg/dashboard/offers/Currency',{waitUntil:'domcontentloaded',timeout:config.timeoutMs}); }
        catch { this.reason='Browser connected, but the seller page did not finish loading. Complete any login prompt, then check the connection again.'; }
      }
      if(this.epoch!==generation)throw Error('Browser opening was cancelled');
      this.record('connection','OPEN_PAUSED'); return this.status();
    } catch(error) {
      if(this.attachedBrowser && !this.context){this.attachedBrowser.autosellDisconnect?.();if(!await cleanupWithin(this.attachedBrowser.close()))this.record('connection','CLEANUP_INCOMPLETE');this.attachedBrowser=null;}
      if(privateBrowser && this.context===null)await cleanupWithin(privateBrowser.close(),30000);
      if(this.context){const failed=this.context;this.context=null;this.page=null;if(this.attachedBrowser){await cleanupWithin(this.attachedBrowser.close());this.attachedBrowser=null;}else await cleanupWithin(failed.close(),30000);}
      this.expectedProfilePath=null;
      this.state=this.context?'NEEDS_OPERATOR':'CLOSED';
      this.reason='Could not open/check the seller browser: '+String(error.message).split('\n')[0].slice(0,220);
      if(selected?.sessionMode==='existing'&&!chromeAttached)this.reason+=' An open profile alone does not grant debugging access. Enable remote debugging at chrome://inspect/#remote-debugging and approve Chrome’s prompt (possibly in another profile window), then retry. Existing tabs were left open; only the selected profile can be used';
      throw Error(this.reason);
    }
  }
  async preparePage(context,page){
    if(!this.attachedBrowser?.autosellOwnedBackground)await require('./background-page').prepareBackgroundPage(context,page);
    this.backgroundReady=true;
  }
  async newPage(context=this.context){
    this.backgroundReady=false;
    const page=await context.newPage();
    if(this.expectedProfilePath){
      try{await page.goto('chrome://version/',{waitUntil:'commit',timeout:this.config?.timeoutMs || 15000});const actual=await readProfilePath(page,this.config?.timeoutMs || 15000);if(path.normalize(actual).toLowerCase()!==path.normalize(this.expectedProfilePath).toLowerCase())throw Error('New Chrome tab belongs to a different profile; no marketplace action was performed');await page.goto('about:blank');}
      catch(error){await cleanupWithin(page.close());throw error;}
    }
    this.ownedPages?.add(page);
    try{await this.preparePage(context,page);}
    catch(error){await cleanupWithin(page.close());throw error;}
    return page;
  }
  checkConnection() {
    // Setup checks share the browser with order reads. Coalesce clicks and wait
    // for queued work without taking the queue lock around nested offer readers.
    if(this.connectionCheck)return this.connectionCheck;
    this.health.success(); // An explicit owner connection check is a fresh probe.
    const work=(async()=>{
      if(this.opening)await this.opening;
      await this.observedExclusive(()=>{});
      return this.checkConnectionReady();
    })();
    this.connectionCheck=work;
    work.finally(()=>{if(this.connectionCheck===work)this.connectionCheck=null;}).catch(()=>{});
    return work;
  }
  async checkConnectionReady() {
    if(!this.context || !this.page || this.page.isClosed()) throw Error('Open the seller browser first');
    const generation=this.epoch;
    if(this.services.marketplace?.documentedSellerApi){
      try{
        const listing=await this.services.settings?.get('listing.policy')||{};
        const direct=listing.automatic?.enabled&&listing.automatic.source==='direct';
        const result=direct?await this.services.marketplace.inspectAutomaticSetup():await this.services.marketplace.inspectOffersForSetup(),compatible=direct||result.offers.length>0;
        const linked=Boolean(listing.offerId&&result.offers?.some(offer=>offer.id===listing.offerId));
        if(this.epoch!==generation)throw Error('The browser connection changed during this check. Check the selected seller browser again.');
        this.sellerCheck={epoch:generation,identityMatched:compatible,compatible,sellerHref:result.sellerHref||null,checkedMs:Date.now()};
        this.reason=compatible
          ? 'Seller login verified; API and browser match. '+(direct?'Automatic-offer setup is configured.':linked?'Currency offer is linked.':'Select an existing currency offer.')+' Browser attached; payment processing also requires Global Autosell and sufficient stock.'
          : 'Seller check found no matching currency offer. Create an offer in Eldorado and search again.';
        return {...this.status(),identityMatched:compatible,compatible,missing:{},liveMissing:{},executionMode:'live',scope:'seller connection'};
      }catch(error){this.sellerCheck=null;this.reason='Seller check failed: '+error.message;return {...this.status(),identityMatched:false,compatible:false,missing:{sellerConnection:[error.message]},liveMissing:{},executionMode:'live',scope:'seller connection'};}
    }
    const profile=await this.services.settings.get('eldorado.browser.profile');
    const required=['listOffers','getOffer','listOrders','getOrder','pauseOffer','resumeOffer','markDelivered'];
    const gaps=Object.fromEntries(required.map(op=>[op,missing(profile,op,this.options.mode || 'live')]).filter(([,items])=>items.length));
    let identityMatched=false;
    if(profile?.accountIdentity?.selector && profile.accountIdentity.value && new URL(this.page.url()).origin===profile.origin){
      try{await new PlaywrightRunner(this.page).check(profile.accountIdentity);identityMatched=true;}catch{                                                  }
    }
    const liveMissing=Object.fromEntries(['pauseOffer','resumeOffer','markDelivered'].map(op=>[op,missing(profile,op,this.options.mode || 'live')]).filter(([,items])=>items.length));
    this.sellerCheck=this.epoch===generation?{epoch:generation,identityMatched,compatible:identityMatched&&Object.keys(gaps).length===0,checkedMs:Date.now()}:null;
    return {identityMatched,compatible:identityMatched && Object.keys(gaps).length===0,missing:gaps,liveMissing,executionMode:'live',...this.status()};
  }
  async resume() {
    const check=await this.checkConnection();
    if(!check.compatible) throw Error('Browser workflow is not ready: '+(!check.identityMatched?'seller identity must match; ':'')+Object.keys(check.missing).join(', '));
    if(this.services.db?.raw().prepare("SELECT id FROM browser_actions WHERE state IN ('INTENT','NEEDS_OPERATOR') LIMIT 1").get()) throw Error('Unresolved browser action; inspect the action journal before starting');
    this.state='RUNNING'; this.reason='Browser running; rollout and payment checks still govern every action'; ++this.epoch;
    this.record('connection','RUNNING'); return this.status();
  }
  pause(reason='Owner paused from Eldorado setup') {
    ++this.epoch; this.state=this.context?'ATTACHED_PAUSED':'CLOSED'; this.reason=reason; this.record('connection','PAUSED');
                                                                               
                                                                                    
    if(this.busy && this.page){const page=this.page;this.page=null;this.interrupt=page.close({runBeforeUnload:false}).catch(()=>{});}
    return this.status();
  }
  async request({operation,profile,args={},preview=false}) {
    return this.observedExclusive(()=>this.requestObserved({operation,profile,args,preview}));
  }
  async requestObserved({operation,profile,args={},preview=false}) {
    const startState=this.state;
    if(!['RUNNING',...(preview?['ATTACHED_PAUSED']:[])].includes(startState) || !this.context || this.busy) throw Error('Seller browser is paused, closed or busy');
    this.busy=true; this.active=operation; const generation=this.epoch;
    let timer;
    const check=()=>{if(this.epoch!==generation || this.state!==startState)throw Error('Browser operation interrupted; outcome unknown');};
    try {
      if(!this.page || this.page.isClosed())this.page=await this.newPage();
      check(); this.record(operation,'STARTED');
                                                                        
      const configured={...profile,pacing:{...profile.pacing,...this.config}};delete configured.pacing.channel;delete configured.pacing.sessionMode;delete configured.pacing.chromeProfile;
      const task=new PlaywrightRunner(this.page,{mode:this.options.mode || 'live',check}).run(configured,operation,args,preview);
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{this.pause('Browser operation timed out; outcome unknown');reject(Error('Browser operation timed out; outcome unknown'));},60000);});
      const result=await Promise.race([task,deadline]);check(); this.record(operation,'CONFIRMED');return result;
    } catch(error) {
      if(this.epoch===generation)this.pause('Browser operation failed; inspect the current page and action journal');
      this.state=this.context?'NEEDS_OPERATOR':'CLOSED';this.reason=String(error.message).slice(0,300);this.record(operation,'NEEDS_OPERATOR');throw error;
    } finally {clearTimeout(timer);await this.interrupt;this.interrupt=null;this.busy=false;this.active=null;}
  }
  async inspectOffers() {
    return this.observedExclusive(()=>this.inspectOffersObserved());
  }
  getObservedOfferSnapshot(id) {
    const capture = this.lastOfferRead;
    if (!this.context || capture?.epoch !== this.epoch) return null;
    const row = capture.offers.find(offer => offer.id === id);
    if (!row) return null;
    // DOM reads return quantities in coins. Both fields already use the same unit.
    return {id, status:row.status, sellerHref:capture.sellerHref, gameLabel:row.gameLabel,
      quantityCoins:row.quantityCoins, minOrder:row.minimumCoins, unitCoins:'1', checkedMs:capture.checkedMs};
  }
  async inspectSellerIdentity(){
    return this.observedExclusive(async()=>{
      if(!this.context||!['ATTACHED_PAUSED','RUNNING'].includes(this.state)||this.busy)throw Error('Connect the seller Chrome profile and wait for its current operation.');
      this.busy=true;this.active='inspectSellerIdentity';const generation=this.epoch;
      try{
        if(!this.page||this.page.isClosed())this.page=await this.newPage();
        const result=await readDashboardSellerIdentity(this.page,this.config.timeoutMs);
        if(this.epoch!==generation)throw Error('Seller identity check was interrupted.');
        this.record('inspectSellerIdentity','CAPTURED_READ_ONLY');return result;
      }finally{this.busy=false;this.active=null;}
    });
  }
  async inspectOffersObserved() {
    if(!this.context||!['ATTACHED_PAUSED','RUNNING'].includes(this.state)||this.busy)throw Error('Open the selected Chrome profile first and wait for its current operation');
    const generation=this.epoch;this.busy=true;this.active='inspectOffers';
    try{
      if(!this.page||this.page.isClosed())this.page=await this.newPage();
      const result=await require('./observed-offers').readOffers(this.page,this.config.timeoutMs,{availabilityOnly:true});
      if(this.epoch!==generation)throw Error('Offer search interrupted; no result accepted');
      const profile=await this.services.settings.get('eldorado.browser.profile');
      if(profile?.accountIdentity?.selector&&profile.accountIdentity.value)await new PlaywrightRunner(this.page).check(profile.accountIdentity);
      this.reconcileAvailability(result);
      if(this.epoch!==generation)throw Error('The seller browser changed during the offer read.');
      this.lastOfferRead={epoch:generation,checkedMs:Date.now(),sellerHref:result.sellerHref,offers:result.offers};
      if(this.services.marketplace?.profile&&!this.services.marketplace.documentedSellerApi) {
        const listing=await this.services.settings.get('listing.policy');
        const matches=Boolean(result.sellerHref&&(!listing?.observedSellerHref||listing.observedSellerHref===result.sellerHref));
        this.sellerCheck={epoch:generation,identityMatched:matches,compatible:matches,sellerHref:result.sellerHref,checkedMs:Date.now()};
      }
      this.record('inspectOffers','CAPTURED_READ_ONLY');return result;
    }catch(error){this.lastOfferRead=null;throw error;}finally{this.busy=false;this.active=null;}
  }
  reconcileAvailability(result){
    const db=this.services.db.raw(),helper=require('./offer-availability'),pack=require('./availability-pack.json');
    for(const row of db.prepare("SELECT * FROM browser_actions WHERE state IN ('INTENT','NEEDS_OPERATOR') AND operation IN ('pauseOfferAvailability','resumeOfferAvailability')").all()){
      const request=JSON.parse(row.request);
      if(request.sellerHref!==result.sellerHref)continue;
      const offer=result.offers.find(o=>o.id===row.resource_id);if(!offer)continue;
      const actual=helper.state(offer,pack);
      const reason=`Read-only reconciliation captured ${offer.status}. The previous toggle's outcome was not captured; no click was repeated. Future availability decisions use this fresh state.`;
      db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare("UPDATE browser_actions SET state='RECONCILED',result=?,reason=?,updated_ms=? WHERE id=? AND state IN ('INTENT','NEEDS_OPERATOR')").run(JSON.stringify({offer,originalOutcome:'not captured',reconciledAt:Date.now(),mutationRepeated:false}),reason,Date.now(),row.id);
        db.prepare("UPDATE listing_state SET state=?,payload=?,reason=?,updated_ms=? WHERE offer_id=? AND state IN ('WRITE_INTENT','NEEDS_OPERATOR')").run(actual==='active'?'ACTIVE':actual==='closed'?'CLOSED':'PAUSED',JSON.stringify({observedOffer:offer,availabilityOnly:true,sellerHref:result.sellerHref}),reason,Date.now(),offer.id);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      this.record('availabilityReconciliation','CAPTURED_READ_ONLY');
    }
  }
  async inspectOrders() {
    return this.observedExclusive(()=>this.inspectOrdersObserved());
  }
  async inspectOrderReference(order,{paymentDispatch=false,ownerReview=false}={}){
    return this.observedExclusive(async()=>{
      if(!this.context||!['ATTACHED_PAUSED','RUNNING','NEEDS_OPERATOR'].includes(this.state)||this.busy)throw Error('Connect the seller browser before reading this order.');
      const generation=this.epoch;this.busy=true;this.active='inspectOrderReference';
      try{
        if(!ownerReview && this.services.deliveryService?.repo?.closedStatus(order.id))throw Error('Marketplace order is already closed; buyer chat was skipped.');
        if(!this.page||this.page.isClosed())this.page=await this.newPage();
        if(order.hybridApiOrder||paymentDispatch||ownerReview)await this.orderChatContext(order,{reuseIdentity:true,ownerReview});
        const result=await require('./order-reference').readReference(this.page,order,this.config.timeoutMs,{ownerReview});
        if(this.epoch!==generation)throw Error('Order reference capture was interrupted.');
        this.services.deliveryService?.repo?.applyMarketplaceStatus(order.id,result.status);
        this.record('inspectOrderReference','CAPTURED_READ_ONLY');return result;
      }finally{this.busy=false;this.active=null;}
    });
  }
  async inspectOrdersObserved() {
    if(!this.context||!['ATTACHED_PAUSED','RUNNING'].includes(this.state)||this.busy)throw Error('Open the selected Chrome profile and wait for its current operation.');
    const generation=this.epoch;this.busy=true;this.active='inspectOrders';
    try{
      if(!this.page||this.page.isClosed())this.page=await this.newPage();
      const result=await require('./observed-orders').readOrders(this.page,this.config.timeoutMs);
      if(this.epoch!==generation)throw Error('Sold Orders refresh interrupted; no result accepted.');
      const profile=await this.services.settings.get('eldorado.browser.profile');
      if(profile?.accountIdentity?.selector&&profile.accountIdentity.value)await new PlaywrightRunner(this.page).check(profile.accountIdentity);
      this.record('inspectOrders','CAPTURED_READ_ONLY');return result;
    }finally{this.busy=false;this.active=null;}
  }
  async orderChatContext(order,{reuseIdentity=false,completionNotification=false,cancellationNotification=false,ownerReview=false}={}){
    const repo=this.services.deliveryService?.repo;
    const eligible = current => {
      repo?.applyMarketplaceStatus(order.id,current.status);
      const closed = repo?.closedStatus(order.id)||require('../order-status').closedStatus(current.status);
      if(ownerReview)return;
      if(cancellationNotification&&!repo?.chunks(order.id).length&&require('../order-status').closure(closed)==='canceled'&&require('../order-status').closure(current.status)==='canceled'){
        const row=repo?.get(order.id);
        if(row?.state==='CANCELLED'||(!row&&this.services.db.raw().prepare("SELECT 1 FROM seller_api_actions WHERE id=? AND state='CONFIRMED'").get('cancelOrder:'+order.id)))return;
      }
      if(completionNotification && repo?.get(order.id)?.state==='DELIVERED' &&
        require('../order-status').closure(closed)==='completed' && require('../order-status').closure(current.status)==='completed')return;
      if(closed||current.status!=='Pending delivery'||completionNotification||cancellationNotification||repo?.get(order.id)?.state==='DELIVERED')throw Error('Marketplace order '+order.id+' is '+(closed||current.status)+'; its chat operation stopped.');
    };
    if(!order.hybridApiOrder){
      const history=await require('./observed-orders').readOrders(this.page,this.config.timeoutMs);
      const current=history.orders.find(row=>row.id===order.id);
      if(!current||current.buyerName!==order.buyerName||current.gameLabel!==order.gameLabel||current.quantityDisplay!==order.quantityDisplay)throw Error('Seller history no longer matches this order.');
      if(order.sellerHref&&history.sellerHref!==order.sellerHref)throw Error('Seller changed before order navigation.');
      eligible(current);
      return history;
    }
    const adapter=this.services.marketplace,current=await adapter.chatOrder(order.id),sellerHref=await adapter.sellerHref();
    if(current.id!==order.id||current.buyerName!==order.buyerName||current.gameLabel!==order.gameLabel||current.offerId!==order.offerId||String(current.amount)!==String(order.amount))throw Error('API order identity, amount or offer changed; refresh the conversation.');
    eligible(current);
    const cached=this.sellerIdentity;
    const identity=reuseIdentity&&cached?.epoch===this.epoch&&cached.sellerHref===sellerHref&&Date.now()-cached.capturedMs<15000?cached:await readDashboardSellerIdentity(this.page,this.config.timeoutMs);
    if(identity.sellerHref!==sellerHref)throw Error('Chrome and Seller API are signed into different seller accounts.');
    this.sellerIdentity={...identity,epoch:this.epoch,capturedMs:identity.capturedMs||Date.now()};
    if(this.page.url()!==current.orderUrl)await this.page.goto(current.orderUrl,{waitUntil:'domcontentloaded',timeout:this.config.timeoutMs});
    current.quantityDisplay=order.quantityDisplay;
    return {sellerHref,orders:[current]};
  }
  async sendOrderMessageObserved(order,text,messageId,sellerHref,authorize) {
    return require('./dispatch-chat').send(this,order,text,messageId,sellerHref,authorize);
  }
  async uploadOrderEvidenceObserved(order,file,sellerHref,authorize,options) {
    return require('./dispatch-chat').upload(this,order,file,sellerHref,authorize,options);
  }
  async markOrderDeliveredObserved(order,sellerHref,authorize){
    return this.observedExclusive(async()=>{
      if(!this.context||!['ATTACHED_PAUSED','RUNNING'].includes(this.state)||this.busy)throw Error('Connect the seller Chrome profile before acknowledging delivery');
      const db=this.services.db.raw(),id='markDeliveredObserved:'+order.id,generation=this.epoch;
      const paid=db.prepare('SELECT state,payload FROM delivery_orders WHERE id=?').get(order.id);
      const chunks=db.prepare('SELECT state,amount FROM delivery_chunks WHERE order_id=?').all(order.id);
      if(!paid||!['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'].includes(paid.state)||!chunks.length||chunks.some(chunk=>chunk.state!=='PAY_VERIFIED')||chunks.reduce((sum,chunk)=>sum+BigInt(chunk.amount),0n)!==BigInt(JSON.parse(paid.payload).amount))throw Error('Full recorded payment is required before the delivered control can be used');
      const prior=db.prepare('SELECT * FROM browser_actions WHERE id=?').get(id);
      if(prior?.state==='CONFIRMED')return JSON.parse(prior.result);
      this.busy=true;this.active='markDeliveredObserved';let intent=Boolean(prior);
      const check=()=>{if(this.epoch!==generation||!this.context)throw Error('Delivery acknowledgement interrupted; do not repay');};
      try{
        if(!this.page||this.page.isClosed())this.page=await this.newPage();
        const history=await require('./observed-orders').readOrders(this.page,this.config.timeoutMs),current=history.orders.find(row=>row.id===order.id);
        if(history.sellerHref!==sellerHref||!current||['buyerName','gameLabel','quantityDisplay','orderUrl'].some(key=>current[key]!==order[key]))throw Error('Delivery acknowledgement seller/order mismatch');
        if(require('../order-status').closure(current.status)){
          this.services.deliveryService.repo.applyMarketplaceStatus(order.id,current.status);
          if(this.services.deliveryService.repo.get(order.id)?.state==='DELIVERED'&&prior)return {orderId:order.id,status:current.status,source:'Verified seller history acknowledgement'};
          throw Error('Marketplace order is '+current.status+'; acknowledgement stopped.');
        }
        const reference=await require('./order-reference').readReference(this.page,current,this.config.timeoutMs);
        const done=require('./fulfillment').deliveredStatuses;
        const accept=status=>({orderId:order.id,status,confirmation:'Exact seller order header reports delivery after verified full payment',source:'Captured seller page; supported state labels from Eldorado Help Center'});
        if(done.has(reference.status.toLowerCase())){
          this.services.deliveryService.repo.applyMarketplaceStatus(order.id,reference.status);
          if(!prior)throw Error('Remote order was already delivered without this acknowledgement intent; review its history');
          await authorize();const result=accept(reference.status);
          db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(result),Date.now(),id);return result;
        }
        if(require('../order-status').closure(reference.status)==='canceled'){
          this.services.deliveryService.repo.applyMarketplaceStatus(order.id,reference.status);
          throw Error('Marketplace canceled the order before acknowledgement.');
        }
        if(prior)throw Error('An earlier delivered click is unresolved; no second click or payment was sent');
        if(reference.status!=='Pending delivery'||!reference.controls.includes('Order delivered'))throw Error('Order is not pending delivery; no delivered click was sent');
        const button=this.page.getByRole('button',{name:'Order delivered',exact:true});
        if(await button.count()!==1||!await button.isVisible()||!await button.isEnabled())throw Error('Observed Order delivered control changed');
        await authorize();check();
        await require('./observed-chat').assertOrderPage(this.page,order);
        const liveStatus=(await this.page.locator('eld-order-header eld-chip').innerText()).trim();
        if(liveStatus!=='Pending delivery'){
          this.services.deliveryService.repo.applyMarketplaceStatus(order.id,liveStatus);
          throw Error('Order changed immediately before delivery acknowledgement.');
        }
        db.prepare("INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,created_ms,updated_ms) VALUES(?,?,?,?,'INTENT',?,?,?)").run(id,this.active,order.id,crypto.createHash('sha256').update(JSON.stringify([order.id,sellerHref])).digest('hex'),JSON.stringify({order,sellerHref,before:reference.status}),Date.now(),Date.now());intent=true;
        await button.click({timeout:this.config.timeoutMs});
                                                                               
        await this.page.waitForFunction(()=>{const node=document.querySelector('eld-order-header eld-chip');return node&&node.textContent.trim().toLowerCase()!=='pending delivery';},null,{timeout:this.config.timeoutMs});
        check();await require('./observed-chat').assertOrderPage(this.page,order);const status=(await this.page.locator('eld-order-header eld-chip').innerText()).trim();
        this.services.deliveryService.repo.applyMarketplaceStatus(order.id,status);
        if(!done.has(status.toLowerCase()))throw Error('Unexpected order state after acknowledgement: '+status+'; no payment will be repeated');
        const result=accept(status);db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(result),Date.now(),id);return result;
      }catch(error){if(intent)db.prepare("UPDATE browser_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=?").run(error.message,Date.now(),id);throw error;}
      finally{this.busy=false;this.active=null;}
    });
  }
  async setOfferAvailability(id,paused,sellerHref,authorize) {
    return this.observedExclusive(()=>this.setOfferAvailabilityObserved(id,paused,sellerHref,authorize));
  }
  async setOfferAvailabilityObserved(id,paused,sellerHref,authorize) {
    if(!/^[0-9a-f-]{36}$/.test(id)||typeof paused!=='boolean'||typeof authorize!=='function')throw Error('An exact selected offer, desired availability and stock authorization are required.');
    if(!this.context||!['ATTACHED_PAUSED','RUNNING'].includes(this.state)||this.busy)throw Error('Open the selected seller Chrome profile and wait for its current operation.');
    const db=this.services.db.raw();
                                                                          
                                                                               
                                                                              
                                                                        
    if(db.prepare("SELECT id FROM browser_actions WHERE state IN ('INTENT','NEEDS_OPERATOR') AND operation NOT IN ('uploadOwnerRecord','sendMessageObserved','uploadEvidenceObserved','markDeliveredObserved') LIMIT 1").get())throw Error('An earlier offer change is not confirmed. Autosell will read its current state before changing availability again.');
    const generation=this.epoch;let actionId;
    this.busy=true;this.active=paused?'pauseOfferAvailability':'resumeOfferAvailability';
    const check=()=>{if(this.epoch!==generation||!this.context)throw Error('Offer availability change interrupted; inspect the actual offer before retrying.');};
    try{
      if(!this.page||this.page.isClosed())this.page=await this.newPage();
      const request={id,paused,sellerHref};
      const result=await require('./offer-availability').setAvailability(this.page,{
        ...request,pack:require('./availability-pack.json'),timeoutMs:this.config.timeoutMs,check,
        beforeClick:async offer=>{
          await authorize(offer);check();
          actionId=crypto.randomUUID();
          db.prepare("INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,created_ms,updated_ms) VALUES(?,?,?,?,'INTENT',?,?,?)").run(actionId,this.active,id,crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),JSON.stringify({...request,before:offer}),Date.now(),Date.now());
          this.record(this.active,'INTENT');
        },
      });
      check();
      if(actionId)db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(result),Date.now(),actionId);
      this.record(this.active,result.changed?'CONFIRMED':'ALREADY_IN_DESIRED_STATE');
      return result;
    }catch(error){
      if(actionId)db.prepare("UPDATE browser_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=?").run(error.message,Date.now(),actionId);
      this.reason=error.message;throw error;
    }finally{this.busy=false;this.active=null;}
  }
  async capture() {
    if(this.busy || !this.page || this.page.isClosed())throw Error('Open a seller dashboard page while the browser is paused');
    if(this.state==='RUNNING')throw Error('Pause the browser before a read-only layout check');
    const url=new URL(this.page.url());
    if(url.origin!=='https://www.eldorado.gg' || !/^\/(dashboard\/|order\/)/.test(url.pathname) || /settings|wallet/i.test(url.pathname) || url.hash || [...url.searchParams.keys()].some(k=>/token|password|secret|auth|code|key/i.test(k)))throw Error('Read-only capture requires an observed seller offers/orders page');
    const data=await this.page.evaluate(()=>{
      const elements=[];let truncated=false;
      const all=document.body.querySelectorAll('*');if(all.length>20000)throw Error('Page too large for bounded capture');
      for(const node of all){
        if(node.closest('script,style,noscript,iframe,footer,[hidden],[aria-hidden="true"]') || ['INPUT','SELECT','TEXTAREA'].includes(node.tagName))continue;
        if(!node.getClientRects().length)continue;
        let hidden=false;for(let parent=node;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0'){hidden=true;break;}}if(hidden)continue;
        if(node.children.length && !['A','BUTTON'].includes(node.tagName))continue;
        let selector=node.id?'#'+CSS.escape(node.id):null;
        if(!selector || document.querySelectorAll(selector).length!==1){const parts=[];for(let n=node;n && n!==document.body;n=n.parentElement){parts.unshift(n.tagName.toLowerCase()+':nth-child('+([...n.parentElement.children].indexOf(n)+1)+')');}selector='body > '+parts.join(' > ');}
        if(selector.length>500)continue;
        const entry={selector,tag:node.tagName.toLowerCase(),text:node.textContent.trim().slice(0,500)};
        const href=node.tagName==='A'?node.href:null;
        if(href){const u=new URL(href,location.href);if(u.origin===location.origin&&!u.hash&&!u.username&&!u.password&&href.length<=2000&&![...u.searchParams.keys()].some(k=>/token|password|secret|auth|code|key/i.test(k)))entry.href=href;}
        for(const key of ['role','aria-label','title','data-testid','data-test']){const v=node.getAttribute(key);if(v)entry[key]=v.slice(0,160);}
        if(!entry.text && !entry.href && !entry['aria-label'])continue;
        if(elements.length===400 || JSON.stringify(elements).length+JSON.stringify(entry).length>60000){truncated=true;break;}elements.push(entry);
      }
      return {url:location.href,origin:location.origin,observedAt:new Date().toISOString(),verified:false,truncated,elements};
    });
    if(data.url!==url.href)throw Error('Page changed during read-only capture');
    const sanitized=require('./page-observation').validateObservation(data),id=crypto.randomUUID();
    this.services.db.raw().prepare('INSERT INTO browser_observations(id,url,data,created_ms,source) VALUES(?,?,?,?,?)').run(id,sanitized.url,JSON.stringify(sanitized),Date.now(),'captured visible DOM inventory');
    return {id,elements:sanitized.elements.length,verified:false,liveUnlocked:false,message:'Visible page recorded for developer review; this does not unlock trading'};
  }
  async close(){
    this.pause('Application stopping');
    const context=this.context,privateBrowser=this.privateBrowser,attached=this.attachedBrowser;
    this.context=null;this.page=null;this.privateBrowser=null;this.attachedBrowser=null;
    const bounded=async(work,timeoutMs=5000)=>{if(!await cleanupWithin(work,timeoutMs))this.record('connection','CLEANUP_INCOMPLETE');};
    try{
      if(attached){
                                                                            
                                                                                
        if(attached.autosellOwnedBackground){attached.autosellDisconnect?.();await bounded(attached.close());}
        for(const page of this.ownedPages || [])if(!page.isClosed())await bounded(page.close());
        if(!attached.autosellOwnedBackground)await bounded(attached.close());
      }else if(context)await bounded(context.close(),30000);
    }finally{
      if(privateBrowser)await bounded(privateBrowser.close(),30000);
      if(this.interrupt)await bounded(this.interrupt);
      this.interrupt=null;this.ownedPages=null;this.state='CLOSED';
    }
  }
}
module.exports={PlaywrightSession,validateOptions,validateProfileOptions,DEFAULTS,readDashboardSellerIdentity};
