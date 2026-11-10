'use strict';
const router = require('express').Router();
const services = require('../../services');
const { asyncHandler } = require('../middleware');
router.get('/', asyncHandler(async (_req, res) => {
  if (!services.settings) return res.status(503).json({ error: 'Settings unavailable' });
  const data = [];
  for (const [id, definition] of services.settings.definitions) {
    if (definition.retired) continue;
    const value = await services.settings.get(id);
    data.push({ definition, value: definition.secret ? null : value, configured: definition.secret ? Boolean(value) : undefined });
  }
  res.json({ success: true, data });
}));
router.get('/:id', asyncHandler(async (req, res) => {
  const definition = services.settings?.definitions.get(req.params.id);
  if (!definition || definition.retired) return res.status(404).json({ error: 'Unknown or removed setting' });
  const value = await services.settings.get(req.params.id);
  res.json({ definition, value: definition.secret ? null : value, configured: definition.secret ? Boolean(value) : undefined });
}));
router.put('/:id', asyncHandler(async (req, res) => {
  if (['marketplace.kill_switch','marketplace.dry_run','sales.dryRun','marketplace.live_requested'].includes(req.params.id)) return res.status(410).json({ error: 'This setting has been removed. Use Global Autosell and pair controls.' });
  await services.settings.set(req.params.id, req.body.value, 'owner');
  if (req.params.id === 'security.api.key') services.apiKey = req.body.value;
  res.json({ success: true, restartRequired: true, liveMode: true });
}));
module.exports = router;
