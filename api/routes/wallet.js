'use strict';
const router = require('express').Router();
const services = require('../../services');
router.get('/', (_req, res) => res.json({ keyLoaded: Boolean(services.wallet?.enabled), address: services.wallet?.address || null, balance: null, balanceStatus: 'not-fetched', payouts: services.db.raw().prepare('SELECT id,state,reason,created_ms FROM payout_intents ORDER BY created_ms DESC LIMIT 100').all() }));
router.post('/send', require('../middleware').requireReauth, require('../owner-withdrawal'));
router.get('/withdrawals', (_req, res) => res.json({ success: true, withdrawals: services.db.raw().prepare('SELECT id,address,state,amount_litoshi,fee_litoshi,txid,reason,created_ms,updated_ms FROM wallet_withdrawals ORDER BY created_ms DESC LIMIT 100').all() }));
module.exports = router;
