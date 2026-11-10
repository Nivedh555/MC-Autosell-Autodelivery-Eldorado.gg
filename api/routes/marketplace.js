'use strict';
const router = require('express').Router();
const { EldoradoOfficialAdapter } = require('../../marketplace/adapters/eldorado-official');
const { verifyAuth, csrfProtection, asyncHandler } = require('../middleware');
const AiChatAgent = require('../../marketplace/ai-chat-agent');
const services = require('../../services');
const tradingControls = require('../../treasury/trading-controls');
const aiChatAgent = new AiChatAgent();
router.use(verifyAuth, csrfProtection);
router.get('/startup',asyncHandler(async(_req,res)=>res.json(await require('../../marketplace/startup-readiness').startupReadiness(services))));
router.post('/startup/check',asyncHandler(async(_req,res)=>res.json(await require('../../marketplace/startup-readiness').checkStartup(services))));
router.post('/pricing/preview',asyncHandler(async(_req,res)=>{
  try {res.json(await require('../../marketplace/price-preview').pricingPreview(services));}
  catch(error){res.status([401,403,404,429,503].includes(error.status)?error.status:409).json({error:error.message});}
}));
router.get('/orders/:orderId/progress',asyncHandler(async(req,res)=>{
  const progress=require('../../marketplace/order-progress').orderProgress(services.db.raw(),req.params.orderId);
  if(!progress)return res.status(404).json({error:'Recorded order not found'});
  res.json(progress);
}));
router.get('/reliability',asyncHandler(async(_req,res)=>{
  const db=services.db.raw();
  const oldest=db.prepare("SELECT id,state,created_ms,reason FROM delivery_orders WHERE state IN ('DETECTED','VALIDATED','ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING') ORDER BY created_ms LIMIT 1").get()||null;
  const classifications=db.prepare('SELECT state,count(*) count FROM chat_interpretations GROUP BY state').all();
  const outbox=db.prepare('SELECT state,count(*) count FROM message_outbox GROUP BY state').all();
  res.json({oldestQueued:oldest,outbox,metrics:services.ops?.metrics?.()||{},browserHealth:services.browserBridge?.health?.status()||null,browserQueue:services.browserBridge?.queued||0,
    interpreter:{...require('../../marketplace/chat-interpreter').forServices(services).status(),classifications},discoveryError:services.orderPoller?.discoveryError||null,paymentConcurrency:1});
}));
router.post('/offers/recover-creation', asyncHandler(async (_req,res)=>{
  if(!services.listingManager)return res.status(503).json({error:'Offer manager is still starting. Retry shortly.'});
  try{res.json({success:true,...await services.listingManager.recoverAutomaticCreation()});}
  catch(error){res.status(409).json({error:error.message});}
}));
router.get('/controls', asyncHandler(async (_req, res) => res.json({ success: true, enabled: await tradingControls.globallyEnabled() })));
router.post('/controls', asyncHandler(async (req, res) => {
  if (typeof req.body.enabled !== 'boolean' || Object.keys(req.body).length !== 1) return res.status(400).json({ error: 'enabled must be boolean' });
  await services.settings.set('general.bot.paused', !req.body.enabled, 'dashboard');
  if (req.body.enabled && await require('../../marketplace/browser/runtime-settings').configure(services.settings)) await services.chatScheduler?.start();
  services.store?.setAutosellPaused?.(!req.body.enabled);
  if (req.body.enabled) services.treasury?.requestBalanceRefresh();
  const remote = services.listingManager?.requestSync({ pauseOnly: !req.body.enabled, notify: req.body.enabled }) || { state: 'unavailable' };
  res.json({ success: true, enabled: await tradingControls.globallyEnabled(), remote });
}));
router.get('/status', asyncHandler(async (req, res) => {
  const adapter = services.marketplace || require('../../marketplace/create-adapter').createAdapter();
  if(adapter.documentedSellerApi)await services.rollout?.activateConfigured();
  const readiness=services.rollout?.status() || {ready:false,reason:'Delivery controller unavailable'};
  const globalEnabled=await tradingControls.globallyEnabled();
  const browserConnected=Boolean(services.browserBridge?.status().connected);
  res.json({ success: true, ...adapter.status(), readiness, globalEnabled, executionMode:'live',
    connectionState: require('../../marketplace/connection-state').connectionState(await services.settings.get('eldorado.connection')),
    deliveryReady:globalEnabled&&browserConnected&&readiness.ready===true&&await services.settings.get('eldorado.order.auto_deliver')===true,
    pollerRunning: Boolean(services.orderPoller?.isRunning), autoDeliver: await services.settings?.get('eldorado.order.auto_deliver') || false,
    pollInterval: await services.settings?.get('eldorado.poll_interval_seconds') || 60,
    chat: adapter.capabilities.getMessages && adapter.capabilities.sendMessage ? 'browser-capable; auto-send requires explicit configuration' : (adapter.profile || adapter.hybrid) && services.browserBridge?.sendOrderMessageObserved ? 'observed order chat; replies are separate from payment authorization' : 'manual-inbox',
    screenshot: { available: Boolean(services.gameBridge?.clients?.size), reason: services.gameBridge?.clients?.size?'Minecraft client online; payment screenshots require a world/chat screen.':'No Minecraft delivery client is online.' },
    evidence: { mode:services.gameBridge?'fabric-client-screenshot':'captured-console-record', screenshotRequired:Boolean(services.gameBridge), scope:'Owner-signed captured game and delivery records.' },
    listing: services.listingManager?.status?.() || { state: 'not initialized' },
  });
}));
router.get('/setup', asyncHandler(async (_req, res) => {
  const values = {};
  for (const [name, key] of Object.entries({ connection: 'eldorado.connection', listing: 'listing.policy', deliveryPolicy: 'delivery.policy', patternPack: 'delivery.patternPack', pricing: 'pricing.policy', caps: 'rollout.caps', accountRoles: 'treasury.accountRoles', chat: 'eldorado.chat.local' })) values[name] = await services.settings.get(key);
  values.contract = await services.settings.get('eldorado.contract');
  values.connectionState = require('../../marketplace/connection-state').connectionState(values.connection);
  if (['api','hybrid'].includes(values.connection)) {
    values.connection='hybrid';
    values.contract = await services.settings.get('eldorado.contract');
    values.clientIdConfigured = Boolean(await services.settings.get('eldorado.api.clientId'));
    values.clientSecretConfigured = Boolean(await services.settings.get('eldorado.api.clientSecret'));
    values.keyConfigured = Boolean(await services.settings.get('eldorado.api.key'));
  }
  values.browserProfile = await services.settings.get('eldorado.browser.profile'); values.browserOptions = await services.settings.get('eldorado.browser.options');
  res.json({ ...values, pairs: services.pairManager?.getPairs().map(pair => ({ ...pair, deliveryAccount: tradingControls.deliveryAccount(pair) })) || [], chatDefaults:{opening:require('../../marketplace/chat-rules').templates.opening,configuration:{autoSend:false,pollMs:1000,minIntervalMs:0,typingMinMs:0,typingMaxMs:0,fastReplies:true,confirmIgn:true,minimalChat:true,openingEnabled:true}}, browser: services.browserBridge?.status() || { state: 'CLOSED' }, manualOfferRequired: !(values.connection==='hybrid'&&values.listing?.automatic?.enabled) });
}));
async function liveReadiness(){
  const checks=[],additionalChecks=[];
  for(const [name,label] of [['read','Marketplace field mapping'],['delivery','Server payment and offer configuration']]){try{if(!services.rollout)throw Error('Trading controller unavailable');await services.rollout.prerequisites(name);checks.push({name,label,passed:true});}catch(error){checks.push({name,label,passed:false,reason:error.message});}}
  const policy=await services.settings.get('delivery.policy');
  additionalChecks.push({name:'Exact ordered command amount',passed:policy?.orderAmountMode==='command',reason:policy?.orderAmountMode==='command'?undefined:'Save the setup to acknowledge exact /pay amounts without recipient-tax top-up'});
  const synthetic=services.marketplace?.mode==='mock'||services.deliveryService?.options?.mode==='mock';
  additionalChecks.push({name:'Production transport',passed:!synthetic,reason:synthetic?'Simulator transport cannot enable real trades':undefined});
  if((await services.settings.get('eldorado.connection'))==='browser'){
    try{
      if(!services.browserBridge?.status().connected)throw Error('Connect the selected Chrome profile first');
      if(services.browserFulfillment){
        await services.browserFulfillment.prerequisites();
        const listing=await services.settings.get('listing.policy'),actual=await services.browserBridge.inspectOffers();
        if(actual.sellerHref!==listing.observedSellerHref||!actual.offers.some(offer=>offer.id===listing.offerId))throw Error('Seller identity or selected offer differs');
      }else{const check=await services.browserBridge.checkConnection();if(!check.compatible||Object.keys(check.liveMissing||{}).length)throw Error('Seller identity and reviewed offer/order/delivery workflows are required');}
      checks.push({name:'Seller browser',passed:true});
    }catch(error){checks.push({name:'Seller browser',passed:false,reason:error.message});}
  }
  return {checks,additionalChecks,setupChecksPassed:[...checks,...additionalChecks].every(check=>check.passed),configurationChanged:false,message:'This checks configuration only. Each real order still requires a funded status, verified balance, account limits and payment verification. Wallet payouts have separate guards.'};
}
router.get('/live-readiness',asyncHandler(async(_req,res)=>res.json(await liveReadiness())));
router.get('/verification',asyncHandler(async(_req,res)=>res.json(await require('../../ops/live-verification').inspectLiveSetup(services))));
router.post('/enable-live', (_req,res)=>res.status(410).json({error:'Separate live-trade enablement has been removed. Use Global Autosell and pair controls; production actions are real.'}));
router.post('/offers/inspect', asyncHandler(async (_req, res) => {
  if(services.marketplace?.documentedSellerApi){const result=await services.marketplace.inspectOffersForSetup();return res.json({...result,message:result.offers.length?'Select the offer to link the API account, currency units and seller browser. No offer was changed.':'Create a paused DonutSMP currency offer first, then search again.'});}
  if((await services.settings.get('eldorado.connection'))==='browser'&&services.browserBridge?.inspectOffers){
    try{const result=await services.browserBridge.inspectOffers();const policy=await services.settings.get('listing.policy');return res.json({...result,selected:policy.offerId||null,found:result.offers.some(offer=>offer.id===policy.offerId),message:result.offers.length?'Select your existing offer below. This read does not resume it or authorize payments.':'No currency offers were shown. Create one manually in Eldorado and leave it paused, then search again.'});}
    catch(error){return res.status(409).json({error:'Offer search could not read the seller page: '+error.message,code:'OFFER_SEARCH_BLOCKED',offersRead:false});}
  }
  if (!services.listingManager) return res.status(503).json({ error: 'Listing manager unavailable' });
  const policy = await services.settings.get('listing.policy');
  let raw;
  try{raw=await (services.marketplace.listOffersPreview?services.marketplace.listOffersPreview():services.marketplace.listOffers());}
  catch(error){return res.status(409).json({error:'Offer search could not read the seller page: '+error.message,code:'OFFER_SEARCH_BLOCKED',offersRead:false});}
  const offers = raw.map(value => services.marketplace.normalizeOffer ? services.marketplace.normalizeOffer(value) : require('../../marketplace/contract/runtime').normalizeOffer(value, services.marketplace.contract));
  if(services.marketplace.hybrid){
    const sellerHref=await services.marketplace.sellerHref({allowUnbound:true});
    if(!services.browserBridge?.status().connected)return res.status(409).json({error:'Open the seller browser to link the API account to its private chat.'});
    const browser=await services.browserBridge.inspectOffers();
    if(browser.sellerHref!==sellerHref)return res.status(409).json({error:'The API credentials and Chrome profile belong to different sellers. Choose the matching Chrome profile.'});
    for(const offer of offers)offer.sellerHref=sellerHref;
  }
  res.json({ offers, selected: policy.offerId || null, found: offers.some(offer => offer.id === policy.offerId), message: offers.length ? 'Choose your manually created offer. This check does not resume it.' : 'Create a currency offer manually in Eldorado and leave it paused, then check again.' });
}));
router.post('/offers/sync', asyncHandler(async (_req, res) => {
  await services.listingManager.syncListing(); res.json(services.listingManager.status());
}));
router.post('/config', asyncHandler(async (req, res) => {
  if (!services.settings) return res.status(503).json({ error: 'Settings unavailable' });
  const allowed = {
    connection: 'eldorado.connection', browserProfile: 'eldorado.browser.profile', browserOptions: 'eldorado.browser.options',
    contract: 'eldorado.contract', apiKey: 'eldorado.api.key', clientId:'eldorado.api.clientId', clientSecret:'eldorado.api.clientSecret', deliveryPolicy: 'delivery.policy',
    patternPack: 'delivery.patternPack', caps: 'rollout.caps', accountRoles: 'treasury.accountRoles',
    chat: 'eldorado.chat.local', autoDeliver: 'eldorado.order.auto_deliver',
    pollInterval: 'eldorado.poll_interval_seconds', listing: 'listing.policy', pricing: 'pricing.policy',
  };
  for (const key of Object.keys(req.body)) if (!allowed[key]) return res.status(400).json({ error: 'Unknown configuration field: ' + key });
  if(req.body.chat?.openingMessage) AiChatAgent.validateOpening(req.body.chat.openingMessage);
  if (req.body.connection !== undefined && !['browser','hybrid','api'].includes(req.body.connection)) return res.status(400).json({error:'Unsupported connection'});
  const previousConnection = await services.settings.get('eldorado.connection');
  let credentialsChanged = false;
  for (const key of ['clientId','clientSecret']) if (typeof req.body[key] === 'string' && req.body[key] !== await services.settings.get('eldorado.api.' + key)) credentialsChanged = true;
  if(req.body.connection==='api')req.body.connection='hybrid';
  if(req.body.listing?.automatic){try{require('../../marketplace/seller-protocol').automaticSettings(req.body.listing.automatic);}catch(error){return res.status(400).json({error:error.message});}}
  const directAutomatic=(req.body.connection||await services.settings.get('eldorado.connection'))==='hybrid'&&req.body.listing?.automatic?.enabled&&req.body.listing.automatic.source==='direct';
  if(directAutomatic){
    const existing=await services.settings.get('listing.policy');
    const active=services.db.raw().prepare("SELECT 1 FROM automatic_offer_runs WHERE state NOT IN ('DELETED','REJECTED') LIMIT 1").get();
    if(active||existing.offerId&&existing.apiBinding&&existing.apiBinding.source!=='direct'){req.body.listing.apiBinding=existing.apiBinding;req.body.listing.offerId=existing.offerId;req.body.listing.observedSellerHref=existing.observedSellerHref;}
    else if(services.marketplace?.documentedSellerApi&&services.browserBridge?.status().connected&&!req.body.clientId&&!req.body.clientSecret){
      const linked=await services.marketplace.inspectAutomaticSetup();req.body.listing.apiBinding=linked.apiBinding;req.body.listing.observedSellerHref=linked.sellerHref;req.body.listing.offerId=null;
    }else{delete req.body.listing.apiBinding;delete req.body.listing.observedSellerHref;req.body.listing.offerId=null;}
  }else if(req.body.listing?.apiBinding){
    if(!services.marketplace?.documentedSellerApi)return res.status(409).json({error:'Save Browser + API credentials and restart before linking an API offer.'});
    const selected=(await services.marketplace.inspectOffersForSetup()).offers.find(offer=>offer.id===req.body.listing.apiBinding.templateId);
    if(!selected)return res.status(409).json({error:'The selected offer is not present in both your API account and seller Chrome profile.'});
    req.body.listing.apiBinding=selected.apiBinding;req.body.listing.gameId=selected.gameId;req.body.listing.serverId=selected.serverId;req.body.listing.observedSellerHref=selected.sellerHref;
  }
  for(const key of ['clientId','clientSecret'])if(req.body[key]!==undefined && (typeof req.body[key]!=='string'||!req.body[key].trim()||req.body[key].length>8192||/[\r\n]/.test(req.body[key])))return res.status(400).json({error:'Enter a valid Seller API '+(key==='clientId'?'Client ID':'Client secret')});
  if (req.body.browserOptions) req.body.browserOptions=require('../../marketplace/browser/playwright-session').validateProfileOptions(req.body.browserOptions);
                                                                           
                                                                              
  let thresholdPair;
  if(req.body.listing?.threshold!==undefined){
    const threshold=Number(req.body.listing.threshold);
    if(!Number.isSafeInteger(threshold)||threshold<1)return res.status(400).json({error:'Threshold must be positive whole coins'});
    thresholdPair=services.pairManager?.getPairs().find(pair=>tradingControls.deliveryAccount(pair)===tradingControls.canonical(req.body.listing.holderAccount));
    if(!thresholdPair)return res.status(400).json({error:'Choose a configured pair before editing its threshold'});
  }
  const chatOnly = Object.keys(req.body).every(key=>key==='chat');
  const credentialsOnly = Object.keys(req.body).length > 0 && Object.keys(req.body).every(key=>['clientId','clientSecret'].includes(key));
  if (!chatOnly) services.browserBridge?.pause('Settings saved; restart to load the seller connection');
  for (const [key, value] of Object.entries(req.body)) await services.settings.set(allowed[key], value, 'owner');
  if (credentialsChanged || req.body.connection !== undefined && require('../../marketplace/connection-state').normalized(req.body.connection) !== require('../../marketplace/connection-state').normalized(previousConnection)) {
    services.marketplacePendingRestart = { adapter: services.marketplace, reason: 'Seller connection or credentials changed. Restart Autosell once to load them, then reconnect the matching seller Chrome profile. The encrypted credentials are saved; you do not need to enter them again.' };
  }
  if(thresholdPair)services.pairManager.savePair({id:thresholdPair.id,threshold:Number(req.body.listing.threshold)});
  if (credentialsOnly) {
    const connectionState = require('../../marketplace/connection-state').connectionState(await services.settings.get('eldorado.connection'));
    return res.json({success:true,restartRequired:connectionState.restartRequired,connectionState,
      message:'API credentials saved securely. Check API connection now to validate them.' + (connectionState.restartRequired ? ' Restart Autosell before processing orders with the changed credentials.' : ''),
      clientIdConfigured:Boolean(await services.settings.get('eldorado.api.clientId')),clientSecretConfigured:Boolean(await services.settings.get('eldorado.api.clientSecret'))});
  }
  if (chatOnly) return res.json({success:true,restartRequired:true,message:'Chat preferences saved; restart to reload scheduler timing.'});
  await services.settings.set('eldorado.order.auto_deliver', true, 'owner');
  res.json({ success: true, restartRequired: true, message:'Saved for real processing. Restart to load connection settings. Enabled pairs take turns once the browser and payment sources are ready.',
    connection: require('../../marketplace/connection-state').normalized(await services.settings.get('eldorado.connection')),
    connectionState: require('../../marketplace/connection-state').connectionState(await services.settings.get('eldorado.connection')),
    clientIdConfigured: Boolean(await services.settings.get('eldorado.api.clientId')), clientSecretConfigured: Boolean(await services.settings.get('eldorado.api.clientSecret')),
    listing: await services.settings.get('listing.policy'),
  });
}));
router.get('/orders', asyncHandler(async (req, res) => {
  const listing=await services.settings.get('listing.policy');
  const {monitoring,withinMonitoring}=require('../../marketplace/order-monitor');
  const monitor=services.marketplace?.documentedSellerApi?monitoring(services.db,listing):null;
  const orders=new (require('../../marketplace/order-observations').OrderObservations)(services.db).list().filter(order=>!monitor||(!order.monitorScope||order.monitorScope===monitor.scope)&&withinMonitoring(order,monitor));
  res.json({ success: true, orders, monitoringSince:monitor?new Date(monitor.sinceMs).toISOString():null });
}));
router.post('/orders/:orderId/hold',asyncHandler(async(req,res)=>{
  if(typeof req.body.hold!=='boolean')return res.status(400).json({error:'hold must be boolean'});
  const db=services.db.raw(),id=req.params.orderId;
  if(!db.prepare('SELECT id FROM marketplace_observations WHERE id=?').get(id)&&!services.deliveryService?.repo.get(id))return res.status(404).json({error:'Captured order not found'});
  if(req.body.hold){
    const reason=String(req.body.reason||'Owner requested a delivery hold').trim();
    if(!reason||reason.length>500)return res.status(400).json({error:'Hold reason must be 1–500 characters'});
    db.prepare('INSERT INTO owner_delivery_holds(order_id,reason,created_ms) VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET reason=excluded.reason,released_ms=NULL').run(id,reason,Date.now());
  }else db.prepare('UPDATE owner_delivery_holds SET released_ms=? WHERE order_id=?').run(Date.now(),id);
  services.events?.emit('operator:alert',{component:'owner-delivery-hold',orderId:id,reason:req.body.hold?'Owner placed this order on a delivery hold.':'Owner released the delivery hold. Funded-order and payment checks still apply; no payment journal or account lock was reset.'});
  res.json({success:true,held:req.body.hold,paymentSent:false});
}));
router.post('/orders/:orderId/reference',asyncHandler(async(req,res)=>{
  const db=services.db.raw(),row=db.prepare('SELECT payload FROM marketplace_observations WHERE id=?').get(req.params.orderId);
  if(!row)return res.status(404).json({error:'Read Sold Orders first so this order has a captured link.'});
  if(!services.browserBridge?.inspectOrderReference)return res.status(503).json({error:'Restart Autosell to load the order reference reader.'});
  const order=JSON.parse(row.payload),reference=await services.browserBridge.inspectOrderReference(order,{ownerReview:true});
  new(require('../../marketplace/order-observations').OrderObservations)(services.db).recordReference(order,reference);
  res.json({success:true,reference});
}));
router.post('/deliver', asyncHandler(async (req, res) => {
  const row = services.deliveryService?.repo.get(req.body.orderId);
  if (!row) return res.status(404).json({ error: 'Journal order not found' });
  const work = () => services.deliveryService.processOrder(JSON.parse(row.payload), row.account_id || undefined);
  const delivered = services.offerQueue ? await services.offerQueue.exclusive(work) : await work();
  const latest = services.deliveryService.repo.get(row.id);
  res.status(delivered ? 200 : 409).json({ success: delivered, state: latest.state, reason: latest.reason });
}));
router.get('/rollout', (_req,res)=>res.json(services.rollout?.status() || {mode:'live',ready:false}));
for(const path of ['/rollout/unlock','/rollout/resume','/kill'])router.post(path,(_req,res)=>res.status(410).json({error:'Separate trading stages and kill switches have been removed. Use Global Autosell.'}));
router.post('/poll-now', asyncHandler(async (req, res) => {
  if (!services.orderPoller) return res.status(503).json({ error: 'Poller unavailable' });
  const result = await services.orderPoller.poll({inspect:true});
  res.status(result.success ? 200 : 409).json(result);
}));
router.post('/test-connection', asyncHandler(async (_req, res) => {
  res.json(await require('../../marketplace/connection-check').checkSavedConnection(services));
}));
router.get('/pairs', asyncHandler(async (_req, res) => {
  const forwarding = await services.settings.get('treasury.forwarding') || {};
  const policy = await services.settings.get('listing.policy');
  const turn = services.offerQueue?.active(policy.offerId);
  const waiting = services.offerQueue?.waiting(policy.offerId) || [];
  const enabled = await tradingControls.globallyEnabled();
  const listing = services.listingManager?.status?.();
  const connectionState = require('../../marketplace/connection-state').connectionState(await services.settings.get('eldorado.connection'));
  res.json({ success: true, pairs: (services.pairManager?.getPairs() || []).map(pair => {
    const account = tradingControls.deliveryAccount(pair), db = services.db.raw();
    const snapshot = db.prepare('SELECT balance,observed_ms,reason FROM balance_observations WHERE account_id=?').get(account)
      || db.prepare('SELECT balance,observed_ms FROM account_snapshots WHERE account_id=?').get(account);
    return { ...pair, balanceSnapshot: snapshot ? { coins: snapshot.balance, capturedAt: snapshot.observed_ms, reviewReason: snapshot.reason || null } : null,
    sendToHolder: forwarding[tradingControls.canonical(pair.buyerId)] === true,
    deliveryAccount: account, offerStatus: pair.disabled ? {state:'DISABLED'} : !enabled ? {state:'PAUSED',reason:'Global Autosell is off.'} : {
      state: turn?.account_id && turn.account_id!==account ? 'QUEUED' : listing?.state || 'CHECKING',
      reason: connectionState.restartRequired ? connectionState.reason : listing?.pairChecks?.find(check=>check.account===account)?.reason || listing?.reason || (listing?.state==='BLOCKED' ? 'The offer check did not finish. Open Eldorado Setup → Check API connection and read the result.' : null),
    }, offerQueue: {active:turn?.account_id===account,position:waiting.filter(row=>row.account_id!==turn?.account_id).findIndex(row=>row.account_id===account)+1} }; }), queue: waiting });
}));
const configurePairAccounts=pair=>require('../../treasury/pair-credentials').configure(services,pair);
router.post('/pairs', asyncHandler(async (req, res) => {
  const manager = services.pairManager;
  if (!manager) return res.status(503).json({ error: 'Pair manager unavailable' });
  try {
    if (Object.keys(req.body).length !== 1) throw new Error('Supply pairCount or pair');
    if (req.body.pairCount !== undefined) {
      const count = req.body.pairCount;
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('Pair count must be a whole number from 1 to 100');
      const old = manager.getPairs();
      for (const pair of old.filter(pair => pair.pairIndex > count)) {
        tradingControls.assertEditable(pair);
        const clients = (services.sessions || services.sessionManager)?.clients;
        if ([pair.buyerId, pair.sellerId].some(id => clients?.get(tradingControls.canonical(id))?.isOnline())) throw new Error('Stop the pair accounts before removing them');
      }
      const pairs = await manager.setPairCount(count);
      const forwarding = await services.settings.get('treasury.forwarding') || {};
      for (const pair of pairs.filter(pair => !old.some(prior => prior.id === pair.id))) {
        manager.togglePair(pair.id, true);
        forwarding[tradingControls.canonical(pair.buyerId)] = false;
        await configurePairAccounts(pair);
      }
      await services.settings.set('treasury.forwarding', forwarding, 'dashboard');
      return res.json({ success: true, pairs: manager.getPairs() });
    }
    const input = req.body.pair;
    if (!input || typeof input !== 'object') throw new Error('Pair settings required');
    const allowed = ['id','pairIndex','buyerIgn','buyerEmail','sellerIgn','sellerEmail','threshold'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Only account details and threshold may be edited');
    const existing = manager.getPair(input.id);
    tradingControls.assertEditable(existing);
    if (input.pairIndex !== existing.pairIndex) throw new Error('Pair index cannot change');
    if (!Number.isSafeInteger(Number(input.threshold)) || Number(input.threshold) < 1) throw new Error('Threshold must be positive whole coins');
    for (const key of ['buyerIgn','buyerEmail','sellerIgn','sellerEmail']) if (typeof input[key] !== 'string' || input[key].length > 254) throw new Error('Invalid ' + key);
    const result=await require('../../treasury/pair-credentials').update(services,{...input,threshold:Number(input.threshold)});
    services.listingManager?.requestSync();
    services.treasury?.requestBalanceRefresh();
    res.json({ success: true, ...result });
  } catch (error) { res.status(409).json({ error: error.message }); }
}));
router.post('/pairs/toggle', asyncHandler(async (req, res) => {
  if (!services.pairManager?.getPair(req.body.pairId)) return res.status(404).json({ error: 'Pair not found' });
  if (typeof req.body.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be boolean' });
  const pair = services.pairManager.togglePair(req.body.pairId, req.body.disabled);
  if (!pair.disabled) services.treasury?.requestBalanceRefresh();
                                                                                
                                                                       
  const selected = await services.settings.get('listing.policy');
  const current = services.offerQueue?.active(selected?.offerId)?.account_id;
  const unrelatedLegacyPair=!services.offerQueue&&selected?.holderAccount&&tradingControls.canonical(selected.holderAccount)!==tradingControls.deliveryAccount(pair);
  const remote = unrelatedLegacyPair ? {state:'not-selected'} : services.listingManager?.requestSync({ pauseOnly: pair.disabled && (!current || current === tradingControls.deliveryAccount(pair)), notify: !pair.disabled }) || { state: 'unavailable' };
  res.json({ success: true, pair, remote });
}));
  router.get('/treasury', (req, res) => res.json({ transfers: services.db?.raw().prepare("SELECT * FROM ledger WHERE entry_type IN ('sweep','transfer_in','transfer_out','delivery') ORDER BY id DESC LIMIT 50").all() || [] }));
                                                                                                        
router.get('/chat/:orderId', (req, res) => res.json({ success: true, transport: 'manual-inbox', messages: aiChatAgent.transcript(req.params.orderId) }));
router.post('/inbox/:orderId', async (req, res, next) => {
  try { res.json(await aiChatAgent.handleBuyerMessage({ orderId: req.params.orderId, message: req.body.message, messageId: req.body.messageId, source: 'operator-entered' })); } catch (error) { next(error); }
});
router.post('/chat/:orderId', (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 4000) return res.status(400).json({ error: 'A message of 1–4000 characters is required' });
  const id = aiChatAgent.save(req.params.orderId, message, 'out', 'operator', 'operator-draft');
  if (!id) return res.status(503).json({ error: 'Transcript database unavailable' });
  res.json({ success: true, id, sent: false, state: 'draft', transport: 'manual-inbox' });
});
router.post('/chat/:orderId/:messageId/sent', (req, res) => {
  const row = services.db.raw().prepare('SELECT * FROM buyer_messages WHERE id=? AND order_id=?').get(req.params.messageId, req.params.orderId);
  if (!row || row.direction !== 'out') return res.status(404).json({ error: 'Draft not found' });
  if (Date.now() < row.due_ms) return res.status(429).json({ error: 'Reply rate limit', dueMs: row.due_ms });
  services.db.raw().prepare("UPDATE buyer_messages SET state='operator-reported-sent',sent_ms=? WHERE id=?").run(Date.now(), row.id);
  res.json({ success: true, state: 'operator-reported-sent', remoteReceiptVerified: false });
});
router.post('/chat-opening-preview', asyncHandler(async(req,res)=>{
  const reply=AiChatAgent.validateOpening(req.body.message);
  res.json({reply,preview:true,sent:false});
}));
router.post('/chat-preview', async (req, res, next) => {
  try {
    const text = String(req.body.message || '').trim();
    if (!text || text.length > 4000) return res.status(400).json({ error:'A short buyer message is required' });
    const intent = require('../../marketplace/chat-rules').classify(text).intent;
    const permitted = ['DETECTED','SESSION_READY','PAY_SENT','DELIVERED','NEEDS_OPERATOR'];
    const state = permitted.includes(req.body.state) ? req.body.state : 'DETECTED';
    const row = { state, updated_ms:Date.now(), payload:JSON.stringify({ amount:'[order amount]', buyerIgn:'[order IGN]' }) };
    const key = intent === 'cancel' ? 'operator' : ['missing','escalation'].includes(intent) ? 'operator' : require('../../marketplace/chat-rules').templates[intent] ? intent : aiChatAgent.stateTemplate(state);
    res.json({ reply:await aiChatAgent._reply(key,{ orderId:'local-preview', preview:true },row,await aiChatAgent.settings()), intent, state, sent:false, preview:true });
  } catch (error) { next(error); }
});
router.post('/cancel', async (req, res, next) => {
  try {
    const result = await aiChatAgent.handleBuyerMessage({ orderId: req.body.orderId, message: 'cancel my order', source: 'owner-cancellation-request' });
    res.status(result.cancelled ? 200 : 409).json(result);
  } catch (error) { next(error); }
});

                                                                         
router.use('/evidence', require('./evidence')(services));
router.use('/proofs', require('./evidence')(services));

module.exports = router;
