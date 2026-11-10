'use strict';
const crypto = require('crypto');
const util = require('util');
const scrypt = util.promisify(crypto.scrypt);
const services = require('../../services');

const SESSION_TTL = 24 * 60 * 60 * 1000;       
const SESSIONS = new Map();
const CONFIRM_TOKENS = new Map();
const RATE_LIMITS = new Map();

                                 
function base32Decode(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = Buffer.alloc(Math.ceil(encoded.length * 5 / 8));
  for (let i = 0; i < encoded.length; i++) {
    const val = alphabet.indexOf(encoded[i].toUpperCase());
    if (val === -1) continue;
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
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
    
    if (String(code).padStart(6, '0') === String(token).padStart(6, '0')) {
      return true;
    }
  }
  return false;
}

                                
function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

async function verifyAuth(req, res, next) {
                                                    
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const validTokens = services.config.api.tokens || [];            
                                                              
    if (token === services.config.api.key) {                                                                           
      req.auth = { scoped: true, admin: true };
      return next();
    }
  }

                         
  const cookieHeader = req.headers.cookie;
  let sessionId = null;
  if (cookieHeader) {
    const match = cookieHeader.match(/sessionId=([^;]+)/);
    if (match) sessionId = match[1];
  }

  if (sessionId && SESSIONS.has(sessionId)) {
    const session = SESSIONS.get(sessionId);
    if (session.expires > Date.now()) {
      session.expires = Date.now() + SESSION_TTL;         
      req.auth = { session: true, admin: true, id: sessionId };
      return next();
    } else {
      SESSIONS.delete(sessionId);
    }
  }

  res.status(401).json({ success: false, error: 'Unauthorized' });
}

async function requireReauth(req, res, next) {
                                                                            
  if (req.auth && req.auth.scoped) return next();
  
  const token = req.headers['x-confirm-token'] || req.body.confirmToken;
  if (!token || !CONFIRM_TOKENS.has(token)) {
    return res.status(403).json({ success: false, error: 'Re-authentication required. Missing or invalid confirmToken.', needsReauth: true });
  }
  
  const ct = CONFIRM_TOKENS.get(token);
  if (ct.expires < Date.now()) {
    CONFIRM_TOKENS.delete(token);
    return res.status(403).json({ success: false, error: 'Re-authentication token expired.', needsReauth: true });
  }
  
                  
  CONFIRM_TOKENS.delete(token);
  next();
}

module.exports = {
  verifyAuth,
  requireReauth,
  SESSIONS,
  CONFIRM_TOKENS,
  hashPassword: async (pwd, salt) => (await scrypt(pwd, salt, 64)).toString('hex'),
  verifyTotp,
  generateTotpSecret
};
