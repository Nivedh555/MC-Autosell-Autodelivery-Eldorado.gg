'use strict';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { balanceDisplay } = require('../minecraft/balance-display');
                                                                                   
function balancePattern(data, amountText) {
  if (!data || data.sender || data.position == null || data.position === 'chat') throw new Error('Choose a server reply with packet metadata, not player chat or a whisper.');
  const text = String(data.raw).replace(/§./g, '');
  if (/^\s*(?:<|\[[^\]]*\]\s*[^:]+:)|\bwhispers?\b/i.test(text)) throw new Error('Player-chat and whisper-shaped lines cannot define a balance format.');
  amountText = typeof amountText === 'string' ? amountText.trim() : amountText;
  const parsed = balanceDisplay(amountText);
  const start = text.indexOf(amountText);
  if (start < 0 || text.indexOf(amountText, start + 1) !== -1 || /[\d,.]/.test(text[start - 1] || '') || /^(?:[\d,A-Za-z]|\.\d)/.test(text.slice(start + amountText.length))) throw new Error('The amount must occur once as a complete displayed value in the selected reply.');
  const number = parsed.exact ? '(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)' : '(?:[0-9]+(?:\\.[0-9]+)? ?[KkMmBbTt]|[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)';
  return { balance: '^' + escape(text.slice(0, start)) + '(?<amount>' + number + ')' + escape(text.slice(start + amountText.length)) + '$', systemPositions: [data.position], capturedBalance: parsed.amount, capturedDisplay: parsed.display, capturedExact: parsed.exact, balanceDisplay: { compact: !parsed.exact } };
}
module.exports = { balancePattern };
