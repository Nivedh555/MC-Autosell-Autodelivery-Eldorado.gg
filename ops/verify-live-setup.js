'use strict';
                                                                               
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const root = path.resolve(__dirname,'..');
const raw = new DatabaseSync(path.join(root,'data','autosell.db'),{readOnly:true});
const defaults = {'eldorado.browser.profile':require('../marketplace/browser/profile.json')};
const allowed = new Set(['eldorado.connection','eldorado.browser.profile','delivery.policy','delivery.patternPack','listing.policy','eldorado.chat.local','eldorado.order.auto_deliver','general.bot.paused','eldorado.contract']);
const services = {db:{raw:()=>raw},settings:{get:async id=>{if(!allowed.has(id))throw Error('Secret or unsupported setting refused');const row=raw.prepare('SELECT value FROM settings WHERE id=?').get(id);return row?JSON.parse(row.value):defaults[id];}},
  pairManager:{getPairs:()=>raw.prepare('SELECT * FROM account_pairs ORDER BY pair_index').all().map(pair=>({pairIndex:pair.pair_index,buyerId:pair.buyer_id,sellerId:pair.seller_id,buyerIgn:pair.buyer_ign,sellerIgn:pair.seller_ign,buyerEmail:pair.buyer_email,sellerEmail:pair.seller_email,disabled:Boolean(pair.disabled),threshold:pair.threshold}))}};
require('./live-verification').inspectLiveSetup(services,{runtimeObserved:false}).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>raw.close());
