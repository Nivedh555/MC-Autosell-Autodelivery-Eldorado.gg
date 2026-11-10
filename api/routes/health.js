'use strict';
const router = require('express').Router();
const services = require('../../services');
router.get('/', require('../middleware').asyncHandler(async (_req, res) => {
  if (!services.ops) return res.status(503).json({ status: 'monitor-unavailable' });
  res.json(await services.ops.health());
}));
module.exports = router;
