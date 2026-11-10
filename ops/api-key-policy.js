'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const fingerprint = key => crypto.createHash('sha256').update(key).digest('hex');
async function selectKey(settings, environment, file) {
  const policy = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : { revoked:[] };
  if (!Array.isArray(policy.revoked) || policy.revoked.some(hash=> !/^[a-f0-9]{64}$/.test(hash))) throw Error('Invalid local API-key revocation policy');
  let key = await settings.get('security.api.key') || environment.API_KEY || '';
  if (key && policy.revoked.includes(fingerprint(key))) {
    key = crypto.randomBytes(32).toString('hex');
    await settings.set('security.api.key',key,'startup-key-rotation');
    console.log('[security] Revoked local API key replaced in the encrypted vault. Use owner login; no key is printed.');
  }
  return key;
}
module.exports = { selectKey, fingerprint };
