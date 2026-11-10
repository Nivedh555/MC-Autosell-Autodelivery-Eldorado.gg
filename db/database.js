'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
                                                           
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  static async open(dbPath) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const instance = new Database(dbPath);
    try {await instance.migrate();}catch(error){await instance.close();throw error;}
    return instance;
  }

  raw() {
    return this.db;
  }

  async migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return { applied: [] };

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    const supported=Math.max(0,...files.map(file=>Number(file.match(/^(\d+)-/)?.[1]||0)));
    const current=this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version||0;
    if(current>supported)throw Error('This database was upgraded by a newer Autosell version. Install that version or newer; do not roll back payment journals.');

    const applied = [];
    for (const file of files) {
      const versionMatch = file.match(/^(\d+)-/);
      if (!versionMatch) continue;
      const version = parseInt(versionMatch[1], 10);

      const stmt = this.db.prepare('SELECT version FROM schema_version WHERE version = ?');
      const isApplied = stmt.get(version);

      if (!isApplied) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        applied.push(file);
      }
    }

    return { applied };
  }

  async backup(targetPath) {
    const defaultPath = path.join(path.dirname(this.dbPath), 'backups', `backup-${Date.now()}.db`);
    const backupFile = targetPath || defaultPath;
    const backupDir = path.dirname(backupFile);
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

                                                                              
    this.db.prepare('VACUUM INTO ?').run(path.resolve(backupFile));
    return backupFile;
  }

  async restore(backupPath) {
    throw new Error('Online restore refused: stop the app and use the quarantined offline restore command; old backups must never replay money');
  }

  async healthCheck() {
    try {
      const stmt = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
      const tables = stmt.all().map(r => r.name);
      const stat = fs.statSync(this.dbPath);
      return { ok: true, size: stat.size, tables };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = Database;
