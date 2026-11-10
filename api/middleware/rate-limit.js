'use strict';
const loginAttempts = new Map();                                
const generalAttempts = new Map();                                

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (now < record.lockedUntil) {
    return res.status(429).json({ success: false, error: 'Too many login attempts. Locked out for 15 minutes.' });
  }

                                                                   
  req.loginRateRecord = record;
  req.loginIp = ip;
  next();
}

function recordLoginFailure(req) {
  const record = req.loginRateRecord;
  if (!record) return;
  record.count += 1;
  if (record.count >= 5) {
    record.lockedUntil = Date.now() + 15 * 60 * 1000;           
    record.count = 0;
  }
  loginAttempts.set(req.loginIp, record);
}

function clearLoginFailure(req) {
  loginAttempts.delete(req.loginIp);
}

function generalRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = generalAttempts.get(ip) || { count: 0, windowStart: now };

  if (now - record.windowStart > 60000) {                   
    record.count = 0;
    record.windowStart = now;
  }

  record.count += 1;
  generalAttempts.set(ip, record);

  if (record.count > 300) {                             
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }
  next();
}

module.exports = { loginRateLimit, recordLoginFailure, clearLoginFailure, generalRateLimit };
