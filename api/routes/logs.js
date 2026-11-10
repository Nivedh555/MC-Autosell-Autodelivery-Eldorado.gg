'use strict';
const router = require('express').Router();
const services = require('../../services');
router.get('/', (_req, res) => res.json({ events: services.db.raw().prepare('SELECT * FROM delivery_events ORDER BY sequence DESC LIMIT 200').all() }));
module.exports = router;
