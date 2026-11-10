'use strict';
const services = require('../services');
const { validIgn, integer } = require('../minecraft/verified-payments');
function patterns(pack) {
  if (pack?.incoming) return [pack.incoming];                                         
  return pack?.serverProfile === 'donutsmp-v1' && pack.incomingMode === 'donutsmp-builtin' ? pack.incomingPatterns || [] : [];
}
function canMatch(pack) {
  return Boolean((pack?.incomingCalibrated || pack?.calibrated || pack?.incomingMode==='donutsmp-builtin') &&
    (pack.incomingSource || pack.source) && patterns(pack).some(p=>typeof p==='string' && p.startsWith('^') && p.endsWith('$')));
}
function matchCaptured(raw, packet, pack) {
  pack = pack || services.settings?.getSync?.('delivery.patternPack');
  if (!canMatch(pack)) return null;
  if (!packet || packet.sender || !pack.systemPositions?.includes(packet.position)) return null;
  const text = String(raw || '').replace(/§./g, '');
  if (text.length>2000 || /^\s*<|\bwhisper/i.test(text)) return null;
  const match = patterns(pack).map(p=>new RegExp(p,!pack.incoming?'i':'').exec(text)).find(Boolean);
  if (!match || !validIgn(match.groups?.ign)) return null;
  let amount;
  try {
    if (match.groups.unit && !pack.incomingSource) return null;
    amount = require('../ops/incoming-payment-pattern').amount(match.groups.amount || '', match.groups.unit || '');
  } catch { return null; }
  if (!amount || amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { username: match.groups.ign, amountText: String(amount), rawLine: String(raw), packet };
}
module.exports = { canMatch, matchCaptured, match: (raw, packet) => matchCaptured(raw, packet),
  tester: (lines, pack) => lines.map(line => ({ line, match: matchCaptured(line.raw, line.packet, pack), scope: 'pattern test only; no money moved' })) };
