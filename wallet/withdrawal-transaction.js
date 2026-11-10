'use strict';
const bitcoin = require('bitcoinjs-lib');
const NETWORK = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

async function build(wallet, address, amount, all, maxFee) {
  const recipient = bitcoin.address.toOutputScript(address, NETWORK);
  const rate = Number(await wallet._feeRate());
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw Error('Invalid network fee estimate');
  const available = await wallet._availableUtxos(false);
  if (!available.length) throw Error('No confirmed funds available');
  const seen = new Set();
  for (const u of available) {
    const id = `${u.txid}:${u.vout}`;
    if (!/^[a-f0-9]{64}$/i.test(u.txid) || !Number.isSafeInteger(u.vout) || u.vout < 0 || u.vout > 0xffffffff || !Number.isSafeInteger(u.value) || u.value <= 0 || seen.has(id) || !u.confirmed) throw Error('Invalid or duplicate confirmed wallet input');
    seen.add(id);
  }
  const chosen = []; let total = 0;
  const outputSize = script => 9 + script.length;
  const estimate = (count, change) => Math.ceil((11 + count * (wallet.type === 'legacy' ? 149 : 69) + outputSize(recipient) + (change ? outputSize(wallet.output) : 0)) * rate);
  for (const u of available) {
    if (chosen.length >= 200) { if (all) throw Error('Send-all exceeds 200 inputs; consolidate in smaller withdrawals'); break; }
    chosen.push(u); total += u.value;
    if (!Number.isSafeInteger(total)) throw Error('Input total exceeds supported precision');
    if (!all && total >= amount + estimate(chosen.length, true)) break;
  }
  let fee = estimate(chosen.length, !all); let change = 0;
  if (all) amount = total - fee;
  else {
    if (total < amount + estimate(chosen.length, false)) throw Error('Insufficient confirmed funds including the network fee');
    change = total - amount - fee;
    const dust = wallet.type === 'legacy' ? 546 : 294;
    if (change < dust) { change = 0; fee = total - amount; }
  }
  if (!Number.isSafeInteger(amount) || amount < 546) throw Error('Amount is below the recipient dust limit');
  if (fee > maxFee) throw Error('Network fee exceeds the configured withdrawal fee cap');
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  for (const u of chosen) await wallet._addInput(psbt, u);
  psbt.addOutput({ address, value: amount });
  if (change) psbt.addOutput({ address: wallet.address, value: change });
  psbt.signAllInputs(wallet.signer); psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  if (fee < Math.ceil(tx.virtualSize() * rate)) throw Error('Signed transaction fee does not cover its actual size');
  return { hex: tx.toHex(), txid: tx.getId(), amount, fee, chosen, change, changeVout: change ? 1 : -1 };
}
module.exports = { build, NETWORK };
