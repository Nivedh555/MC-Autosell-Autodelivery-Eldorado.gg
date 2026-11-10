'use strict';
                                                                            
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../db/database');
async function restore(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination || fs.lstatSync(source).isSymbolicLink()) throw new Error('Invalid backup source');
  const release = require('./instance-lock').acquire(path.dirname(destination));
  let database;
  try {
                                                                                                   
    if ([destination, destination + '-wal', destination + '-shm'].some(file => fs.existsSync(file))) throw new Error('Restore target must be a new file; preserve the existing DB and WAL files');
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    database = await Database.open(destination);
    const check = database.raw().prepare('PRAGMA integrity_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('Restored SQLite integrity check failed');
    database.raw().exec('BEGIN IMMEDIATE');
    database.raw().prepare("UPDATE restore_control SET held=1,reason='Restored backup: reconcile all marketplace orders and wallet transactions since snapshot before live unlock' WHERE id=1").run();
    database.raw().prepare("UPDATE delivery_orders SET state='NEEDS_OPERATOR',reason='Restored backup: no automatic replay' WHERE state NOT IN ('DELIVERED','TRANSFERRED','CANCELLED','EXPIRED','DRY_RUN','MARKETPLACE_CLOSED','RECONCILIATION_REQUIRED')").run();
    database.raw().exec('COMMIT');
    return { destination, held: true, externalReconciliationRequired: true };
  } finally { await database?.close(); release(); }
}
if (require.main === module) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) { console.error('Usage: node ops/restore.js BACKUP NEW_DATABASE'); process.exitCode = 1; }
  else restore(source, destination).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { restore };
