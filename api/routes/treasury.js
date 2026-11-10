'use strict';
const router = require('express').Router();
const services = require('../../services');
router.get('/status', (_req, res) => res.json({ transfers: services.db.raw().prepare('SELECT * FROM transfer_queue ORDER BY created_ms DESC LIMIT 100').all() }));
router.get('/accounts', (_req, res) => res.json({ snapshots: services.db.raw().prepare('SELECT * FROM account_snapshots').all(), roles: services.settings.getSync('treasury.accountRoles') }));
module.exports = router;
