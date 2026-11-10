'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns').promises;
const https = require('node:https');
const { HttpClient } = require('../../api/http-client');
const { LtcWallet } = require('../../wallet/ltc-wallet');
const services = require('../../services');
const originals = { lookup: dns.lookup, request: https.request, config: services.config };
after(() => { dns.lookup = originals.lookup; https.request = originals.request; services.config = originals.config; });

test('BlockCypher has a configured Litecoin root and safely encodes token', () => {
  const config = require('../../config');
  assert.equal(config.wallet.blockcypherBase, 'https://api.blockcypher.com/v1/ltc/main');
  services.config = { wallet: { blockcypherBase: config.wallet.blockcypherBase, blockcypherToken: 'secret&bad=1' } };
  const url = new URL(new LtcWallet()._bcy('/addrs/example?unspentOnly=true'));
  assert.equal(url.pathname, '/v1/ltc/main/addrs/example');
  assert.equal(url.searchParams.get('token'), 'secret&bad=1');
  assert.equal(url.searchParams.get('bad'), null);
});

test('DNS lookup is bounded by request deadline', async () => {
  dns.lookup = () => new Promise(() => {});
  try { await assert.rejects(new HttpClient().get('https://api.blockcypher.com/', { timeout: 25 }), /DNS resolution timed out; request was not sent/); }
  finally { dns.lookup = originals.lookup; }
});

test('checked address list supports family fallback without retrying a POST', async () => {
  const addresses = [{ address: '2606:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }];
  dns.lookup = async () => addresses;
  let calls = 0;
  https.request = (_url, options, onResponse) => {
    calls++;
    assert.equal(options.autoSelectFamily, true);
    options.lookup('unused', { all: true }, (_error, values) => assert.deepEqual(values, addresses));
    const req = new EventEmitter(); req.write = () => {};
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; onResponse(res); res.emit('data', Buffer.from('ok')); res.emit('end'); });
    req.destroy = error => req.emit('error', error);
    return req;
  };
  try { assert.equal((await new HttpClient().post('https://api.blockcypher.com/', {})).status, 200); assert.equal(calls, 1); }
  finally { dns.lookup = originals.lookup; https.request = originals.request; }
});

test('mixed public/private DNS answers remain prohibited', async () => {
  dns.lookup = async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }];
  try { await assert.rejects(new HttpClient().resolveAllowed('https://api.blockcypher.com/'), /prohibited/); }
  finally { dns.lookup = originals.lookup; }
});

test('simultaneous balance requests share one provider read', async () => {
  const wallet = new LtcWallet(); wallet.enabled = true; wallet.address = 'example';
  let calls = 0;
  wallet._fetchBalanceLitoshi = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return 12345; };
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => wallet.getBalanceLitoshi())), Array(12).fill(12345));
  assert.equal(calls, 1);
  assert.equal(await wallet.getBalanceLitoshi(), 12345); assert.equal(calls, 1);
});

test('failed balance is unknown, never a fabricated zero or stale spendable value', async () => {
  const wallet = new LtcWallet(); wallet.enabled = true; wallet.address = 'example';
  wallet._balCache = { value: 999, at: 1 }; let calls = 0;
  wallet._fetchBalanceLitoshi = async () => { calls++; throw Error('offline'); };
  wallet.getRate = async () => 50;
  const status = await wallet.getReadStatus();
  assert.equal(status.balanceLtc, null); assert.equal(status.balanceUsd, null); assert.equal(status.balanceStatus, 'unavailable');
  await assert.rejects(wallet.getBalanceLitoshi(), /cooling down/); assert.equal(calls, 1);
});

test('read and mutation timeouts have distinct outcomes', async () => {
  dns.lookup = async () => [{ address: '1.1.1.1', family: 4 }];
  let calls = 0;
  https.request = () => { calls++; const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = error => req.emit('error', error); return req; };
  try {
    await assert.rejects(new HttpClient().get('https://api.blockcypher.com/', { timeout: 20 }), /^Error: HTTP read timed out$/);
    await assert.rejects(new HttpClient().post('https://api.blockcypher.com/', {}, { timeout: 20 }), /outcome may be unknown/);
    assert.equal(calls, 2);
  } finally { dns.lookup = originals.lookup; https.request = originals.request; }
});
