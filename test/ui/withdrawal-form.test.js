'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assets = path.join(__dirname, '../../web/dist/assets');
const source = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8');
const start = source.indexOf('async function ob(');
const end = source.indexOf('async function kn(', start);
function helper(request, values = new Map()) {
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  return new Function('st', 'sessionStorage', 'crypto', 'return ' + source.slice(start, end))(request, storage, crypto);
}
test('Send LTC uses the existing durable owner-request helper', () => {
  assert.ok(source.includes('sendLtc:(e,t,n=!1)=>ob("/wallet/send",{toAddress:e,amountLtc:t,all:n})'));
  assert.ok(!source.includes('Manual withdrawals from this dashboard are disabled'));
});
test('timeout, retry and page reload retain the same withdrawal identity', async () => {
  const values = new Map(); let original;
  const first = helper(async (_url, options) => { original = JSON.parse(options.body).requestId; throw Error('Network timeout'); }, values);
  await assert.rejects(first('/wallet/send', { toAddress: 'recipient', amountLtc: 1, all: false }));
  const reloaded = helper(async (_url, options) => { const requestId = JSON.parse(options.body).requestId; assert.equal(requestId, original); return { requestId, pending: false, success: true }; }, values);
  assert.equal((await reloaded('/wallet/send', { toAddress: 'recipient', amountLtc: 1, all: false })).success, true);
  assert.equal(values.size, 0);
});
test('uncertain receipts retain identity until a reconciled successful response', async () => {
  const values = new Map();
  const send = helper(async (_url, options) => ({ requestId: JSON.parse(options.body).requestId, pending: true }), values);
  await send('/wallet/send', { toAddress: 'recipient', amountLtc: 1, all: false });
  assert.equal(values.size, 1);
});
