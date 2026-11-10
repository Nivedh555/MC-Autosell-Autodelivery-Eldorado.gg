'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { safeArtifact } = require('../../marketplace/proof-generator');
const { verifyAuth } = require('../middleware');
function evidenceRouter(services, root = path.join(process.cwd(), 'data', 'proofs')) {
  const router = express.Router();
  router.use(verifyAuth);
  router.get('/:orderId', (req, res) => {
    try {
      const row = services.db?.raw().prepare('SELECT evidence FROM delivery_orders WHERE id=?').get(req.params.orderId);
      if (!row?.evidence) return res.status(404).json({ error: 'Evidence not available' });
      const evidence = JSON.parse(row.evidence);
      if (!/^[a-f0-9-]{36}$/.test(evidence.artifactId)) throw new Error('Invalid evidence reference');
      const directory = path.join(path.resolve(services.evidenceRoot || root), evidence.artifactId);
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Evidence symlink refused');
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.query.file) {
        if (!evidence.files.includes(req.query.file)) return res.status(404).json({ error: 'Artifact not in pack' });
        return res.download(safeArtifact(directory, req.query.file), req.query.file);
      }
                                                                                                   
      const files = Object.fromEntries(evidence.files.map(name => [name, fs.readFileSync(safeArtifact(directory, name)).toString('base64')]));
      res.attachment('delivery-record-' + evidence.artifactId + '.json').json({ encoding: 'base64', files });
    } catch (error) { res.status(409).json({ error: 'Evidence could not be read safely' }); }
  });
  return router;
}
module.exports = evidenceRouter;
