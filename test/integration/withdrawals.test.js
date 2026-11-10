'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const Database = require('../../db/database');
const Ledger = require('../../ledger/ledger');
const services = require('../../services');
const { LtcWallet } = require('../../wallet/ltc-wallet');
const { NETWORK } = require('../../wallet/withdrawal-transaction');
const { WithdrawalService, exactLitoshi } = require('../../payments/withdrawal-service');

async function fixture(t) {
  const db = await Database.open(':memory:'); services.db = db;
  t.after(() => db.close());
  const wallet = new LtcWallet(); wallet.signer = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 1), { network: NETWORK });
  const own = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(wallet.signer.publicKey), network: NETWORK });
  wallet.enabled = true; wallet.address = own.address; wallet.output = own.output; wallet.type = 'segwit';
  wallet._fetchUtxos = async () => [{ txid: 'a'.repeat(64), vout: 0, value: 1000000, confirmed: true }];
  wallet._feeRate = async () => 2;
  const destination = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 2)).publicKey), network: NETWORK }).address;
  const limits = { 'wallet.withdrawal.maxLtc': 1, 'wallet.withdrawal.dailyLtc': 2, 'wallet.withdrawal.maxFeeLtc': 0.001, 'wallet.maxPerTxUsd': 0, 'wallet.maxPerDayUsd': 0 };
  let enabled = true; let calls = 0; const hexes = [];
  wallet._broadcast = async hex => { calls++; hexes.push(hex); return bitcoin.Transaction.fromHex(hex).getId(); };
  const ctx = { db, wallet, config: { wallet: {} }, ledger: new Ledger(db.raw()), store: { sendEnabled: () => enabled }, settings: { get: async key => limits[key], store: { auditLog: { log() {} } } } };
  return { db, wallet, destination, limits, ctx, service: new WithdrawalService(ctx), calls: () => calls, hexes, disable: () => { enabled = false; }, input: { toAddress: destination, amountLtc: '0.001', requestId: crypto.randomUUID() } };
}

test('exact LTC parsing preserves eight decimal places and rejects rounding', () => {
  assert.equal(exactLitoshi('0.00000001'), 1); assert.equal(exactLitoshi(0.00000001), 1); assert.equal(exactLitoshi('1.12345678'), 112345678);
  for (const input of ['0.000000001', 0.000000001, '-1', '1e-8', 'NaN', Infinity, '0', '99999999999999999999']) assert.throws(() => exactLitoshi(input));
});

test('owner withdrawal signs exact recipient output and records both amount and fee', async t => {
  const f = await fixture(t); const result = await f.service.send(f.input);
  const tx = bitcoin.Transaction.fromHex(f.hexes[0]);
  assert.equal(tx.outs[0].value, 100000); assert.equal(tx.outs[0].script.toString('hex'), bitcoin.address.toOutputScript(f.destination, NETWORK).toString('hex'));
  assert.equal(f.db.raw().prepare('SELECT state FROM wallet_withdrawals').get().state, 'BROADCAST');
  assert.equal(f.db.raw().prepare('SELECT count(*) n FROM wallet_utxo_reservations').get().n, 1);
  assert.equal(f.ctx.ledger.query({ entryType: 'payout' })[0].amount, 100000);
  assert.equal(f.ctx.ledger.query({ entryType: 'fee' })[0].amount, result.fee);
  assert.equal((await f.wallet._availableUtxos(false)).length, 0);
});

test('duplicate clicks and completed retries return one persisted receipt', async t => {
  const f = await fixture(t); const results = await Promise.all([f.service.send(f.input), f.service.send(f.input)]);
  assert.equal(results[0].txid, results[1].txid); assert.equal(f.calls(), 1);
  await assert.rejects(f.service.send({ ...f.input, amountLtc: '0.002' }), /different recipient or amount/);
});

test('uncertain network result keeps inputs reserved across service restart and retries identical bytes', async t => {
  const f = await fixture(t); let firstHex; let calls = 0;
  f.wallet._broadcast = async hex => { calls++; if (!firstHex) { firstHex = hex; throw Error('HTTP timeout'); } assert.equal(hex, firstHex); return bitcoin.Transaction.fromHex(hex).getId(); };
  await assert.rejects(f.service.send(f.input), /reconciliation/);
  assert.equal(f.db.raw().prepare('SELECT state FROM wallet_withdrawals').get().state, 'NEEDS_OPERATOR');
  await assert.rejects(f.service.send({ ...f.input, requestId: crypto.randomUUID() }), /earlier withdrawal/);
  f.wallet._fetchTxHex = async () => { throw Error('Not indexed'); };
  const result = await new WithdrawalService(f.ctx).send(f.input);
  assert.equal(result.pending, false); assert.equal(calls, 2);
});

test('retry recognizes an accepted transaction without broadcasting again', async t => {
  const f = await fixture(t); let hex;
  f.wallet._broadcast = async data => { hex = data; throw Error('connection closed after submission'); };
  await assert.rejects(f.service.send(f.input));
  f.wallet._fetchTxHex = async () => hex; let repeated = false;
  f.wallet._broadcast = async () => { repeated = true; throw Error('must not resend'); };
  assert.equal((await f.service.send(f.input)).txid, bitcoin.Transaction.fromHex(hex).getId()); assert.equal(repeated, false);
});

test('disabled sending, transaction caps, fee caps and daily caps prevent broadcast', async t => {
  for (const variant of ['disabled', 'transaction', 'fee', 'day']) {
    const f = await fixture(t);
    if (variant === 'disabled') f.disable();
    if (variant === 'transaction') f.limits['wallet.withdrawal.maxLtc'] = 0.0001;
    if (variant === 'fee') f.limits['wallet.withdrawal.maxFeeLtc'] = 0.00000001;
    if (variant === 'day') f.limits['wallet.withdrawal.dailyLtc'] = 0.0001;
    await assert.rejects(f.service.send(f.input)); assert.equal(f.calls(), 0);
    assert.equal(f.db.raw().prepare('SELECT count(*) n FROM wallet_withdrawals').get().n, 0);
  }
});

test('unexpected provider txid is retained for reconciliation, never reported successful', async t => {
  const f = await fixture(t); f.wallet._broadcast = async () => 'b'.repeat(64);
  await assert.rejects(f.service.send(f.input), /unexpected withdrawal transaction ID/);
  assert.equal(f.db.raw().prepare('SELECT state FROM wallet_withdrawals').get().state, 'NEEDS_OPERATOR');
});

test('send-all covers confirmed inputs minus fees without a change output', async t => {
  const f = await fixture(t); const result = await f.service.send({ ...f.input, all: true });
  const tx = bitcoin.Transaction.fromHex(f.hexes[0]); assert.equal(tx.outs.length, 1); assert.equal(result.litoshi + result.fee, 1000000);
});
