'use strict';

class SessionsRepository {
  constructor(db) {
    this.db = db;
  }

  create(session) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, account_id, reason, state, lease_ttl_ms, started_at, last_activity, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      session.id,
      session.accountId,
      session.reason,
      session.state,
      session.leaseTtlMs,
      session.startedAt || now,
      session.lastActivity || now,
      session.endedAt || null
    );
    
    return this.get(session.id);
  }

  update(id, updates) {
    const sets = [];
    const values = [];
    
    const fields = {
      state: 'state',
      lastActivity: 'last_activity',
      endedAt: 'ended_at',
      leaseTtlMs: 'lease_ttl_ms'
    };

    for (const [key, col] of Object.entries(fields)) {
      if (updates[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(updates[key]);
      }
    }

    if (sets.length === 0) return this.get(id);
    values.push(id);

    const stmt = this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.get(id);
  }

  get(id) {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapRow(row) : null;
  }

  getActiveSessions(accountId = null) {
    let sql = 'SELECT * FROM sessions WHERE state != ? AND ended_at IS NULL';
    const params = ['disconnected'];
    
    if (accountId) {
      sql += ' AND account_id = ?';
      params.push(accountId);
    }
    
    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(r => this._mapRow(r));
  }

  _mapRow(row) {
    return {
      id: row.id,
      accountId: row.account_id,
      reason: row.reason,
      state: row.state,
      leaseTtlMs: row.lease_ttl_ms,
      startedAt: row.started_at,
      lastActivity: row.last_activity,
      endedAt: row.ended_at
    };
  }
}

module.exports = SessionsRepository;
