'use strict';
const crypto = require('crypto');

function csrfProtection(req, res, next) {
                           
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
                                 
    if (!req.headers.cookie || !req.headers.cookie.includes('csrfToken=')) {
      const token = crypto.randomBytes(32).toString('hex');
      res.cookie('csrfToken', token, { httpOnly: false, sameSite: 'Strict' });
    }
    return next();
  }

                                 
  const cookieMatch = req.headers.cookie && req.headers.cookie.match(/csrfToken=([^;]+)/);
  const cookieToken = cookieMatch ? cookieMatch[1] : null;
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ success: false, error: 'CSRF validation failed' });
  }

  next();
}

module.exports = { csrfProtection };
