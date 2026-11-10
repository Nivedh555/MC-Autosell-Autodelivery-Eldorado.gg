'use strict';
const router = require('express').Router();
const services = require('../../services');
router.get('/', (_req, res) => res.json({ sessions: [...(services.sessions?.clients || [])].map(([id, client]) => ({ id, connected: Boolean(client.isOnline?.()), state: services.sessions.getState(id), leases: services.sessions.getLeases(id).map(l => ({ id: l.id, state: l.state, reason: l.reason })) })) }));
module.exports = router;
