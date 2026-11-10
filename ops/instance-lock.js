'use strict';
const fs = require('node:fs');
const path = require('node:path');
function acquire(directory, {migrationTarget}={}) {
  fs.mkdirSync(directory, { recursive: true });
  if(fs.existsSync(path.join(directory,'migrated-to.json'))){
    const retired=JSON.parse(fs.readFileSync(path.join(directory,'migrated-to.json'),'utf8'));
    if(!migrationTarget||retired.target!==migrationTarget)throw Error('This workspace was migrated to the desktop application. Start the desktop app; the old copy is retired to prevent duplicate payments.');
  }
  let file = path.join(directory, 'process.lock');
  if(migrationTarget && fs.existsSync(file)){
    const retired=JSON.parse(fs.readFileSync(file,'utf8'));
    // Legacy launchers also refuse pid zero. Retain that fence during recovery.
    if(retired.pid===0&&retired.retiredTo===migrationTarget)file=path.join(directory,'migration-recovery.lock');
  }
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid process lock; inspect it manually');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('Another Autosell process may be active: ' + previous.pid);
    fs.unlinkSync(file);
  }
  const token = require('node:crypto').randomUUID();
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {}
  };
}
module.exports = { acquire };
