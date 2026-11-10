'use strict';

const Reconciler = require('./reconciler');

class Ledger {
  constructor(db) {
    this.db = db;
    this.reconciler = new Reconciler(this.db);
  }

  append(entry) {
    const now = new Date().toISOString();
    
    try {
      const stmt = this.db.prepare(`
        INSERT INTO ledger (idempotency_key, entry_type, currency, amount, reference_type, reference_id, account_id, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const info = stmt.run(
        entry.idempotencyKey,
        entry.entryType,
        entry.currency,
        entry.amount,
        entry.referenceType,
        entry.referenceId,
        entry.accountId,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        now
      );
      
      return this.get(info.lastInsertRowid);
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
                                            
        const stmt = this.db.prepare('SELECT * FROM ledger WHERE idempotency_key = ?');
        const row = stmt.get(entry.idempotencyKey);
        return this._mapRow(row);
      }
      throw err;
    }
  }

  get(id) {
    const stmt = this.db.prepare('SELECT * FROM ledger WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapRow(row) : null;
  }

  query(filter = {}) {
    let sql = 'SELECT * FROM ledger WHERE 1=1';
    const params = [];

    if (filter.entryType) {
      sql += ' AND entry_type = ?';
      params.push(filter.entryType);
    }
    if (filter.currency) {
      sql += ' AND currency = ?';
      params.push(filter.currency);
    }
    if (filter.referenceType) {
      sql += ' AND reference_type = ?';
      params.push(filter.referenceType);
    }
    if (filter.referenceId) {
      sql += ' AND reference_id = ?';
      params.push(filter.referenceId);
    }
    if (filter.accountId) {
      sql += ' AND account_id = ?';
      params.push(filter.accountId);
    }
    if (filter.since) {
      sql += ' AND created_at >= ?';
      params.push(filter.since);
    }

    sql += ' ORDER BY created_at DESC';

    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(r => this._mapRow(r));
  }

  balance(accountId, currency) {
                                                             
    const stmt = this.db.prepare(`
      SELECT entry_type, amount FROM ledger 
      WHERE account_id = ? AND currency = ?
    `);
    const rows = stmt.all(accountId, currency);
    
    let total = 0;
    for (const row of rows) {
      if (['credit', 'transfer_in'].includes(row.entry_type)) {
        total += row.amount;
      } else if (['debit', 'transfer_out', 'payout', 'delivery', 'fee'].includes(row.entry_type)) {
        total -= row.amount;
      }
    }
    
    return total;
  }

  reconcile() {
    return this.reconciler.run();
  }

  _mapRow(row) {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      entryType: row.entry_type,
      currency: row.currency,
      amount: row.amount,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      accountId: row.account_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at
    };
  }
}

module.exports = Ledger;
