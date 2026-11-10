'use strict';

   
                                                                           
                                                                              
                                                                              
  
                                                                              
                                                               
   

const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { BIP32Factory } = require('bip32');
const { ECPairFactory } = require('ecpair');
const bip39 = require('bip39');

const services = require('../services');

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

                               
const LITECOIN = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const LITOSHI = 1e8;
const DUST = 294;                                   

let priceCache = { value: null, at: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

                                                                                  
                                                                                   
                                                                                    
async function fetchRetry(url, opts = {}, timeoutMs = 7000, tries = 1) {
  if (!['GET', 'HEAD'].includes((opts.method || 'GET').toUpperCase())) tries = 1;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const last = i === tries - 1;
    try {
      const r = await require('../api/http-client').request(url, { ...opts, timeout: timeoutMs });
      if (!last && (r.status === 429 || r.status >= 500)) {
        await sleep(900 * (i + 1));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (last) throw e;
      await sleep(900 * (i + 1));
    }
  }
  throw lastErr || new Error('fetch failed');
}

function fetchJson(url, opts = {}, timeoutMs = 7000) {
  return fetchRetry(url, opts, timeoutMs).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return r.json();
  });
}
function fetchText(url, opts = {}, timeoutMs = 7000) {
  return fetchRetry(url, opts, timeoutMs).then(async (r) => {
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return body;
  });
}

class LtcWallet {
  constructor() {
    this.signer = null;                        
    this.address = '';
    this.output = null;                                
    this.enabled = false;                       

                                                                                        
    this._sendChain = null;                                                     
    this._spent = new Map();                                                                              
    this._pendingChange = [];                                                               
    this._recentTxids = new Map();                                                                      
  }

                                                                                        
  _runQueued(fn) {
    const p = (this._sendChain || Promise.resolve()).then(fn, fn);
    this._sendChain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  _prune() {
    const now = Date.now();
    for (const [k, exp] of this._spent) if (exp <= now) this._spent.delete(k);
    for (const [k, exp] of this._recentTxids) if (exp <= now) this._recentTxids.delete(k);
    this._pendingChange = this._pendingChange.filter((p) => (p._exp || 0) > now);
  }

                                                                                          
  async _availableUtxos(allowUnconf) {
    this._prune();
    const key = (u) => u.txid + ':' + u.vout;
    let utxos = await this._fetchUtxos(this.address);
    for (const pc of this._pendingChange) if (!utxos.some((u) => key(u) === key(pc))) utxos.push({ txid: pc.txid, vout: pc.vout, value: pc.value, confirmed: false });
    const reserved = new Set(services.db?.raw().prepare('SELECT outpoint FROM wallet_utxo_reservations UNION SELECT outpoint FROM payout_utxo_reservations').all().map(row => row.outpoint) || []);
    return utxos.filter((u) => !reserved.has(key(u)) && !this._spent.has(key(u)) && (allowUnconf || u.confirmed)).sort((a, b) => b.value - a.value);
  }

                                                                                                   
  _recordSpend(chosen, txid, change, changeVout) {
    const now = Date.now();
    const key = (u) => u.txid + ':' + u.vout;
    for (const u of chosen) this._spent.set(key(u), now + 15 * 60000);
    this._pendingChange = this._pendingChange.filter((pc) => !chosen.some((u) => key(u) === key(pc)));
    if (change >= DUST && changeVout >= 0) this._pendingChange.push({ txid, vout: changeVout, value: change, _exp: now + 30 * 60000 });
    this._recentTxids.set(txid, now + 15 * 60000);
    this._balCache = null;
  }

                                                                      
  init() {
    const { wallet } = services.config;
    try {
      if (wallet.mnemonic) {
        if (!bip39.validateMnemonic(wallet.mnemonic.trim())) throw new Error('LTC_MNEMONIC is not a valid BIP39 phrase');
        const seed = bip39.mnemonicToSeedSync(wallet.mnemonic.trim());
        const root = bip32.fromSeed(seed, LITECOIN);
        this._hdRoot = root;
        const parts = String(wallet.derivationPath || "m/84'/2'/0'/0/0").split('/');
        this._receiveBase = parts.length >= 5 ? parts.slice(0, -1).join('/') : "m/84'/2'/0'/0";
        this.signer = root.derivePath(wallet.derivationPath);
      } else if (wallet.wif) {
        this.signer = ECPair.fromWIF(wallet.wif.trim(), LITECOIN);
        this._hdRoot = null;
      } else {
        return;                              
      }
      const pubkey = Buffer.from(this.signer.publicKey);
      this.type = wallet.addressType;                       
      const payment =
        this.type === 'legacy'
          ? bitcoin.payments.p2pkh({ pubkey, network: LITECOIN })
          : bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
      this.address = payment.address;
      this.output = payment.output;
      this.inVbytes = this.type === 'legacy' ? 148 : 68;                              
      this.enabled = true;
    } catch (err) {
                                            
      console.error('[wallet] init failed:', err.message);
      this.enabled = false;
    }
  }

                                                                           
  supportsHdReceive() {
    return Boolean(this._hdRoot && this._receiveBase);
  }

                                                                     
  deriveReceiveAddress(index) {
    if (!this.supportsHdReceive()) return null;
    const i = Math.max(0, Math.floor(Number(index) || 0));
    const node = this._hdRoot.derivePath(`${this._receiveBase}/${i}`);
    const pubkey = Buffer.from(node.publicKey);
    const payment =
      this.type === 'legacy'
        ? bitcoin.payments.p2pkh({ pubkey, network: LITECOIN })
        : bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
    return { address: payment.address, index: i, output: payment.output };
  }

                                                                              

  getRate() {
    if (this._ratePending) return this._ratePending;
    this._ratePending = this._readRate().finally(() => { this._ratePending = null; });
    return this._ratePending;
  }

  async _readRate() {
    const { wallet } = services.config;
    const now = Date.now();
    if (priceCache.value && now - priceCache.at < wallet.priceCacheMs) return priceCache.value;
    
    let usd = null;
    try {
      const data = await fetchJson(wallet.priceApiUrl);
      usd = data && data.litecoin && Number(data.litecoin.usd);
    } catch (err) {
                 
      try {
        const fb = await fetchJson('https://api.coinbase.com/v2/prices/LTC-USD/spot');
        usd = fb && fb.data && Number(fb.data.amount);
      } catch (err2) {
        throw new Error('Both primary and fallback price feeds failed');
      }
    }
    
    if (!(usd > 0)) throw new Error('Could not read LTC/USD price');

                                                           
    if (priceCache.value) {
       const change = Math.abs((usd - priceCache.value) / priceCache.value);
       if (change > 0.2) {
          throw new Error('Price feed sanity check failed: abnormal price jump (>20%)');
       }
    }

    priceCache = { value: usd, at: now };
    return usd;
  }

  cachedRate() {
    return priceCache.value;
  }

  async usdToLitoshi(usd) {
    const rate = await this.getRate();
    const staleMs = 15 * 60 * 1000;
    if (Date.now() - priceCache.at > staleMs) {
      throw new Error('Price feed is too stale');
    }
    return Math.max(1, Math.round((usd / rate) * LITOSHI));
  }

                                                                              
                                                                                 
                                                                              
                                                                           

  _provider() {
    return services.config.wallet.provider;
  }

                                                                            
  _providerOrder() {
    return this._provider() === 'esplora' ? ['esplora', 'blockcypher'] : ['blockcypher', 'esplora'];
  }

                                                                       
  async _tryProviders(ops) {
    let lastErr;
    for (const prov of this._providerOrder()) {
      const fn = ops[prov];
      if (!fn) continue;
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
                                              
        console.warn(`[wallet] ${prov} call failed, trying fallback: ${err.message}`);
      }
    }
    throw lastErr || new Error('all on-chain providers failed');
  }

                                                                    
  _bcy(path) {
    const { blockcypherBase, blockcypherToken } = services.config.wallet;
    const url = new URL(String(blockcypherBase).replace(/\/$/, '') + path);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid BlockCypher HTTPS base URL');
    if (blockcypherToken) url.searchParams.set('token', blockcypherToken);
    return url.href;
  }

                                                                    
  _fetchBalanceLitoshi(addr) {
    const base = services.config.wallet.apiBase;
    return this._tryProviders({
      blockcypher: async () => {
        const x = await fetchJson(this._bcy(`/addrs/${addr}/balance`));
        if (!Number.isSafeInteger(x.final_balance) || x.final_balance < 0) throw Error('Invalid BlockCypher balance response');
        return x.final_balance;
      },
      esplora: async () => {
        const a = await fetchJson(`${base}/address/${addr}`);
        const c = a.chain_stats;
        const m = a.mempool_stats;
        if (![c?.funded_txo_sum, c?.spent_txo_sum, m?.funded_txo_sum, m?.spent_txo_sum].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('Invalid Esplora balance response');
        return (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
      },
    });
  }

                                                               
  _fetchUtxos(addr) {
    const base = services.config.wallet.apiBase;
    return this._tryProviders({
      blockcypher: async () => {
        const x = await fetchJson(this._bcy(`/addrs/${addr}?unspentOnly=true&limit=2000`));
        const conf = (x.txrefs || []).map((t) => ({ txid: t.tx_hash, vout: t.tx_output_n, value: t.value, confirmed: true }));
        const unconf = (x.unconfirmed_txrefs || []).map((t) => ({ txid: t.tx_hash, vout: t.tx_output_n, value: t.value, confirmed: false }));
        return [...conf, ...unconf];
      },
      esplora: async () => {
        const u = await fetchJson(`${base}/address/${addr}/utxo`);
        return u.map((o) => ({ txid: o.txid, vout: o.vout, value: o.value, confirmed: Boolean(o.status && o.status.confirmed) }));
      },
    });
  }

                                                             
  _fetchTxHex(txid) {
    const base = services.config.wallet.apiBase;
    return this._tryProviders({
      blockcypher: async () => {
        const x = await fetchJson(this._bcy(`/txs/${txid}?includeHex=true&limit=1`));
        if (!x.hex) throw new Error(`no hex for tx ${txid}`);
        return x.hex;
      },
      esplora: async () => fetchText(`${base}/tx/${txid}/hex`),
    });
  }

                                                                              
  async _feeRate() {
    const base = services.config.wallet.apiBase;
    try {
      return await this._tryProviders({
        blockcypher: async () => {
          const x = await fetchJson(this._bcy(''));
          const perKb = Number(x.medium_fee_per_kb || x.high_fee_per_kb);
          if (perKb > 0) return Math.max(1, Math.ceil(perKb / 1000));
          throw new Error('no fee estimate');
        },
        esplora: async () => {
          const est = await fetchJson(`${base}/fee-estimates`);
          const r = est['2'] || est['3'] || est['1'];
          if (r && r > 0) return Math.max(1, Math.ceil(r));
          throw new Error('no fee estimate');
        },
      });
    } catch {
      return services.config.wallet.feeSatPerVb;
    }
  }

                                                     
  _broadcast(hex) {
    const base = services.config.wallet.apiBase;
    return this._tryProviders({
      blockcypher: async () => {
        const x = await fetchJson(this._bcy('/txs/push'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx: hex }) });
        const txid = x && x.tx && x.tx.hash;
        if (!txid) throw new Error('broadcast failed (no txid returned)');
        return txid;
      },
      esplora: async () => (await fetchText(`${base}/tx`, { method: 'POST', body: hex })).trim(),
    });
  }

                                                                              

                                                                                  
                                                                                    
  async getBalanceLitoshi() {
    if (!this.enabled) return 0;
    const now = Date.now();
    if (this._balCache && now - this._balCache.at < 90000) return this._balCache.value;
    if (this._balancePending) return this._balancePending;
    if (this._balanceRetryAt > now) throw new Error('Wallet balance unavailable; provider retry is cooling down');
    const address = this.address;
    this._balancePending = (async () => {
      try {
        const v = await this._fetchBalanceLitoshi(address);
        if (!Number.isSafeInteger(v) || v < 0) throw new Error('Invalid wallet balance from provider');
        if (this.address !== address) throw new Error('Wallet changed during balance request');
        this._balCache = { value: v, at: Date.now() };
        this._balanceRetryAt = 0;
        return v;
      } catch (error) {
        this._balanceRetryAt = Date.now() + 30000;
        throw error;
      } finally { this._balancePending = null; }
    })();
    return this._balancePending;
  }

  async getBalanceLtc() {
    return (await this.getBalanceLitoshi()) / LITOSHI;
  }

  async getReadStatus() {
    const [balance, rate] = await Promise.allSettled([this.getBalanceLitoshi(), this.getRate()]);
    const litoshi = balance.status === 'fulfilled' ? balance.value : null;
    const price = rate.status === 'fulfilled' ? rate.value : this.cachedRate();
    return {
      balanceLtc: litoshi === null ? null : litoshi / LITOSHI,
      balanceUsd: litoshi === null || price === null ? null : (litoshi / LITOSHI) * price,
      ltcPrice: price,
      balanceStatus: balance.status === 'fulfilled' ? 'available' : 'unavailable',
      priceStatus: rate.status === 'fulfilled' ? 'available' : price ? 'stale' : 'unavailable',
      balanceUpdatedAt: this._balCache?.at || null,
    };
  }

                                                                                
                                                                           
  invalidateBalanceCache() {
    this._balCache = null;
  }

     
                                                                                 
                                                     
     
  fetchIncomingDeposits(limit = 40, addr = null) {
    if (!this.enabled) return Promise.resolve([]);
    const address = addr || this.address;
    const base = services.config.wallet.apiBase;
    return this._tryProviders({
      blockcypher: async () => {
        const x = await fetchJson(this._bcy(`/addrs/${address}?limit=${limit}`));
        const out = [];
        for (const t of x.txrefs || []) {
          out.push({ txid: t.tx_hash, vout: t.tx_output_n, litoshi: t.value, confirmed: true, address });
        }
        for (const t of x.unconfirmed_txrefs || []) {
          out.push({ txid: t.tx_hash, vout: t.tx_output_n, litoshi: t.value, confirmed: false, address });
        }
        return out;
      },
      esplora: async () => {
        const txs = await fetchJson(`${base}/address/${address}/txs`);
        const out = [];
        for (const tx of (txs || []).slice(0, limit)) {
          const confirmed = Boolean(tx.status && tx.status.confirmed);
          (tx.vout || []).forEach((v, i) => {
            if (v.scriptpubkey_address === address && v.value > 0) {
              out.push({ txid: tx.txid, vout: i, litoshi: v.value, confirmed, address });
            }
          });
        }
        return out;
      },
    });
  }

                                                                              

  isValidAddress(addr) {
    try {
      bitcoin.address.toOutputScript(String(addr).trim(), LITECOIN);
      return true;
    } catch {
      return false;
    }
  }

                                                                                      
  async _addInput(psbt, u) {
    if (this.type === 'legacy') {
      const hex = await this._fetchTxHex(u.txid);
      psbt.addInput({ hash: u.txid, index: u.vout, nonWitnessUtxo: Buffer.from(hex, 'hex') });
    } else {
      psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: this.output, value: u.value } });
    }
  }

     
                                                                    
                                                                    
                                         
     
  send(toAddress, litoshi, authorization = {}) {
                                                                               
                                                                               
    return this._runQueued(() => this._sendNow(toAddress, litoshi, authorization));
  }

  async _sendNow(toAddress, litoshi, authorization = {}) {
    if (services.db?.raw().prepare("SELECT 1 FROM payout_intents WHERE id!=? AND state!='BROADCAST'").get(authorization.intentId || '')) throw Error('An earlier payout has an unresolved broadcast outcome');
    if (services.db?.raw().prepare("SELECT 1 FROM wallet_withdrawals WHERE state!='BROADCAST'").get()) throw Error('A manual withdrawal needs reconciliation before a sale payout');
    const intent = services.db?.raw().prepare('SELECT * FROM payout_intents WHERE id=?').get(authorization.intentId || '');
    if (!intent || intent.state !== 'BROADCAST_INTENT' || intent.address !== toAddress || intent.litoshi !== String(litoshi)) throw new Error('Matching persisted payout intent required');
    await services.rollout.authorize('payout');
    if (!this.enabled) throw new Error('Wallet not configured (no LTC_MNEMONIC / LTC_WIF)');
    const to = String(toAddress).trim();
    if (!this.isValidAddress(to)) throw new Error(`Invalid LTC address: ${to}`);
    litoshi = Math.round(litoshi);
    if (litoshi < DUST) throw new Error('Payout amount is below the dust limit');

           
    const rate = await this.getRate();
    const usdEquivalent = litoshi / LITOSHI * rate;
    const maxPerTxUsd = services.settings ? await services.settings.get('wallet.maxPerTxUsd') : 0;
    const maxPerDayUsd = services.settings ? await services.settings.get('wallet.maxPerDayUsd') : 0;
    if (maxPerTxUsd > 0 && usdEquivalent > maxPerTxUsd) {
       throw new Error(`Exceeds max per-tx cap of $${maxPerTxUsd}`);
    }

    if (services.ledger) {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0,0,0,0);
      const recent = services.ledger.query({ entryType: 'payout', currency: 'ltc', since: startOfDay.toISOString() });
      const dailyLitoshi = recent.reduce((sum, r) => sum + r.amount, 0);
      if (maxPerDayUsd > 0 && ((dailyLitoshi + litoshi) / LITOSHI) * rate > maxPerDayUsd) {
         throw new Error(`Exceeds max per-day cap of $${maxPerDayUsd}`);
      }
    }

    const allowUnconf = services.config.wallet.spendUnconfirmed;
    const utxos = await this._availableUtxos(allowUnconf);
    if (!utxos.length) throw new Error(allowUnconf ? 'No funds available' : 'No confirmed funds available (deposit still pending — try again in a couple minutes)');

    const feeRate = await this._feeRate();
    const recipientScriptLen = bitcoin.address.toOutputScript(to, LITECOIN).length;

                                                                                   
    const chosen = [];
    let inValue = 0;
    const estFee = (nIn, nOut) => Math.ceil((10.5 + nIn * this.inVbytes + nOut * (8 + 1 + recipientScriptLen)) * feeRate);
    for (const u of utxos) {
      chosen.push(u);
      inValue += u.value;
      const feeWithChange = estFee(chosen.length, 2);
      if (inValue >= litoshi + feeWithChange) break;
    }
    let fee = estFee(chosen.length, 2);
    if (inValue < litoshi + estFee(chosen.length, 1)) {
      throw new Error(`Insufficient confirmed balance (have ${inValue / LITOSHI} LTC, need ~${(litoshi + fee) / LITOSHI} LTC)`);
    }

    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    for (const u of chosen) await this._addInput(psbt, u);
    psbt.addOutput({ address: to, value: litoshi });
    let change = inValue - litoshi - fee;
    if (change < 0) {
                                                                               
      fee = estFee(chosen.length, 1);
      change = 0;
      if (inValue - litoshi < fee) throw new Error('Insufficient funds to cover the network fee');
                                                                                
                                                                               
    }
    let changeVout = -1;
    if (change >= DUST) {
      psbt.addOutput({ address: this.address, value: change });
      changeVout = 1;                                             
    }

    psbt.signAllInputs(this.signer);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const hex = tx.toHex();
    const txid = tx.getId();

                                                                            
    const sendEnabled = services.store && typeof services.store.sendEnabled === 'function' ? services.store.sendEnabled() : services.config.wallet.sendEnabled;
    if (!sendEnabled) throw new Error('LTC payouts are disabled. Enable Send LTC in Controls & Console; no transaction was broadcast.');
                                                                                                      
    if (this._recentTxids.has(txid)) throw new Error('Duplicate payout blocked (identical to a very recent transaction). It will retry with fresh coins.');
                                                                                
                                                                          
    const db = services.db.raw();
    db.exec('BEGIN IMMEDIATE');
    try {
      const saved = db.prepare("UPDATE payout_intents SET signed_hex=?,txid=?,fee_litoshi=? WHERE id=? AND state='BROADCAST_INTENT' AND signed_hex IS NULL").run(hex,txid,fee,authorization.intentId);
      if (saved.changes !== 1) throw Error('Payout transaction already prepared; reconcile its saved transaction before retrying');
      for (const u of chosen) db.prepare('INSERT INTO payout_utxo_reservations(outpoint,payout_id) VALUES(?,?)').run(`${u.txid}:${u.vout}`,authorization.intentId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const broadcastTxid = await this._broadcast(hex);
    if (broadcastTxid !== txid) throw Error('Provider returned an unexpected payout transaction ID');
    this._recordSpend(chosen, txid, change, changeVout);
    return { txid: broadcastTxid, litoshi, fee, to };
  }

                                                                   
  depositUri() {
    return this.address ? `litecoin:${this.address}` : '';
  }

     
                                                                                 
                                                                      
     
  sendMax(toAddress) {
    return this._runQueued(() => this._sendMaxNow(toAddress));
  }

  async _sendMaxNow() {
    throw new Error('Unbounded wallet sends disabled; use a capped persisted payout');
  }

}

module.exports = { LtcWallet, LITOSHI };
