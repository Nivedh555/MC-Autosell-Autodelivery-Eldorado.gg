'use strict';
const router = require('express').Router();
const services = require('../../services');
const { asyncHandler } = require('../middleware');
router.get('/health', asyncHandler(async (_req, res) => {
  if (!services.ops) return res.status(503).json({ status: 'monitor-unavailable' });
  res.json(await services.ops.health());
}));
router.get('/metrics', (_req, res) => res.json(services.ops?.metrics() || { unavailable: true }));
router.get('/browser', (_req, res) => res.json({ bridge: services.browserBridge?.status() || { state: 'DISCONNECTED' }, actions: services.db.raw().prepare('SELECT id,operation,resource_id,state,reason,created_ms FROM browser_actions ORDER BY created_ms DESC LIMIT 100').all() }));
router.get('/browser/profiles',asyncHandler(async(_req,res)=>res.json(await require('../../marketplace/browser/chrome-profiles').inventory({mode:'attach'}))));
for (const [route,method] of [['open','open'],['check','checkConnection'],['start','resume'],['close','close']]) {
  router.post('/browser/'+route, asyncHandler(async (req,res)=>{
    const browser=services.browserBridge;
    if (!browser || typeof browser[method] !== 'function') return res.status(503).json({error:'Select the Playwright browser connection and restart Autosell'});
    if (route==='start' && !['browser','hybrid','api'].includes(await services.settings.get('eldorado.connection'))) return res.status(409).json({error:'Select Browser or Browser + API and restart Autosell'});
    if(route==='open' && Object.keys(req.body || {}).some(key=>key!=='browserOptions'))return res.status(400).json({error:'Unsupported browser-open field'});
    const config=route==='open'?require('../../marketplace/browser/playwright-session').validateProfileOptions(req.body?.browserOptions || await services.settings.get('eldorado.browser.options')):undefined;
    const result=route==='open'?await browser.open(config):await browser[method]();
    if(route==='open'){
      services.listingManager?.requestSync();
      setImmediate(()=>services.orderPoller?.poll().catch(error=>services.events?.emit('operator:alert',{component:'poller',reason:error.message})));
    }
    res.json(result || browser.status());
  }));
}
router.get('/browser/observations', (_req, res) => res.json({ observations:services.db.raw().prepare("SELECT id,url,data,created_ms,source FROM browser_observations WHERE source='captured visible DOM inventory' ORDER BY created_ms DESC LIMIT 20").all().map(row=>({...row,data:JSON.parse(row.data)})), verified:false, liveUnlocked:false }));
router.post('/browser/pause', (req, res) => { services.browserBridge?.pause('Owner paused from dashboard'); res.json({ paused: true }); });
router.post('/browser/preview', asyncHandler(async (req, res) => {
  const { profile, operation, id } = req.body;
  if (!['listOffers','getOffer','listOrders','getOrder','getMessages'].includes(operation) || profile?.operations?.[operation]?.steps?.length || profile?.origin !== 'https://www.eldorado.gg' || profile.synthetic) return res.status(400).json({ error:'Read-only observed profile required' });
  if (!services.browserBridge) return res.status(503).json({ error:'Start Autosell with the browser connection selected' });
  const result = await services.browserBridge.request({ operation, profile, args:{ id }, preview:true });
  res.json({ ...result, verified:false, liveUnlocked:false, message:'Read-only preview. Review the extracted fields against the website.' });
}));
router.post('/browser/observe', asyncHandler(async (_req, res) => {
  if (!services.browserBridge) return res.status(503).json({ error: 'Browser connection is not active; select it and restart' });
  res.json(await services.browserBridge.capture());
}));
router.get('/alerts', (_req, res) => res.json(services.db.raw().prepare('SELECT * FROM operator_alerts ORDER BY last_ms DESC LIMIT 200').all()));
router.post('/alerts/:id/acknowledge', (req, res) => {
  const result = services.db.raw().prepare('UPDATE operator_alerts SET acknowledged_ms=? WHERE id=?').run(Date.now(), req.params.id);
  res.status(result.changes ? 200 : 404).json({ acknowledged: Boolean(result.changes), moneyStateChanged: false });
});
router.post('/backup', asyncHandler(async (_req, res) => {
  const backup = await services.db.backup();
  res.download(backup, require('node:path').basename(backup));
}));
router.post('/calibration/start', asyncHandler(async (req, res) => {
  if (!services.calibration) return res.status(503).json({ error: 'Calibration recorder unavailable' });
  res.json(await services.calibration.start(req.body.accountId, req.body.confirmation, req.body.recipient ?? null));
}));
router.get('/calibration/:id', (req, res) => res.json(services.calibration?.get(req.params.id) || { unavailable: true }));
router.post('/calibration/:id/stop', (req, res) => res.json({ stopped: services.calibration?.stop(req.params.id) || false }));
router.post('/calibration/:id/balance', asyncHandler(async (req, res) => {
  if (!services.calibration) return res.status(503).json({ error: 'Balance recorder is unavailable. Restart Autosell.' });
  try { res.json(await services.calibration.reviewBalance(req.params.id, req.body.eventId, req.body.amountText, req.body.confirmation)); }
  catch (error) { res.status(409).json({ error: error.message }); }
}));
router.post('/calibration/:id/recipient-balance', asyncHandler(async (req, res) => {
  if (!services.calibration) return res.status(503).json({error:'Recipient balance recorder unavailable. Restart Autosell.'});
  try { res.json(await services.calibration.reviewRecipientBalance(req.params.id,req.body.eventId,req.body.amountText,req.body.confirmation)); }
  catch (error) { res.status(409).json({error:error.message}); }
}));
router.post('/payment-capture',asyncHandler(async(req,res)=>{
  if(!services.calibration)return res.status(503).json({error:'Restart Autosell to load controlled payment capture.'});
  if(Object.keys(req.body||{}).some(key=>!['accountId','recipient','requestId','confirmation'].includes(key)))return res.status(400).json({error:'Unsupported payment capture field; this tool sends exactly one coin.'});
  res.json(await services.calibration.capturePayment(req.body));
}));
module.exports = router;
