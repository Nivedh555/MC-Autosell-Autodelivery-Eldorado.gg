'use strict';
const { validIgn } = require('../minecraft/verified-payments');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function amount(text, unit = '') {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw Error('Receipt amount is malformed');
  const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
  const scale = ({'':1n,K:1000n,M:1000000n,B:1000000000n,T:1000000000000n})[unit.toUpperCase()];
  if (!scale || fraction.length > 12) throw Error('Unsupported receipt amount unit');
  const n = BigInt(whole+fraction)*scale, d = 10n**BigInt(fraction.length);
  if (n%d || n/d <= 0n || n/d > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Receipt must represent positive exact whole coins');
  return n/d;
}
function incomingPattern(data, ign, amountText) {
  if (!validIgn(ign) || !data || data.sender || data.position == null || data.position === 'chat') throw Error('Choose an actual server receipt with captured packet metadata');
  const raw = String(data.raw || '').replace(/§./g, '');
  if (raw.length > 4000 || /^\s*(?:<|\[[^\]]*\]\s*[^:]+:)|\bwhispers?\b/i.test(raw)) throw Error('Player chat and whispers cannot define payment receipts');
  if (typeof amountText !== 'string' || amountText.length > 40) throw Error('Copy the receipt amount exactly');
  const token = /^((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(?: ?([KkMmBbTt]))?$/.exec(amountText);
  if (!token) throw Error('Copy the complete numeric amount, including its K/M/B/T suffix');
  const value = amount(token[1],token[2]||'');
  const names = [...raw.matchAll(new RegExp('(?<![A-Za-z0-9_.])'+escape(ign)+'(?![A-Za-z0-9_])','gi'))];
  const at = raw.indexOf(amountText);
  if (names.length!==1 || at<0 || raw.indexOf(amountText,at+1)!==-1 || /[\d,.]/.test(raw[at-1]||'') || /^[\d,.A-Za-z]/.test(raw.slice(at+amountText.length))) throw Error('Sender and complete amount must each occur exactly once');
  const pieces=[{start:names[0].index,end:names[0].index+names[0][0].length,pattern:'(?<ign>\\.?[A-Za-z0-9_]{3,16})'},
    {start:at,end:at+amountText.length,pattern:'(?<amount>(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\\.[0-9]+)?)(?: ?(?<unit>[KkMmBbTt]))?'}].sort((a,b)=>a.start-b.start);
  if(pieces[0].end>pieces[1].start)throw Error('Sender and amount overlap');
  return {incoming:'^'+escape(raw.slice(0,pieces[0].start))+pieces[0].pattern+escape(raw.slice(pieces[0].end,pieces[1].start))+pieces[1].pattern+escape(raw.slice(pieces[1].end))+'$',systemPosition:data.position,capturedAmount:String(value)};
}
module.exports = { incomingPattern, amount };
