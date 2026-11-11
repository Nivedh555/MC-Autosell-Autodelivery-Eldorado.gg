'use strict';
const fs = require('node:fs');
const path = require('node:path');
function acquire(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'process.lock');
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
