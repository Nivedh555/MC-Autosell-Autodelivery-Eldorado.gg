'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { verifyManifest, verifyUpdateInfo, externalUrl, trustedFrame } = require('../lib/security');
const { runtimeEnvironment } = require('../lib/supervisor');
const { Updates } = require('../lib/updates');
const saved = require('../lib/state');
const keys = crypto.generateKeyPairSync('ed25519');
const manifest = { version: '3.0.1', channel: 'stable', artifact: { file: 'Autosell-Setup-3.0.1-x64.exe', sha512: crypto.createHash('sha512').update('fixture').digest('base64'), size: 7 }, releaseNotes: 'Verified release fixture' };
const bytes = Buffer.from(JSON.stringify(manifest));
const signature = crypto.sign(null, bytes, keys.privateKey).toString('base64');
const info = { version: manifest.version, files: [{ url: manifest.artifact.file, sha512: manifest.artifact.sha512, size: manifest.artifact.size }] };
test('release metadata authenticates exact bytes and binds channel and version', () => {
  assert.deepEqual(verifyManifest(bytes, signature, keys.publicKey, 'stable', '3.0.0'), manifest);
  assert.throws(() => verifyManifest(Buffer.from(bytes.toString().replace('3.0.1', '3.9.1')), signature, keys.publicKey, 'stable', '3.0.0'), /signature/);
  assert.throws(() => verifyManifest(bytes, signature, keys.publicKey, 'beta', '3.0.0'), /channel/);
  assert.throws(() => verifyManifest(bytes, signature, keys.publicKey, 'stable', '4.0.0'), /rollback/);
});
test('updater info must match signed artifact and contain one executable', () => {
  verifyUpdateInfo(info, manifest);
  assert.throws(() => verifyUpdateInfo({ ...info, version: '3.1.0' }, manifest));
  assert.throws(() => verifyUpdateInfo({ ...info, files: [{ ...info.files[0], sha512: 'wrong' }] }, manifest));
  assert.throws(() => verifyUpdateInfo({ ...info, files: [{ ...info.files[0], url: 'https://attacker.invalid/setup.exe' }] }, manifest));
});
test('external URL validation excludes unsafe schemes, host confusion and credentials', () => {
  assert.equal(externalUrl('https://github.com/Nivedh555'), 'https://github.com/Nivedh555');
  for (const value of ['file:///C:/Windows', 'javascript:alert(1)', 'https://github.com.attacker.invalid/', 'https://user@github.com/', 'https://github.com:8443/', 'https://localhost/']) assert.throws(() => externalUrl(value));
});
test('desktop IPC requires the owned window and exact main-frame URL', () => {
  const mainFrame = { url: 'autosell://app/index.html' };
  const contents = { mainFrame };
  const window = { isDestroyed: () => false, webContents: contents };
  assert.equal(trustedFrame({ sender: contents, senderFrame: mainFrame }, window), true);
  assert.equal(trustedFrame({ sender: contents, senderFrame: { url: 'http://127.0.0.1:1234/' } }, window), false);
  assert.equal(trustedFrame({ sender: {}, senderFrame: mainFrame }, window), false);
});
test('runtime uses explicit bundled Node and browser paths without inheriting Node injection flags', () => {
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=attacker.js';
  try {
    const env = runtimeEnvironment('C:/runtime', 'C:/profile', 'secret-token', 'vault-secret', true);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_PATH, undefined);
    assert.equal(env.AUTOSELL_HOME, 'C:/profile');
    assert.equal(env.AUTOSELL_DESKTOP_RECOVERY, '1');
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join('C:/runtime', 'browsers'));
  } finally { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; }
});
function fixture(t, safe = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autosell-desktop-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const updater = new EventEmitter();
  const calls = [];
  const backend = {
    control: async action => { calls.push(action); return { safe, active: true, targetVersion: '3.0.1', reason: safe ? '' : 'Payment outcome uncertain' }; },
    stop: async () => { calls.push('stop'); }
  };
  const updates = new Updates({ updater, config: { channel: 'stable', enabled: false }, version: '3.0.0', directory, backend, install: () => calls.push('install'), packaged: false });
  return { updates, updater, backend, calls, directory };
}
test('active or uncertain payment keeps verified update pending without stopping services', async t => {
  const { updates, calls } = fixture(t);
  updates.set({ phase: 'downloaded', latestVersion: '3.0.1' });
  await updates.requestInstall();
  assert.equal(updates.state.phase, 'waiting');
  assert.deepEqual(calls, ['maintenance']);
  assert.match(updates.state.reason, /uncertain/);
});
test('safe installation persists its target and rechecks the fence before backend shutdown', async t => {
  const { updates, calls, directory } = fixture(t, true);
  updates.set({ phase: 'downloaded', latestVersion: '3.0.1' });
  await updates.requestInstall();
  assert.deepEqual(calls, ['maintenance', 'status', 'stop', 'install']);
  assert.equal(saved.read(path.join(directory, 'update-journal.json')).target, '3.0.1');
});
test('a safety change after maintenance blocks installation', async t => {
  const { updates, backend, calls } = fixture(t, true);
  backend.control = async action => { calls.push(action); return { safe: action === 'maintenance', reason: 'New uncertain bridge result' }; };
  updates.set({ phase: 'downloaded', latestVersion: '3.0.1' });
  await updates.requestInstall();
  assert.deepEqual(calls, ['maintenance', 'status']);
  assert.equal(updates.state.phase, 'waiting');
});
test('installer failure or mismatched maintenance target never automatically resumes payments', async t => {
  const { updates, calls, directory } = fixture(t, true);
  saved.write(path.join(directory, 'update-journal.json'), { target: '3.0.1', phase: 'installing' });
  await updates.validateRestart();
  assert.equal(updates.state.phase, 'recovery');
  assert.deepEqual(calls, []);
});
test('successful upgrade resumes only matching safe persisted maintenance and records validation', async t => {
  const { updates, calls, directory } = fixture(t, true);
  updates.version = '3.0.1';
  saved.write(path.join(directory, 'update-journal.json'), { target: '3.0.1', phase: 'installing' });
  await updates.validateRestart();
  assert.deepEqual(calls, ['status', 'resume']);
  assert.equal(saved.read(path.join(directory, 'update-journal.json')).phase, 'validated');
});
test('download progress is measured, signature mismatch rejects ready state, errors are recoverable', t => {
  const { updates, updater } = fixture(t);
  updates.manifest = manifest;
  updater.emit('download-progress', { percent: 42, transferred: 420, total: 1000, bytesPerSecond: 100 });
  assert.equal(updates.state.progress, 42);
  updater.emit('update-downloaded', { ...info, version: '4.0.0' });
  assert.equal(updates.state.phase, 'error');
  updater.emit('update-downloaded', info);
  assert.equal(updates.state.phase, 'downloaded');
  updater.emit('error', Error('Download interrupted'));
  assert.equal(updates.state.phase, 'error');
});
test('signed release discovery handles current version and downloads a newer verified release', async t => {
  const { updates, updater } = fixture(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  updates.enabled = true;
  updates.config.metadataPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  updates.config.owner = 'test';
  updates.config.repo = 'test';
  global.fetch = async url => new Response(url.endsWith('.sig') ? signature : bytes);
  updater.setFeedURL = feed => assert.match(feed.url, /releases\/download\/v3\.0\.1\/$/);
  updater.checkForUpdates = async () => ({ updateInfo: info });
  updater.downloadUpdate = async () => { updater.emit('download-progress', { percent: 100 }); updater.emit('update-downloaded', info); };
  updates.version = '3.0.1';
  await updates.check();
  assert.equal(updates.state.phase, 'current');
  updates.version = '3.0.0';
  await updates.check();
  assert.equal(updates.state.phase, 'downloaded');
  assert.equal(updates.state.latestVersion, '3.0.1');
});
test('beta release discovery selects the highest public beta and persists channel selection', async t => {
  const { updates, updater, directory } = fixture(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  updates.config.owner = 'owner';
  updates.config.repo = 'repo';
  updates.selectChannel('beta');
  global.fetch = async () => new Response(JSON.stringify([
    { draft: false, prerelease: true, tag_name: 'v3.1.0-beta.1' },
    { draft: false, prerelease: true, tag_name: 'v3.1.0-beta.2' },
    { draft: true, prerelease: true, tag_name: 'v9.0.0-beta.1' },
    { draft: false, prerelease: false, tag_name: 'v4.0.0' }
  ]));
  assert.match(await updates.manifestBase(), /v3\.1\.0-beta\.2\/$/);
  assert.equal(updater.allowPrerelease, true);
  assert.equal(saved.read(path.join(directory, 'update-preferences.json')).channel, 'beta');
  updates.set({ phase: 'downloaded' });
  assert.throws(() => updates.selectChannel('stable'), /pending update/);
});
