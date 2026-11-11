'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
function runtimeEnvironment(runtime, home, token, passphrase, recovery) {
  const env = {};
  for (const name of ['SystemRoot', 'SystemDrive', 'COMSPEC', 'ComSpec', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, {
    PATH: [path.join(runtime, 'node'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter),
    NODE_ENV: 'production',
    AUTOSELL_HOME: home,
    AUTOSELL_DESKTOP: '1',
    AUTOSELL_DESKTOP_TOKEN: token,
    AUTOSELL_DESKTOP_RECOVERY: recovery ? '1' : '0',
    PLAYWRIGHT_BROWSERS_PATH: path.join(runtime, 'browsers')
  });
  if (passphrase) env.VAULT_PASSPHRASE = passphrase;
  if (process.env.AUTOSELL_DESKTOP_TEST === '1') {
    env.AUTOSELL_DESKTOP_TEST = '1';
    env.AUTOSELL_DESKTOP_TEST_BRIDGE_PORT = '0';
  }
  return env;
}
class Supervisor extends EventEmitter {
  constructor(runtime, home, { spawnProcess = spawn, startupTimeoutMs = 90000 } = {}) {
    super();
    this.runtime = runtime;
    this.home = home;
    this.child = null;
    this.pending = new Map();
    this.token = '';
    this.origin = '';
    this.expectedExit = false;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
  }
  start(passphrase, recovery = false) {
    if (this.child) throw Error('Backend is already running');
    this.expectedExit = false;
    this.origin = '';
    this.token = crypto.randomBytes(32).toString('hex');
    const child = this.spawnProcess(path.join(this.runtime, 'node', 'Autosell-Worker.exe'), [path.join(this.runtime, 'backend', 'index.js')], {
      cwd: this.home,
      env: runtimeEnvironment(this.runtime, this.home, this.token, passphrase, recovery),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.child = child;
    child.stdout.on('data', bytes => this.emit('diagnostic', bytes.toString()));
    child.stderr.on('data', bytes => this.emit('diagnostic', bytes.toString()));
    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        this.emit('slow-start');
        // An alive process may already have opened financial journals. Keep its
        // readiness promise pending so a later verified signal still opens the UI.
      }, this.startupTimeoutMs);
      child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready' && !ready && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
          ready = true;
          clearTimeout(timeout);
          this.origin = 'http://127.0.0.1:' + message.port;
          this.ready = message;
          this.emit('ready', message);
          resolve(message);
        }
        if (message.type === 'result' && typeof message.id === 'string') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
          if (message.error) pending.reject(Error(String(message.error).slice(0, 500)));
          else pending.resolve(message);
        }
      });
      child.once('error', error => {
        clearTimeout(timeout);
        if (!ready && !child.pid && this.child === child) {
          // Spawn failure has no running worker and may emit close without exit.
          this.child = null;
          this.token = '';
          this.origin = '';
        }
        reject(Error('Bundled backend could not launch (' + error.code + ').'));
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        const expected = this.expectedExit;
        this.child = null;
        this.origin = '';
        this.token = '';
        for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(Error('Backend exited before replying')); }
        this.pending.clear();
        if (!ready) reject(Error('Backend startup failed. Check the vault passphrase, migration status, and Minecraft bridge port. Exit code ' + code + '.'));
        this.emit('exit', { code, signal, expected, wasReady: ready });
      });
    });
  }
  control(action, extra = {}) {
    if (!['status', 'maintenance', 'resume', 'shutdown'].includes(action)) return Promise.reject(Error('Unsupported backend action'));
    if (!this.child?.connected) return Promise.reject(Error('Backend control channel is unavailable'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(Error('Backend maintenance check timed out. The update is still pending.')); }, 45000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.send({ type: 'control', id, action, ...extra }, error => {
        if (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
      });
    });
  }
  async stop() {
    if (!this.child) return;
    const status = await this.control('status');
    if (status.safe !== true) throw Error(status.reason || 'Payments have not reached a safe shutdown boundary');
    this.expectedExit = true;
    const exited = new Promise(resolve => this.child.once('exit', resolve));
    try {
      const result = await this.control('shutdown');
      if (result.safe !== true) throw Error(result.reason || 'Backend refused shutdown');
      await Promise.race([exited, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('Backend is still draining. Installation remains pending.')), 60000);
        timer.unref();
      })]);
    } catch (error) { this.expectedExit = false; throw error; }
  }
}
module.exports = { Supervisor, runtimeEnvironment };
