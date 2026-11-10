'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const constants = require('../constants');

class AuditLog {
  constructor(dbPath = constants.DEFAULT_DB_FILE) {
    this.dbPath = path.resolve(dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${constants.AUDIT_TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  log(actor, action, target, oldValue, newValue) {
    const stmt = this.db.prepare(`
      INSERT INTO ${constants.AUDIT_TABLE_NAME} 
      (actor, action, target, old_value, new_value) 
      VALUES (?, ?, ?, ?, ?)
    `);
    
                                                                                        
    const safeOld = this._maskIfSecret(oldValue);
    const safeNew = this._maskIfSecret(newValue);

    stmt.run(
      actor || 'system',
      action,
      target,
      safeOld === undefined ? null : JSON.stringify(safeOld),
      safeNew === undefined ? null : JSON.stringify(safeNew)
    );
  }

  _maskIfSecret(val) {
    if (val === undefined || val === null) return val;
                                                    
                                                                               
    if (typeof val === 'string' && val.length > 20 && val.includes('m/')) {
      return '***';                            
    }
    return val;
  }

  getLogs(limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM ${constants.AUDIT_TABLE_NAME}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  }
}

module.exports = AuditLog;
