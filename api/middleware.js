'use strict';
const crypto = require('crypto');
const util = require('util');
const scrypt = util.promisify(crypto.scrypt);
const services = require('../services');

const SESSION_TTL = 24 * 60 * 60 * 1000;
const LOCKOUT_TIME = 15 * 60 * 1000;
const SESSIONS = new Map();
const CONFIRM_TOKENS = new Map();
const RATE_LIMITS = new Map();

                                                              
                                                                                                                 
                                                               
                                                              
                                                                                                                 
                                                               
function isFirstRun() {
  return !(services.store && services.store.settings && services.store.settings.webAuth);
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function verifyAuth(req, res, next) {
  const sessionId=req.headers.cookie?.match(/sessionId=([^;]+)/)?.[1];
  const ownerSession=SESSIONS.get(sessionId);
                                                                             
                                                             
  if(ownerSession?.expires>Date.now() && ownerSession.dashboardUntil>Date.now()){
    req.auth={session:true,sessionId,admin:true};return next();
  }
  const expectedKey = services.apiKey || (services.config && services.config.api && services.config.api.key) || process.env.API_KEY;


                                            
  const xApiKey = req.get('x-api-key') || req.headers['x-api-key'];
  if (xApiKey && safeEqual(xApiKey, expectedKey)) {
    req.auth = { apiKey: true, admin: true };
    return next();
  }

                                  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (token && safeEqual(token, expectedKey)) {
      req.auth = { scoped: true, admin: true };
      return next();
    }
  }

                      
  const cookieHeader = req.headers.cookie;
  let legacySessionId = null;
  if (cookieHeader) {
    const match = cookieHeader.match(/sessionId=([^;]+)/);
    if (match) legacySessionId = match[1];
  }

  if (legacySessionId && SESSIONS.has(legacySessionId)) {
    const session = SESSIONS.get(legacySessionId);
    if (session.expires > Date.now()) {
      session.expires = Date.now() + SESSION_TTL;
      req.auth = { session: true, sessionId:legacySessionId, admin: true };
      return next();
    } else {
      SESSIONS.delete(legacySessionId);
    }
  }


  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

function requireReauth(req, res, next) {
  if (req.reauthenticated) return next();
                                                                           
                                                                              
  const session=SESSIONS.get(req.auth?.sessionId);
  if(req.auth?.session && session?.expires>Date.now() && session.dashboardUntil>Date.now()){
    req.reauthenticated=true;return next();
  }
  const token = req.headers['x-confirm-token'] || (req.body && req.body.confirmToken);
  if (!token || !CONFIRM_TOKENS.has(token)) {
    return res.status(403).json({ success: false, error: 'Re-authentication required. Needs confirmToken.', needsReauth: true });
  }
  const ct = CONFIRM_TOKENS.get(token);
  if (ct.expires < Date.now() || ct.subject !== (req.auth?.sessionId || 'api-owner')) {
    CONFIRM_TOKENS.delete(token);
    return res.status(403).json({ success: false, error: 'Token expired', needsReauth: true });
  }
  CONFIRM_TOKENS.delete(token);
  req.reauthenticated = true;
  next();
}

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = RATE_LIMITS.get(ip) || { count: 0, lockedUntil: 0 };
  if (now < record.lockedUntil) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Locked out.' });
  }
  req.loginIp = ip;
  req.loginRecord = record;
  next();
}

function recordLoginFailure(req) {
  if (!req.loginRecord) return;
  req.loginRecord.count += 1;
  if (req.loginRecord.count >= 5) {
    req.loginRecord.lockedUntil = Date.now() + LOCKOUT_TIME;
    req.loginRecord.count = 0;
  }
  RATE_LIMITS.set(req.loginIp, req.loginRecord);
}

function clearLoginFailure(req) {
  RATE_LIMITS.delete(req.loginIp);
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function errorHandler(err, req, res, _next) {
                       
  let errMsg = err.message || String(err);
  if (services.logger && services.logger.redact) {
    errMsg = services.logger.redact(errMsg);
  }
  console.error('[api] error:', errMsg);
  if (services.logger) services.logger.error('API error', errMsg, { path: req.path });
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Internal server error' });
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.headers.cookie || !req.headers.cookie.includes('csrfToken=')) {
      const token = crypto.randomBytes(32).toString('hex');
      res.cookie('csrfToken', token, { httpOnly: false, sameSite: 'Lax', path: '/' });
    }
    return next();
  }

                                                       
  if (req.auth?.apiKey || req.auth?.scoped) {
    return next();
  }

  const cookieMatch = req.headers.cookie && req.headers.cookie.match(/csrfToken=([^;]+)/);
  const cookieToken = cookieMatch ? cookieMatch[1] : null;
  const headerToken = req.headers['x-csrf-token'];
  const session = SESSIONS.get(req.auth?.sessionId);
  if (session && safeEqual(session.csrfToken, headerToken) && safeEqual(cookieToken, headerToken)) {
    return next();
  }

  return res.status(403).json({ success: false, error: 'CSRF validation failed' });
}

                  
function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, index = 0;
  const output = Buffer.alloc(Math.ceil(encoded.length * 5 / 8));
  for (let i = 0; i < encoded.length; i++) {
    const val = alphabet.indexOf(encoded[i].toUpperCase());
    if (val === -1) continue;
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) { output[index++] = (value >>> (bits - 8)) & 255; bits -= 8; }
  }
  return output.slice(0, index);
}

function verifyTotp(token, secret) {
  if (!secret || !token) return false;
  const decodedSecret = base32Decode(secret);
  const timeStep = Math.floor(Date.now() / 30000);
  for (let i = -1; i <= 1; i++) {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor((timeStep + i) / 4294967296), 0);
    buf.writeUInt32BE((timeStep + i) % 4294967296, 4);
    const hmac = crypto.createHmac('sha1', decodedSecret);
    hmac.update(buf);
    const result = hmac.digest();
    const offset = result[result.length - 1] & 0xf;
    const code = (result.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    if (String(code).padStart(6, '0') === String(token).padStart(6, '0')) return true;
  }
  return false;
}

module.exports = {
  safeEqual,
  verifyAuth,
  requireReauth,
  loginRateLimit,
  recordLoginFailure,
  clearLoginFailure,
  asyncHandler,
  errorHandler,
  csrfProtection,
  SESSIONS,
  CONFIRM_TOKENS,
  hashPassword: async (pwd, salt) => (await scrypt(pwd, salt, 64)).toString('hex'),
  isFirstRun,
  generateTotpSecret,
  verifyTotp
};
