'use strict';

class SalesRepository {
  constructor(db) {
    this.db = db;
  }

  create(sale) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sales (id, discord_id, kind, state, donut_amount, skelly_count, usd_amount, ltc_amount, tx_id, ign, account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      sale.id,
      sale.discordId,
      sale.kind,
      sale.state,
      sale.donutAmount || 0,
      sale.skellyCount || 0,
      sale.usdAmount || 0,
      sale.ltcAmount || 0,
      sale.txId || null,
      sale.ign || null,
      sale.accountId || null,
      sale.createdAt || now,
      now
    );
    
    return this.get(sale.id);
  }

  update(id, updates) {
    const now = new Date().toISOString();
    const sets = [];
    const values = [];
    
    const fields = {
      state: 'state',
      donutAmount: 'donut_amount',
      skellyCount: 'skelly_count',
      usdAmount: 'usd_amount',
      ltcAmount: 'ltc_amount',
      txId: 'tx_id',
      ign: 'ign',
      accountId: 'account_id'
    };

    for (const [key, col] of Object.entries(fields)) {
      if (updates[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(updates[key]);
      }
    }

    if (sets.length === 0) return this.get(id);

    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = this.db.prepare(`UPDATE sales SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.get(id);
  }

  get(id) {
    const stmt = this.db.prepare('SELECT * FROM sales WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapRow(row) : null;
  }

  list({ limit = 500, since = null, offset = 0 } = {}) {
    let sql = 'SELECT * FROM sales';
    const params = [];
    
    if (since) {
      sql += ' WHERE created_at >= ?';
      params.push(since);
    }
    
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(r => this._mapRow(r));
  }

  _mapRow(row) {
    return {
      id: row.id,
      discordId: row.discord_id,
      kind: row.kind,
      state: row.state,
      donutAmount: row.donut_amount,
      skellyCount: row.skelly_count,
      usdAmount: row.usd_amount,
      ltcAmount: row.ltc_amount,
      txId: row.tx_id,
      ign: row.ign,
      accountId: row.account_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = SalesRepository;
