'use strict';
const {validIgn} = require('../minecraft/verified-payments');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                                                                          
                                                                  
function recipientBalancePattern(data, requestedIgn, amountText) {
  if (!validIgn(requestedIgn) || !data || data.sender || data.position == null || data.position === 'chat') throw Error('Choose a captured server reply to this recipient balance command.');
  const text = String(data.raw).replace(/§./g, '');
  if (text.length > 4000 || /^\s*(?:<|\[[^\]]*\]\s*[^:]+:)|\bwhispers?\b/i.test(text)) throw Error('Player chat and whisper-shaped lines cannot define a recipient balance reply.');
  if (typeof amountText !== 'string' || amountText.length > 32 || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?: ?[A-Za-z]+)?$/.test(amountText)) throw Error('Copy the bounded numeric balance display exactly, including any rounded suffix.');
  const ignMatches = [...text.matchAll(new RegExp('(?<![A-Za-z0-9_.])' + escape(requestedIgn) + '(?![A-Za-z0-9_])', 'gi'))];
  const amountAt = text.indexOf(amountText);
  if (ignMatches.length !== 1 || amountAt < 0 || text.indexOf(amountText, amountAt + 1) !== -1 || /[\d,.]/.test(text[amountAt - 1] || '') || /^[\d,A-Za-z.]/.test(text.slice(amountAt + amountText.length))) throw Error('The requested IGN and complete balance display must each occur exactly once.');
  const ignAt = ignMatches[0].index, ignEnd = ignAt + ignMatches[0][0].length, amountEnd = amountAt + amountText.length;
  if (ignAt < amountEnd && amountAt < ignEnd) throw Error('IGN and amount fields overlap; this reply is ambiguous.');
  const fields = [{start:ignAt,end:ignEnd,pattern:'(?<ign>\\.?[A-Za-z0-9_]{3,16})'}, {start:amountAt,end:amountEnd,pattern:'(?<amount>[^\\r\\n]{1,32})'}].sort((a,b)=>a.start-b.start);
  let cursor = 0, pattern = '^';
  for (const field of fields) { pattern += escape(text.slice(cursor,field.start)) + field.pattern; cursor = field.end; }
  pattern += escape(text.slice(cursor)) + '$';
  return {recipientBalance:pattern, capturedIgn:ignMatches[0][0], capturedDisplay:amountText, systemPosition:data.position, exact:/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(amountText), scope:'Captured recipient display only; payment verification still requires sender debit and matching server confirmation.'};
}
module.exports = {recipientBalancePattern};
