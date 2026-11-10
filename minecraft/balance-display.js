'use strict';
                                                                            
                                                                            
function balanceDisplay(text) {
  if (typeof text !== 'string' || text.length > 64) throw Error('Copy the balance amount as displayed, for example 443K or 443,217.');
  if (/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return { amount: BigInt(text.replaceAll(',', '')).toString(), display: text, exact: true };
  const match = /^(\d+)(?:\.(\d+))?\s?([KMBT])$/i.exec(text);
  if (!match) throw Error('Copy the balance amount as displayed, for example 443K, 1.5M or 443,217.');
  const fraction = match[2] || '', scale = { K: 1000n, M: 1000000n, B: 1000000000n, T: 1000000000000n }[match[3].toUpperCase()];
  const numerator = BigInt(match[1] + fraction) * scale, divisor = 10n ** BigInt(fraction.length);
  if (numerator % divisor) throw Error('This balance display contains a fraction of one coin. Capture a whole-coin balance reply.');
  return { amount: (numerator / divisor).toString(), display: text, exact: false };
}
module.exports = { balanceDisplay };
