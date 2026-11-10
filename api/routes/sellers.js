'use strict';
const router = require('express').Router();
router.use((_req, res) => res.status(501).json({ success: false, error: 'This legacy v2 sellers route has not been implemented; use the authenticated journal and intake records' }));
module.exports = router;
