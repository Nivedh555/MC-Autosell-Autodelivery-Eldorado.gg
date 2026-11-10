'use strict';
const router = require('express').Router();
const services = require('../../services');
const { asyncHandler } = require('../middleware');
router.get('/status',asyncHandler(async(_req,res)=>{
  const pack=await services.settings.get('delivery.patternPack')||{},policy=await services.settings.get('payout.policy')||{};
  const roles=await services.settings.get('treasury.accountRoles')||{};
  res.json({success:true,enabled:await require('../../treasury/trading-controls').globallyEnabled(),
    accounts:Object.entries(roles).filter(([,r])=>r.role==='intake').map(([id,r])=>({id,ign:r.ign||null,online:Boolean(services.sessions?.clients?.get(id)?.isOnline?.())})),
    incomingConfigured:require('../../payments/payment-patterns').canMatch(pack),balanceConfigured:Boolean(pack.balanceCalibrated||pack.calibrated),
    payoutPolicy:policy,walletConfigured:Boolean(services.wallet?.enabled),sendEnabled:Boolean(services.store?.sendEnabled?.()),
    buyMoneyEnabled:services.store?.buyMoneyEnabled?.(),buySkellyEnabled:services.store?.buySkellyEnabled?.(),
    captures:services.db.raw().prepare('SELECT * FROM calibration_runs ORDER BY started_ms DESC LIMIT 20').all(),
    exactBalanceRequired:true,
    capacity:{...require('../../sell/intake-admission').status(),spawnerQueued:services.sellManager?.queue?.length||0,spawnerQueueLimit:services.sellManager?.maxQueue||25},
    unresolved:{money:services.db.raw().prepare("SELECT COUNT(*) n FROM intake_sales WHERE state IN ('RECEIVED','NEEDS_OPERATOR')").get().n,payouts:services.db.raw().prepare("SELECT COUNT(*) n FROM payout_intents WHERE state!='BROADCAST'").get().n,spawners:services.db.raw().prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('payout_failed','needs_operator')").get().n}});
}));
router.post('/policy',asyncHandler(async(req,res)=>{
  try {
    const allowed=['enabled','addressMode','allowedAddresses','maxPerTxFiatMicros','maxPerDayFiatMicros'];
    if(Object.keys(req.body||{}).some(k=>!allowed.includes(k)))throw Error('Unsupported payout policy field');
    const policy=require('../../payments/payout-policy').validate(req.body);
    if(policy.allowedAddresses.some(a=>!services.wallet.isValidAddress(a)))throw Error('Allow-list contains an invalid Litecoin address');
    await services.settings.set('payout.policy',policy,'owner-intake-setup');res.json({success:true});
  }catch(error){res.status(400).json({success:false,error:error.message});}
}));
router.post('/incoming',asyncHandler(async(req,res)=>{
  try {res.json(await services.calibration.reviewIncoming(req.body.captureId,req.body.eventId,req.body.ign,req.body.amountText,req.body.confirmation));}
  catch(error){res.status(409).json({success:false,error:error.message});}
}));
module.exports=router;
