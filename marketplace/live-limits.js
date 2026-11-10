'use strict';
const { integer } = require('../minecraft/verified-payments');
function validateLiveLimits(caps) {
  if (caps?.unlimited === true) {
    if (!caps.accountId) throw new Error('Select the account that delivers orders.');
    return;
  }
  for (const key of ['maxOrder', 'ordersPerDay', 'totalPerDay']) if (!integer(caps[key], key)) throw new Error('Enter a positive limit or select no additional order/daily limits: ' + key);
  if (!caps.accountId) throw new Error('Select the account that delivers orders.');
}
function checkLiveLimits(caps, amount, entries = []) {
  validateLiveLimits(caps);
  if (caps.unlimited === true) return;
  if (integer(amount) > integer(caps.maxOrder)) throw new Error('Order exceeds your configured maximum order size.');
  const total = entries.reduce((sum, row) => sum + integer(row.amount), 0n);
  if (BigInt(entries.length) >= integer(caps.ordersPerDay) || total + integer(amount) > integer(caps.totalPerDay)) throw new Error('Daily live budget exhausted: your configured daily order or coin limit has been reached.');
}
module.exports = { validateLiveLimits, checkLiveLimits };
