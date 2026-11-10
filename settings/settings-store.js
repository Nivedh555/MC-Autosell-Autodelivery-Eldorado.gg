'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const constants = require('../constants');
const AuditLog = require('../audit/audit-log');

class SettingsStore extends EventEmitter {
  constructor(dbPath = constants.DEFAULT_DB_FILE) {
    super();
    this.dbPath = path.resolve(dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.auditLog = new AuditLog(this.dbPath);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${constants.SETTINGS_TABLE_NAME} (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  get(id) {
    const stmt = this.db.prepare(`SELECT value FROM ${constants.SETTINGS_TABLE_NAME} WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  getAll() {
    const stmt = this.db.prepare(`SELECT id, value FROM ${constants.SETTINGS_TABLE_NAME}`);
    const rows = stmt.all();
    const result = {};
    for (const row of rows) {
      try {
        result[row.id] = JSON.parse(row.value);
      } catch {
        result[row.id] = row.value;
      }
    }
    return result;
  }

  set(id, value, actor, maskSecret = false) {
    const oldValue = this.get(id);
    
                       
    if (JSON.stringify(oldValue) === JSON.stringify(value)) {
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO ${constants.SETTINGS_TABLE_NAME} (id, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET 
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);
    
    stmt.run(id, JSON.stringify(value));

    const safeOld = maskSecret && oldValue ? '***' : oldValue;
    const safeNew = maskSecret && value ? '***' : value;

    this.auditLog.log(actor, 'SET', id, safeOld, safeNew);
    this.emit('change', id, value, oldValue);
  }

  delete(id, actor, maskSecret = false) {
    const oldValue = this.get(id);
    if (oldValue === undefined) return;

    const stmt = this.db.prepare(`DELETE FROM ${constants.SETTINGS_TABLE_NAME} WHERE id = ?`);
    stmt.run(id);

    const safeOld = maskSecret ? '***' : oldValue;
    this.auditLog.log(actor, 'RESET', id, safeOld, null);
    this.emit('change', id, undefined, oldValue);
  }
}

module.exports = SettingsStore;
