'use strict';

class SellersRepository {
  constructor(db) {
    this.db = db;
  }

  getSeller(discordId) {
    const stmt = this.db.prepare('SELECT * FROM sellers WHERE discord_id = ?');
    const row = stmt.get(discordId);
    if (!row) return null;
    return this._mapRow(row);
  }

  getSellerByIgn(ign) {
    const target = String(ign || '').trim().toLowerCase();
    if (!target) return null;
    const stmt = this.db.prepare('SELECT * FROM sellers WHERE LOWER(ign) = ?');
    const row = stmt.get(target);
    if (!row) return null;
    return this._mapRow(row);
  }

  whoisIgn(ign) {
    const target = String(ign || '').trim().toLowerCase();
    if (!target) return null;
    
                        
    const stmtCurrent = this.db.prepare('SELECT * FROM sellers WHERE LOWER(ign) = ?');
    let row = stmtCurrent.get(target);
    if (row) {
      const s = this._mapRow(row);
      return { ...s, matchedBy: 'current' };
    }
    
                         
    const stmtVerified = this.db.prepare('SELECT * FROM sellers WHERE LOWER(verified_ign) = ?');
    row = stmtVerified.get(target);
    if (row) {
      const s = this._mapRow(row);
      return { ...s, matchedBy: 'verified' };
    }
    
    return null;
  }

  setSeller(discordId, { ign, ltcAddress }) {
    const existing = this.getSeller(discordId);
    const newIgn = String(ign).trim();
    const newLtc = String(ltcAddress).trim();
    const now = new Date().toISOString();

    let verifiedIgn = existing ? existing.verifiedIgn : '';
    let stats = existing ? existing.stats : {
      moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0, sales: 0, cashedOutUsd: 0,
      pending: { moneyDonut: 0, moneyUsd: 0, skellyCount: 0, skellyUsd: 0 }
    };
    
    if (existing && existing.ign && existing.ign.toLowerCase() !== newIgn.toLowerCase()) {
      if (verifiedIgn && verifiedIgn.toLowerCase() !== newIgn.toLowerCase()) {
        verifiedIgn = '';
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO sellers (discord_id, ign, ltc_address, verified_ign, stats, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        ign = excluded.ign,
        ltc_address = excluded.ltc_address,
        verified_ign = excluded.verified_ign,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(discordId, newIgn, newLtc, verifiedIgn, JSON.stringify(stats), existing ? existing.createdAt : now, now);
    return this.getSeller(discordId);
  }

  setVerified(discordId, ign) {
    const t = String(ign).trim();
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET verified_ign = ?, updated_at = ? WHERE discord_id = ?');
    stmt.run(t, now, discordId);
  }

  unlink(discordId) {
    const existing = this.getSeller(discordId);
    if (!existing) return null;
    const old = existing.verifiedIgn;
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET verified_ign = ?, updated_at = ? WHERE discord_id = ?');
    stmt.run('', now, discordId);
    return old;
  }

  clearSeller(discordId) {
    const existing = this.getSeller(discordId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET ign = ?, ltc_address = ?, verified_ign = ?, updated_at = ? WHERE discord_id = ?');
    stmt.run('', '', '', now, discordId);
    return { ign: existing.ign, ltcAddress: existing.ltcAddress, verifiedIgn: existing.verifiedIgn };
  }

  addBalanceUsd(discordId, usd) {
    const existing = this.getSeller(discordId);
    if (!existing) return 0;
    const newBalance = +(existing.balanceUsd + Number(usd)).toFixed(6);
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET balance_usd = ?, updated_at = ? WHERE discord_id = ?');
    stmt.run(newBalance, now, discordId);
    return newBalance;
  }

  getBalanceUsd(discordId) {
    const s = this.getSeller(discordId);
    return s ? Number(s.balanceUsd) : 0;
  }

  zeroBalance(discordId) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET balance_usd = 0, updated_at = ? WHERE discord_id = ?');
    stmt.run(now, discordId);
  }

  updateStats(discordId, stats) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET stats = ?, updated_at = ? WHERE discord_id = ?');
    stmt.run(JSON.stringify(stats), now, discordId);
  }

  setAnon(discordId, anon) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE sellers SET anonymous = ?, updated_at = ? WHERE discord_id = ?');
    stmt.run(anon ? 1 : 0, now, discordId);
  }

  getAllSellers() {
    const stmt = this.db.prepare('SELECT * FROM sellers');
    return stmt.all().map(r => this._mapRow(r));
  }

  _mapRow(row) {
    return {
      discordId: row.discord_id,
      ign: row.ign,
      ltcAddress: row.ltc_address,
      verifiedIgn: row.verified_ign,
      balanceUsd: row.balance_usd,
      anon: Boolean(row.anonymous),
      stats: row.stats ? JSON.parse(row.stats) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = SellersRepository;
