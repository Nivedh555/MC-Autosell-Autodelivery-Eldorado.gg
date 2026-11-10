'use strict';
                                                                                
function clean(value, limit=1000) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/§./g,'')
    .replace(/\b(?:mfa\.[\w-]+|[\w-]{24,}\.[\w-]{6}\.[\w-]{27,})\b/g,'[credential removed]')
    .replace(/\b(?:xprv|tprv)[A-Za-z0-9]+\b/g,'[private key removed]')
    .replace(/\b(?:bearer\s+)[^\s]+/gi,'[credential removed]')
    .replace(/((?:password|passphrase|authorization|cookie|api[_ -]?key|token|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n,;]+)/gi,'$1[removed]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g,'[key removed]')
    .replace(/@/g,'＠').replace(/\x00/g,'').trim().slice(0,limit);
}
function readableReason(value) {
  return clean(String(value ?? '').split(/Call log:|\n\s*at\s+/)[0].replace(/(?:locator|frame|page)\.[\w.]+:\s*/g,''),900);
}
module.exports={clean,readableReason};
