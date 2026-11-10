'use strict';

const fs = require('fs');
const path = require('path');
const services = require('../services');
const Database = require('../db/database');
const SellersRepository = require('../db/repositories/sellers');
const OrdersRepository = require('../db/repositories/orders');
const SalesRepository = require('../db/repositories/sales');
const PairsRepository = require('../db/repositories/pairs');

class SellStore {
  constructor() {
    this.settings = {};
    this.activity = [];                                                
    this._file = null;
    this.db = null;
    this.sellersRepo = null;
    this.ordersRepo = null;
    this.salesRepo = null;
    this.pairsRepo = null;
  }

  load() {
    this._file = services.config.sellersFile;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      this.settings = parsed.settings || {};
      this.activity = Array.isArray(parsed.activity) ? parsed.activity : [];
    } catch {
                       
    }
    
                                               
    const dbPath = path.join(path.dirname(this._file), 'autosell.db');
    if (!fs.existsSync(path.dirname(dbPath))) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    
    this.db = new Database(dbPath);
                                                                     
                                                                 
    const migrationsDir = path.join(__dirname, '../db/migrations');
    if (fs.existsSync(migrationsDir)) {
      this.db.raw().exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      for (const file of files) {
        const versionMatch = file.match(/^(\d+)-/);
        if (!versionMatch) continue;
        const version = parseInt(versionMatch[1], 10);
        const isApplied = this.db.raw().prepare('SELECT version FROM schema_version WHERE version = ?').get(version);
        if (!isApplied) {
          this.db.raw().exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
          this.db.raw().prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
        }
      }
    }

    this.sellersRepo = new SellersRepository(this.db.raw());
    this.ordersRepo = new OrdersRepository(this.db.raw());
    this.salesRepo = new SalesRepository(this.db.raw());
    this.pairsRepo = new PairsRepository(this.db.raw());
    services.pairsRepo = this.pairsRepo;

    if (services.config) this._seedFromEnv();
  }

  _seedFromEnv() {
                                            
    const { mc, sweep, setup } = services.config;
    if (!Array.isArray(this.settings.buyerAccounts)) this.settings.buyerAccounts = [{}, {}];
    const a0 = this.settings.buyerAccounts[0] || (this.settings.buyerAccounts[0] = {});
    const a1 = this.settings.buyerAccounts[1] || (this.settings.buyerAccounts[1] = {});
    let dirty = false;
    const seedAcc = (acc, email, ign) => {
      if (!String(acc.email || '').trim() && email) {
        acc.email = email;
        dirty = true;
      }
      if (!String(acc.ign || '').trim() && ign) {
        acc.ign = ign;
        dirty = true;
      }
    };
    seedAcc(a0, mc.email, mc.ign);
    seedAcc(a1, mc.verifyEmail, mc.verifyIgn);

    if (!this._rawSweepOwner() && (sweep.ownerName || sweep.igns.length)) {
      this.settings.sweepConfig = {
        owners: [{ name: sweep.ownerName || 'Owner', igns: [...sweep.igns] }],
      };
      dirty = true;
    }

    const envSetup = [
      ['buyMoneyEnabled', setup.buyMoneyEnabled],
      ['buySkellyEnabled', setup.buySkellyEnabled],
      ['trustedSystemEnabled', setup.trustedSystemEnabled],
      ['singleAccountIndex', setup.singleAccountIndex],
      ['trustThresholdSales', setup.trustThresholdSales],
      ['verifyEnabled', setup.verifyEnabled],
      ['autosellPaused', setup.autosellPaused],
      ['minMoneyDonut', setup.minMoneyDonut],
      ['minSkellyCount', setup.minSkellyCount],
      ['lowBalanceUsd', setup.lowBalanceUsd],
      ['restockUsd', setup.restockUsd],
      ['channelRateOverridePerB', setup.channelRateOverridePerB],
      ['pricePerSpawnerUsd', setup.pricePerSpawnerUsd],
      ['ratePerMillion', setup.ratePerMillion],
    ];
    for (const [key, val] of envSetup) {
      if (val !== undefined && this.settings[key] === undefined) {
        this.settings[key] = val;
        dirty = true;
      }
    }

    if (dirty) this._save();
  }

  _envSetup(key) {
    const s = services.config.setup;
    return s && s[key] !== undefined ? s[key] : undefined;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify({ settings: this.settings, activity: this.activity }, null, 2));
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }

                            
  getSeller(discordId) {
    const s = this.sellersRepo.getSeller(discordId);
    if (!s) return null;
    return { ...s, pending: s.stats && s.stats.pending ? s.stats.pending : { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 } };
  }

  getSellerByIgn(ign) {
    const s = this.sellersRepo.getSellerByIgn(ign);
    if (!s) return null;
    return { ...s, pending: s.stats && s.stats.pending ? s.stats.pending : { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 } };
  }

  whoisIgn(ign) {
    const s = this.sellersRepo.whoisIgn(ign);
    if (!s) return null;
    return { ...s, pending: s.stats && s.stats.pending ? s.stats.pending : { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 } };
  }

  setSeller(discordId, data) {
    return this.sellersRepo.setSeller(discordId, data);
  }

  isVerified(discordId, ign) {
    const s = this.sellersRepo.getSeller(discordId);
    return Boolean(s && s.verifiedIgn && s.verifiedIgn.toLowerCase() === String(ign || '').toLowerCase());
  }

  setVerified(discordId, ign) {
    this.sellersRepo.setVerified(discordId, ign);
  }

  unlink(discordId) {
    return this.sellersRepo.unlink(discordId);
  }

  clearSeller(discordId) {
    return this.sellersRepo.clearSeller(discordId);
  }

  addBalanceUsd(discordId, usd) {
    return this.sellersRepo.addBalanceUsd(discordId, usd);
  }

  getBalanceUsd(discordId) {
    return this.sellersRepo.getBalanceUsd(discordId);
  }

  zeroBalance(discordId) {
    this.sellersRepo.zeroBalance(discordId);
  }

  recordSale(discordId, { kind, donut = 0, count = 0, usd = 0 }) {
    const s = this.sellersRepo.getSeller(discordId) || this.sellersRepo.setSeller(discordId, { ign: '', ltcAddress: '' });
    const stats = s.stats || { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0, sales: 0, cashedOutUsd: 0, pending: { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 } };
    
    if (!stats.pending) stats.pending = { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 };
    
    const u = Number(usd) || 0;
    if (kind === 'money') {
      const d = Number(donut) || 0;
      stats.moneyDonut += d;
      stats.moneyUsd = +(stats.moneyUsd + u).toFixed(6);
      stats.pending.moneyDonut += d;
      stats.pending.moneyUsd = +(stats.pending.moneyUsd + u).toFixed(6);
    } else {
      const c = Number(count) || 0;
      stats.skellyCount += c;
      stats.skellyUsd = +(stats.skellyUsd + u).toFixed(6);
      stats.pending.skellyCount += c;
      stats.pending.skellyUsd = +(stats.pending.skellyUsd + u).toFixed(6);
    }
    stats.sales += 1;
    
    this.sellersRepo.updateStats(discordId, stats);
    
    this.salesRepo.create({
      id: require('crypto').randomUUID(),
      discordId,
      kind,
      state: 'DONE',
      donutAmount: Number(donut) || 0,
      skellyCount: Number(count) || 0,
      usdAmount: u,
      ign: s.ign,
      createdAt: new Date().toISOString()
    });
    
    if (this.settings.channelRateOverridePerB !== undefined) {
      delete this.settings.channelRateOverridePerB;
      this._save();
    }
    
    return stats;
  }

  getSales({ limit = 500, sinceTs = 0 } = {}) {
    let since = null;
    if (sinceTs > 0) since = new Date(sinceTs).toISOString();
    return this.salesRepo.list({ limit, since }).map(s => ({
      ts: new Date(s.createdAt).getTime(),
      discordId: s.discordId,
      kind: s.kind,
      donut: s.donutAmount,
      count: s.skellyCount,
      usd: s.usdAmount,
      ign: s.ign
    }));
  }

  logActivity(rec) {
    const record = { ts: Date.now(), ...rec };
    this.activity.push(record);
    if (this.activity.length > 2000) this.activity = this.activity.slice(-2000);
    this._save();
    return record;
  }
  
  saveActivity() {
    this._save();
  }
  
  getActivity(limit = 300) {
    return this.activity.slice(-limit).reverse();
  }

  getPending(discordId) {
    const s = this.sellersRepo.getSeller(discordId);
    return (s && s.stats && s.stats.pending) ? { ...s.stats.pending } : { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 };
  }
  
  resetPending(discordId) {
    const s = this.sellersRepo.getSeller(discordId);
    if (s && s.stats) {
      s.stats.pending = { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 };
      this.sellersRepo.updateStats(discordId, s.stats);
    }
  }

  recordCashout(discordId, usd) {
    const s = this.sellersRepo.getSeller(discordId);
    if (s && s.stats) {
      s.stats.cashedOutUsd = +((s.stats.cashedOutUsd || 0) + (Number(usd) || 0)).toFixed(6);
      this.sellersRepo.updateStats(discordId, s.stats);
    }
  }

  setAnon(discordId, anon) {
    this.sellersRepo.setAnon(discordId, anon);
  }
  
  isAnon(discordId) {
    const s = this.sellersRepo.getSeller(discordId);
    return Boolean(s && s.anon);
  }

  getStats(discordId) {
    const s = this.sellersRepo.getSeller(discordId);
    if (!s || !s.stats) return null;
    const st = s.stats;
    const volumeUsd = +((st.moneyUsd || 0) + (st.skellyUsd || 0)).toFixed(6);
    return {
      moneyDonut: st.moneyDonut || 0,
      moneyUsd: st.moneyUsd || 0,
      skellyCount: st.skellyCount || 0,
      skellyUsd: st.skellyUsd || 0,
      sales: st.sales || 0,
      cashedOutUsd: st.cashedOutUsd || 0,
      volumeUsd,
      balanceUsd: Number(s.balanceUsd || 0),
      anon: Boolean(s.anon),
    };
  }

  serverStats() {
    let volumeUsd = 0;
    let sales = 0;
    let moneyDonut = 0;
    let moneyUsd = 0;
    let skellyCount = 0;
    let skellyUsd = 0;
    let sellersCount = 0;
    const sellers = this.sellersRepo ? this.sellersRepo.getAllSellers() : [];
    
    for (const s of sellers) {
      const st = s.stats || {};
      const v = (st.moneyUsd || 0) + (st.skellyUsd || 0);
      if ((st.sales || 0) > 0 || v > 0) sellersCount++;
      volumeUsd += v;
      sales += st.sales || 0;
      moneyDonut += st.moneyDonut || 0;
      moneyUsd += st.moneyUsd || 0;
      skellyCount += st.skellyCount || 0;
      skellyUsd += st.skellyUsd || 0;
    }

    let eldoradoDeliveredCount = 0;
    let eldoradoVolumeUsd = 0;
    let eldoradoCoinsDelivered = 0;
    if (this.db) {
      try {
        const row = this.db.raw().prepare(
          "SELECT count(*) as c, coalesce(sum(price), 0) as p, coalesce(sum(amount), 0) as a FROM marketplace_orders WHERE state = 'delivered'"
        ).get();
        if (row) {
          eldoradoDeliveredCount = Number(row.c) || 0;
          eldoradoVolumeUsd = Number(row.p) || 0;
          eldoradoCoinsDelivered = Number(row.a) || 0;
        }
      } catch {}
    }

    const totalVolumeUsd = +(volumeUsd + eldoradoVolumeUsd).toFixed(2);
    const totalDeals = sales + eldoradoDeliveredCount;
    const avgDealUsd = totalDeals > 0 ? +(totalVolumeUsd / totalDeals).toFixed(2) : 0;
    
    return {
      volumeUsd: totalVolumeUsd,
      totalVolumeUsd,
      totalDealtUsd: totalVolumeUsd,
      sales: totalDeals,
      totalDeals,
      avgUsd: avgDealUsd,
      averageDealUsd: avgDealUsd,
      moneyDonut: moneyDonut + eldoradoCoinsDelivered,
      moneyUsd: +(moneyUsd + eldoradoVolumeUsd).toFixed(2),
      skellyCount,
      skellyUsd: +skellyUsd.toFixed(2),
      sellers: sellersCount,
      eldoradoOrdersDelivered: eldoradoDeliveredCount,
      eldoradoVolumeUsd: +eldoradoVolumeUsd.toFixed(2),
      sellerSalesCount: sales,
      sellerVolumeUsd: +volumeUsd.toFixed(2)
    };
  }

  _ranked() {
    return this.sellersRepo.getAllSellers()
      .map(s => {
        const st = s.stats || {};
        return {
          discordId: s.discordId,
          ign: s.ign || '',
          anon: Boolean(s.anon),
          volumeUsd: +(((st.moneyUsd || 0) + (st.skellyUsd || 0))).toFixed(6),
          moneyDonut: st.moneyDonut || 0,
          skellyCount: st.skellyCount || 0,
          sales: st.sales || 0,
        };
      })
      .filter((e) => e.volumeUsd > 0)
      .sort((a, b) => b.volumeUsd - a.volumeUsd);
  }

  leaderboard(limit = 10) {
    return this._ranked().slice(0, limit);
  }

  rankOf(discordId) {
    const ranked = this._ranked();
    const idx = ranked.findIndex((e) => e.discordId === discordId);
    return { rank: idx === -1 ? null : idx + 1, total: ranked.length };
  }

                              
  getPrice() {
    const configured = Number(services.settings?.store?.get?.('pricing.spawner.priceUsd'));
    if (configured > 0) return configured;
    const v = Number(this.settings.pricePerSpawnerUsd);
    if (v > 0) return v;
    return services.config.buy.pricePerSpawnerUsd;
  }
  setPrice(usd) {
    if (!Number.isFinite(Number(usd)) || Number(usd) <= 0) throw Error('Spawner price must be a positive number');
    services.settings?.store?.set?.('pricing.spawner.priceUsd', Number(usd), 'pricing');
    this.settings.pricePerSpawnerUsd = Number(usd);
    this._save();
  }

  getRate() {
    const configured = Number(services.settings?.store?.get?.('pricing.money.ratePerMillion'));
    if (configured > 0) return configured;
    const v = Number(this.settings.ratePerMillion);
    if (v > 0) return v;
    return services.config.economy.ratePerMillion;
  }
  setRate(usd) {
    if (!Number.isFinite(Number(usd)) || Number(usd) <= 0) throw Error('Money rate must be a positive number');
    services.settings?.store?.set?.('pricing.money.ratePerMillion', Number(usd), 'pricing');
    this.settings.ratePerMillion = Number(usd);
    this._save();
  }
  getSetting(key, fallback) {
    const v = this.settings[key];
    return v === undefined ? fallback : v;
  }
  setSetting(key, value) {
    this.settings[key] = value;
    this._save();
  }

  sendEnabled() {
    const v = this.settings.ltcSendEnabled;
    return v === undefined ? services.config.wallet.sendEnabled : Boolean(v);
  }

  buyMoneyEnabled() {
    const configured = services.settings?.store?.get?.('pricing.money.enabled');
    if (configured !== undefined) return Boolean(configured);
    const v = this.settings.buyMoneyEnabled;
    if (v !== undefined) return Boolean(v);
    const env = this._envSetup('buyMoneyEnabled');
    if (env !== undefined) return Boolean(env);
    return true;
  }
  setBuyMoneyEnabled(on) {
    services.settings?.store?.set?.('pricing.money.enabled', Boolean(on), 'pricing');
    this.settings.buyMoneyEnabled = Boolean(on);
    this._save();
  }

  buySkellyEnabled() {
    const configured = services.settings?.store?.get?.('pricing.spawner.enabled');
    if (configured !== undefined) return Boolean(configured);
    const v = this.settings.buySkellyEnabled;
    if (v !== undefined) return Boolean(v);
    const env = this._envSetup('buySkellyEnabled');
    if (env !== undefined) return Boolean(env);
    return true;
  }
  setBuySkellyEnabled(on) {
    services.settings?.store?.set?.('pricing.spawner.enabled', Boolean(on), 'pricing');
    this.settings.buySkellyEnabled = Boolean(on);
    this._save();
  }

  getMinMoney() {
    const configured = services.settings?.store?.get?.('pricing.money.minAmount');
    if (Number.isFinite(configured)) return Math.max(0, configured);
    const env = this._envSetup('minMoneyDonut');
    if (env !== undefined) return Math.max(0, env);
    return Math.max(0, Number(this.settings.minMoneyDonut) || 0);
  }
  setMinMoney(donut) {
    this.settings.minMoneyDonut = Math.max(0, Number(donut) || 0);
    services.settings?.store?.set?.('pricing.money.minAmount', this.settings.minMoneyDonut, 'pricing');
    this._save();
  }

  getMinSkelly() {
    const configured = services.settings?.store?.get?.('pricing.spawner.minAmount');
    if (Number.isFinite(configured)) return Math.max(0, Math.floor(configured));
    const env = this._envSetup('minSkellyCount');
    if (env !== undefined) return Math.max(0, Math.floor(env));
    return Math.max(0, Math.floor(Number(this.settings.minSkellyCount) || 0));
  }
  setMinSkelly(count) {
    this.settings.minSkellyCount = Math.max(0, Math.floor(Number(count) || 0));
    services.settings?.store?.set?.('pricing.spawner.minAmount', this.settings.minSkellyCount, 'pricing');
    this._save();
  }

  _rawSweepOwner() {
    const cfg = this.settings.sweepConfig;
    if (!cfg) return null;
    if (Array.isArray(cfg.owners)) return cfg.owners[0] || null;
    if (cfg.owner) return cfg.owner;
    return null;
  }

  getSweepConfig() {
    const src = this._rawSweepOwner();
    let igns = src && Array.isArray(src.igns) ? src.igns : null;
    if (!igns || !igns.length) {
      if (services.config.sweep.igns.length) igns = [...services.config.sweep.igns];
      else {
        const seed = (this.settings.sweepIgn || services.config.sweep.ign || '').trim();
        igns = seed ? [seed] : [];
      }
    }
    const MAX_IGNS_PER_OWNER = 5;
    const owner = {
      name: String((src && src.name) || services.config.sweep.ownerName || 'Owner').slice(0, 32),
      igns: igns.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_IGNS_PER_OWNER),
    };
    return { owners: [owner] };
  }

  setSweepConfig(cfg) {
    const MAX_IGNS_PER_OWNER = 5;
    const src = (cfg && (Array.isArray(cfg.owners) ? cfg.owners[0] : cfg.owner)) || cfg || {};
    this.settings.sweepConfig = {
      owners: [
        {
          name: String(src.name || services.config.sweep.ownerName || 'Owner').slice(0, 32),
          igns: (Array.isArray(src.igns) ? src.igns : []).map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_IGNS_PER_OWNER),
        },
      ],
    };
    this._save();
    return this.getSweepConfig();
  }

  setSweepOwner(patch = {}) {
    const MAX_IGNS_PER_OWNER = 5;
    const owner = this.getSweepConfig().owners[0];
    if (patch.name !== undefined) owner.name = String(patch.name).slice(0, 32) || owner.name;
    if (patch.igns !== undefined) owner.igns = (Array.isArray(patch.igns) ? patch.igns : []).map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_IGNS_PER_OWNER);
    return this.setSweepConfig({ owner });
  }

  sweepIgnCount() {
    return this.getSweepConfig().owners[0].igns.length;
  }

  getSweepDelayMs() {
    const v = Number(this.settings.sweepDelayMs);
    return Number.isFinite(v) && v >= 0 ? v : services.config.sweep.delayMs;
  }
  setSweepDelayMs(ms) {
    this.settings.sweepDelayMs = Math.max(0, Math.floor(Number(ms) || 0));
    this._save();
  }

  getSweepAutoMoney() {
    const v = this.settings.sweepAutoMoney;
    return v === undefined ? services.config.sweep.autoMoney : Boolean(v);
  }
  setSweepAutoMoney(on) {
    this.settings.sweepAutoMoney = Boolean(on);
    this._save();
  }

  getBuyerAccounts() {
    const cfg = services.config && services.config.mc ? services.config.mc : {};
    const src = Array.isArray(this.settings.buyerAccounts) ? this.settings.buyerAccounts : [];
    const count = Math.max(2, src.length);
    const result = [];
    for (let i = 0; i < count; i++) {
      const a = src[i] || {};
      const envEmail = i === 0 ? cfg.email : (i === 1 ? (cfg.buyer2Email || cfg.verifyEmail) : (cfg[`buyer${i + 1}Email`] || ''));
      const envIgn = i === 0 ? cfg.ign : (i === 1 ? (cfg.buyer2Ign || cfg.verifyIgn) : (cfg[`buyer${i + 1}Ign`] || ''));
      result.push({
        email: String(a.email !== undefined ? a.email : (envEmail || '')).trim(),
        ign: String(a.ign !== undefined ? a.ign : (envIgn || '')).trim(),
      });
    }
    return result;
  }
  getBuyerAccount(i) {
    const idx = typeof i === 'number' ? i : parseInt(i, 10) || 0;
    const accs = this.getBuyerAccounts();
    return accs[idx] || { email: '', ign: '' };
  }
  getBuyerEmail(i) {
    return this.getBuyerAccount(i).email;
  }
  getBuyerIgn(i) {
    return this.getBuyerAccount(i).ign;
  }
  setBuyerAccount(i, patch = {}) {
    const idx = typeof i === 'number' ? i : parseInt(i, 10) || 0;
    const accs = this.getBuyerAccounts();
    while (accs.length <= idx) {
      accs.push({ email: '', ign: '' });
    }
    if (patch.email !== undefined) accs[idx].email = String(patch.email).trim();
    if (patch.ign !== undefined) accs[idx].ign = String(patch.ign).trim();
    this.settings.buyerAccounts = accs;
    this._save();
    return accs[idx];
  }

  trustedSystemEnabled() {
    const v = this.settings.trustedSystemEnabled;
    if (v !== undefined) return Boolean(v);
    const env = this._envSetup('trustedSystemEnabled');
    if (env !== undefined) return Boolean(env);
    return Boolean(this.getBuyerEmail(1));
  }
  setTrustedSystemEnabled(on) {
    this.settings.trustedSystemEnabled = Boolean(on);
    this._save();
  }

  getSingleAccountIndex() {
    const env = this._envSetup('singleAccountIndex');
    if (env !== undefined) return env === 1 ? 1 : 0;
    return this.settings.singleAccountIndex === 1 ? 1 : 0;
  }
  setSingleAccountIndex(i) {
    this.settings.singleAccountIndex = i === 1 ? 1 : 0;
    this._save();
  }

  buyer2Needed() {
    if (!this.getBuyerEmail(1)) return false;
    return this.trustedSystemEnabled() || this.getSingleAccountIndex() === 1;
  }

  isDmOptedOut(discordId) {
    const list = this.settings.dmOptOut;
    return Array.isArray(list) && list.includes(String(discordId));
  }
  setDmOptOut(discordId, optedOut) {
    const set = new Set(Array.isArray(this.settings.dmOptOut) ? this.settings.dmOptOut : []);
    if (optedOut) set.add(String(discordId));
    else set.delete(String(discordId));
    this.settings.dmOptOut = [...set];
    this._save();
  }

  getSoldRoleId() {
    return this.settings.soldRoleId || services.config.discord.soldRoleId || '';
  }
  setSoldRoleId(id) {
    this.settings.soldRoleId = String(id || '');
    this._save();
  }

  autosellPaused() {
    const env = this._envSetup('autosellPaused');
    if (env !== undefined) return Boolean(env);
    return Boolean(this.settings.autosellPaused);
  }
  setAutosellPaused(on) {
    this.settings.autosellPaused = Boolean(on);
    this._save();
  }

  getLowBalanceUsd() {
    const env = this._envSetup('lowBalanceUsd');
    if (env !== undefined && env >= 0) return env;
    const v = Number(this.settings.lowBalanceUsd);
    return Number.isFinite(v) && v >= 0 ? v : 4;
  }
  setLowBalanceUsd(v) {
    this.settings.lowBalanceUsd = Math.max(0, Number(v) || 0);
    this._save();
  }
  getRestockUsd() {
    const env = this._envSetup('restockUsd');
    if (env !== undefined && env > 0) return env;
    const v = Number(this.settings.restockUsd);
    return Number.isFinite(v) && v > 0 ? v : 20;
  }
  setRestockUsd(v) {
    this.settings.restockUsd = Math.max(1, Number(v) || 20);
    this._save();
  }

  verifyEnabled() {
    const v = this.settings.verifyEnabled;
    if (v !== undefined) return Boolean(v);
    const env = this._envSetup('verifyEnabled');
    if (env !== undefined) return Boolean(env);
    return services.config.verify.enabled;
  }
  setVerifyEnabled(on) {
    this.settings.verifyEnabled = Boolean(on);
    this._save();
  }

  getTrustThreshold() {
    const env = this._envSetup('trustThresholdSales');
    if (env !== undefined && env >= 0) return Math.floor(env);
    const v = Number(this.settings.trustThresholdSales);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 4;
  }
  setTrustThreshold(n) {
    this.settings.trustThresholdSales = Math.max(0, Math.floor(Number(n) || 0));
    this._save();
  }
  isTrustedSeller(discordId) {
    const s = this.sellersRepo.getSeller(discordId);
    const sales = s && s.stats ? Number(s.stats.sales) || 0 : 0;
    return sales >= this.getTrustThreshold();
  }
  buyerIndexForSeller(discordId) {
    if (this.trustedSystemEnabled() && this.getBuyerEmail(1)) {
      return this.isTrustedSeller(discordId) ? 1 : 0;
    }
    return this.getSingleAccountIndex() === 1 && this.getBuyerEmail(1) ? 1 : 0;
  }

  getExpectedSpawners() {
    return Number(this.settings.expectedSpawners || 0);
  }
  addExpectedSpawners(n) {
    this.settings.expectedSpawners = Math.max(0, this.getExpectedSpawners() + Number(n));
    this._save();
    return this.settings.expectedSpawners;
  }

  pendingCashouts() {
    return this.getSellers()
      .filter((s) => Number(s.balanceUsd) > 0)
      .map((s) => ({ discordId: s.discordId, ign: s.ign || '', ltcAddress: s.ltcAddress || '', balanceUsd: +Number(s.balanceUsd).toFixed(6), pending: s.stats?.pending || null, verified: Boolean(s.verifiedIgn) }))
      .sort((a, b) => b.balanceUsd - a.balanceUsd);
  }

  getOrders() {
    return this.ordersRepo.getAllOrders();
  }
  getSellers() {
    return this.sellersRepo.getAllSellers();
  }

                                                                              
                                                                           
  getLtcAutobuySessions() {
    return [];
  }

  _allUserIds() {
    const ids = new Set(this.getSellers().map(s => String(s.discordId)));
    for (const a of this.activity) if (a.discordId) ids.add(String(a.discordId));
    for (const o of this.getOrders()) if (o.sellerDiscordId) ids.add(String(o.sellerDiscordId));
    for (const s of this.getLtcAutobuySessions()) if (s.discordId) ids.add(String(s.discordId));
    for (const s of this.salesRepo.list()) if (s.discordId) ids.add(String(s.discordId));
    return [...ids];
  }

  lifetimeIgns(discordId) {
    const id = String(discordId);
    const s = this.sellersRepo.getSeller(id);
    const map = new Map();

    const add = (ign, source, ts) => {
      const t = String(ign || '').trim();
      if (!t) return;
      const k = t.toLowerCase();
      const tsN = Number(ts) || 0;
      const ex = map.get(k);
      if (!ex) map.set(k, { ign: t, sources: new Set([source]), firstTs: tsN || null, lastTs: tsN || null });
      else {
        ex.sources.add(source);
        if (tsN) {
          if (!ex.firstTs || tsN < ex.firstTs) ex.firstTs = tsN;
          if (!ex.lastTs || tsN > ex.lastTs) ex.lastTs = tsN;
        }
      }
    };

    if (s) {
      add(s.ign, 'current', null);
      add(s.verifiedIgn, 'verified', null);
    }
    this.activity.filter((a) => String(a.discordId) === id).forEach((a) => add(a.ign, 'activity', a.ts));
    this.getOrders()
      .filter((o) => String(o.sellerDiscordId) === id)
      .forEach((o) => add(o.sellerUsername, 'skelly_order', o.createdAt ? new Date(o.createdAt).getTime() : 0));
    this.salesRepo.list().filter((x) => String(x.discordId) === id).forEach((x) => add(x.ign, 'sale', new Date(x.createdAt).getTime()));
    this.getLtcAutobuySessions()
      .filter((x) => String(x.discordId) === id)
      .forEach((x) => add(x.ign, 'ltc_buy', x.createdAt));

    return [...map.values()]
      .map((v) => ({ ign: v.ign, sources: [...v.sources].sort(), firstTs: v.firstTs, lastTs: v.lastTs }))
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  }

  lifetimeLtcAddresses(discordId) {
    const id = String(discordId);
    const s = this.sellersRepo.getSeller(id);
    const map = new Map();

    const add = (addr, source, ts) => {
      const t = String(addr || '').trim();
      if (!t) return;
      const ex = map.get(t);
      const tsN = Number(ts) || 0;
      if (!ex) map.set(t, { address: t, sources: new Set([source]), firstTs: tsN || null, lastTs: tsN || null });
      else {
        ex.sources.add(source);
        if (tsN) {
          if (!ex.firstTs || tsN < ex.firstTs) ex.firstTs = tsN;
          if (!ex.lastTs || tsN > ex.lastTs) ex.lastTs = tsN;
        }
      }
    };

    if (s) {
      add(s.ltcAddress, 'current', null);
    }
    this.activity.filter((a) => String(a.discordId) === id).forEach((a) => add(a.ltcAddress, 'activity', a.ts));
    this.getOrders()
      .filter((o) => String(o.sellerDiscordId) === id)
      .forEach((o) => add(o.ltcAddress, 'skelly_order', o.createdAt ? new Date(o.createdAt).getTime() : 0));

    return [...map.values()]
      .map((v) => ({ address: v.address, sources: [...v.sources].sort(), firstTs: v.firstTs, lastTs: v.lastTs }))
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  }

  getUserData(discordId) {
    const id = String(discordId);
    const seller = this.sellersRepo.getSeller(id);
    const hasTrail =
      seller ||
      this.activity.some((a) => String(a.discordId) === id) ||
      this.getOrders().some((o) => String(o.sellerDiscordId) === id) ||
      this.salesRepo.list().some((s) => String(s.discordId) === id);
    if (!hasTrail) return null;

    return {
      discordId: id,
      seller,
      stats: this.getStats(id),
      rank: this.rankOf(id),
      lifetimeIgns: this.lifetimeIgns(id),
      lifetimeLtcAddresses: this.lifetimeLtcAddresses(id),
      activity: this.activity.filter((a) => String(a.discordId) === id).slice(-150).reverse(),
      sales: this.salesRepo.list().filter((s) => String(s.discordId) === id).slice(0, 100),
      orders: this.getOrders()
        .filter((o) => String(o.sellerDiscordId) === id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      ltcBuySessions: this.getLtcAutobuySessions()
        .filter((s) => String(s.discordId) === id)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      dmOptOut: this.isDmOptedOut(id),
      trusted: this.isTrustedSeller(id),
      verifyEnabled: seller ? this.isVerified(id, seller.ign) : false,
    };
  }

  listUserDataSummaries({ search = '', limit = 250 } = {}) {
    const q = String(search || '').trim().toLowerCase();
    let ids = this._allUserIds();
    if (q) {
      ids = ids.filter((id) => {
        if (id.includes(q)) return true;
        const s = this.sellersRepo.getSeller(id);
        if (s && String(s.ign || '').toLowerCase().includes(q)) return true;
        if (s && String(s.verifiedIgn || '').toLowerCase().includes(q)) return true;
        return this.lifetimeIgns(id).some((x) => x.ign.toLowerCase().includes(q));
      });
    }
    const rows = ids.map((id) => {
      const s = this.sellersRepo.getSeller(id);
      const st = this.getStats(id);
      const igns = this.lifetimeIgns(id);
      return {
        discordId: id,
        ign: (s && s.ign) || igns[0]?.ign || '',
        verifiedIgn: (s && s.verifiedIgn) || '',
        ignCount: igns.length,
        ltcAddress: (s && s.ltcAddress) || '',
        balanceUsd: st ? st.balanceUsd : 0,
        volumeUsd: st ? st.volumeUsd : 0,
        sales: st ? st.sales : 0,
        anon: st ? st.anon : false,
      };
    });
    rows.sort((a, b) => b.volumeUsd - a.volumeUsd || b.sales - a.sales);
    return rows.slice(0, Math.max(1, Math.min(500, limit)));
  }

  resolveUserId(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    if (/^\d{15,20}$/.test(q)) return q;
    const who = this.whoisIgn(q);
    if (who) return who.discordId;
    const byCurrent = this.getSellerByIgn(q);
    if (byCurrent) return byCurrent.discordId;
    const target = q.toLowerCase();
    for (const a of this.activity) {
      if (String(a.ign || '').trim().toLowerCase() === target) return String(a.discordId);
    }
    for (const o of this.getOrders()) {
      if (String(o.sellerUsername || '').trim().toLowerCase() === target) return String(o.sellerDiscordId);
    }
    return null;
  }

  setPanel(channelId, messageId) {
    const { isSnowflake } = require('../discord/ids');
    if (!isSnowflake(channelId) || !isSnowflake(messageId)) throw Error('Panel channel and message IDs must be valid Discord snowflakes');
    this.settings.panel = { channelId, messageId };
    this._save();
  }
  getPanel() {
    return this.settings.panel || null;
  }
  clearPanel() {
    if (!this.settings.panel) return;
    delete this.settings.panel;
    this._save();
  }

  setBuyPanel(channelId, messageId) {
    this.settings.buyPanel = { channelId, messageId };
    this._save();
  }
  getBuyPanel() {
    return this.settings.buyPanel || null;
  }

  saveOrder(order) {
    this.ordersRepo.saveOrder(order);
  }
  getOrder(id) {
    return this.ordersRepo.getOrder(id);
  }
}

module.exports = SellStore;
