'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const middleware = require('./middleware');
const services = require('../services');
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const setting = (key, fallback) => services.settings?.getSync?.(key) ?? fallback;
function originGuard(req, res, next) {
  const origin = req.headers.origin;
  const allow = setting('security.api.allowedOrigins', []);
  if (origin && origin!==services.desktopOrigin && (!Array.isArray(allow) || !allow.includes(origin))) return res.status(403).json({ success: false, error: 'Origin not allowed' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,x-api-key,x-csrf-token,x-confirm-token');
    return res.sendStatus(204);
  }
  next();
}
async function checkPassword(password) {
  const auth = services.store?.settings?.webAuth;
  if (!auth || typeof password !== 'string' || password.length > 1024) return false;
  return middleware.safeEqual((await scrypt(password, auth.salt, 64)).toString('hex'), auth.hash);
}
function authRouter() {
  const router = require('express').Router();
  router.get('/status', (req, res) => res.json({ setupRequired: middleware.isFirstRun() }));
  router.post('/setup', middleware.loginRateLimit, middleware.asyncHandler(async (req, res) => {
    if (!loopback(req)) return res.status(403).json({ error: 'Setup requires a loopback connection' });
    if (!middleware.isFirstRun()) return res.status(409).json({ error: 'Already configured' });
    if (!services.store?.settings || !services.store?._save) return res.status(503).json({ error: 'Settings store unavailable' });
    const { password, confirmPassword } = req.body;
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || password !== confirmPassword) return res.status(400).json({ error: 'Matching password of 12–1024 characters required' });
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    if (!middleware.isFirstRun()) return res.status(409).json({ error: 'Already configured' });
    services.store.settings.webAuth = { salt, hash };
    services.store._save();
    res.json({ success: true });
  }));
  router.post('/login', middleware.loginRateLimit, middleware.asyncHandler(async (req, res) => {
    if (!await checkPassword(req.body.password)) {
      middleware.recordLoginFailure(req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    middleware.clearLoginFailure(req);
    const id = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const expires=Date.now()+86400000;
    middleware.SESSIONS.set(id, { expires, csrfToken, dashboardUntil:req.body.dashboardSession===true?expires:0 });
    const options = { sameSite: 'Strict', secure: req.secure, path: '/' };
    res.cookie('sessionId', id, { ...options, httpOnly: true });
    res.cookie('csrfToken', csrfToken, options);
    res.json({ success: true, csrfToken, dashboardSession:req.body.dashboardSession===true });
  }));
  router.use(middleware.verifyAuth, middleware.csrfProtection);
  router.post('/reauth', middleware.loginRateLimit, middleware.asyncHandler(async (req, res) => {
    if (!await checkPassword(req.body.password)) {
      middleware.recordLoginFailure(req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const confirmToken = crypto.randomBytes(32).toString('hex');
    middleware.CONFIRM_TOKENS.set(confirmToken, { expires: Date.now() + 60000, subject: req.auth.sessionId || 'api-owner' });
    res.json({ success: true, confirmToken });
  }));
  router.post('/logout', (req, res) => {
    middleware.SESSIONS.delete(req.auth.sessionId);
    res.clearCookie('sessionId');
    res.clearCookie('csrfToken');
    res.json({ success: true });
  });
  router.use((req, res) => res.status(404).json({ error: 'Unknown auth operation' }));
  return router;
}
function sensitiveGuard(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  if (!/\/(env|config|settings|control|wallet|sellers|marketplace|pairs|ops|intake)(\/|$)/.test(req.path)) return next();
  middleware.requireReauth(req, res, () => {
    if (/\/(sellers\/cashout|control\/(announce|say))$/.test(req.path)) return res.status(409).json({ error: 'Operation disabled pending durable limits and audit integration' });
    if (req.path.endsWith('/control/mc-command')) {
      const allowed = setting('security.commands.allowlist', []);
      const cmd = req.body?.command;
      const payment = require('../treasury/owner-actions').payCommand(cmd);
      if (payment) {
        try { require('../treasury/owner-actions').requestId(req.body.requestId); }
        catch { return res.status(403).json({ error: 'Refresh the dashboard before sending /pay. A recorded payment request ID is required; no command was sent.' }); }
      }
      if (typeof cmd !== 'string' || /[\r\n]/.test(cmd) || (/^\/?pay\b/i.test(cmd) && !payment) || (!payment && !require('../minecraft/verified-payments').balanceCommand(cmd) && !allowed.includes(cmd))) return res.status(403).json({ error: 'Use /bal, /bal IGN, or /pay IGN amount (for example /pay Steve 100m). Other commands must be enabled in console settings.' });
    }
    const audit = services.settings?.store?.auditLog;
    if (!audit?.log) return res.status(503).json({ error: 'Audit store unavailable' });
    audit.log(req.auth.sessionId ? 'owner-session' : 'owner-token', 'API_INTENT', req.path, null, { method: req.method });
    next();
  });
}
module.exports = { originGuard, authRouter, sensitiveGuard, loopback };
