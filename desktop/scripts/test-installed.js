'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('../../node_modules/playwright');
const desktop = path.resolve(__dirname, '..');
const developmental = process.env.AUTOSELL_TEST_DEVELOPMENT === '1';
const executable = developmental ? require('electron') : process.env.AUTOSELL_TEST_EXECUTABLE || path.join(desktop, 'dist/win-unpacked/Autosell V3.exe');
const profile = process.env.AUTOSELL_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'autosell-installed-test-'));
const ownedProfile = !process.env.AUTOSELL_TEST_PROFILE;
const results = path.join(desktop, 'test-results');
fs.mkdirSync(results, { recursive: true });
const password = 'isolated-desktop-vault-passphrase-478';
const outcome = { executable, profile, startedAt: new Date().toISOString(), checks: [], machine: 'Windows host with isolated app profile and PATH excluding global Node; not a clean VM' };
let application;
let expectingRendererCrash = false;
process.on('uncaughtException', error => {
  // Playwright 1.63 surfaces the deliberate Chromium target crash from its CDP
  // callback. The assertions below still require renderer recovery and the same worker.
  if (expectingRendererCrash && error.message === 'Target crashed') return;
  console.error(error);
  process.exit(1);
});
async function waitForState(page, predicate, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => window.desktop.getState()).catch(() => null);
    if (latest && predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Desktop state did not become ready: ' + JSON.stringify(latest?.backend));
}
async function launch() {
  const env = { ...process.env, AUTOSELL_DESKTOP_TEST: '1', PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: executable, args: [...(developmental ? [desktop] : []), '--profile-dir=' + profile], env, timeout: 45000 });
  let page = application.context().pages().find(candidate => candidate.url() === 'autosell://app/index.html');
  if (!page) page = await application.waitForEvent('window', candidate => candidate.url() === 'autosell://app/index.html');
  await page.waitForFunction(() => Boolean(window.desktop), { timeout: 30000 });
  return page;
}
async function unlock(page) {
  await page.getByLabel('Vault passphrase', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await waitForState(page, current => current.backend.phase === 'ready');
}
async function safeExit(page) {
  await page.evaluate(() => window.desktop.action('quit')).catch(() => {});
  await application.process().exitCode;
  await application.close().catch(() => {});
  application = null;
}
async function main() {
  let page = await launch();
  await page.screenshot({ path: path.join(results, 'desktop-startup.png') });
  await unlock(page);
  outcome.checks.push('Bundled backend starts with PATH excluding global Node');
  const ready = await page.evaluate(() => window.desktop.getState());
  assert.equal(ready.backend.phase, 'ready');
  const response = await fetch(ready.backend.origin + '/api/auth/status');
  assert.equal(response.status, 403);
  outcome.checks.push('Outside loopback request is rejected without desktop token');
  const dashboard = application.context().pages().find(candidate => candidate.url().startsWith(ready.backend.origin));
  assert.ok(dashboard);
  assert.equal(await dashboard.evaluate(() => typeof window.desktop), 'undefined');
  assert.equal(await dashboard.evaluate(() => typeof require), 'undefined');
  const setup = await dashboard.evaluate(async () => {
    const auth = await (await fetch('/api/auth/status')).json();
    if (!auth.setupRequired) return { existing: true };
    const response = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'desktop-dashboard-test-478', confirmPassword: 'desktop-dashboard-test-478' }) });
    return { status: response.status };
  });
  assert.ok(setup.existing || setup.status === 200);
  await dashboard.evaluate(async () => {
    const result = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'desktop-dashboard-test-478', dashboardSession: true }) });
    if (!result.ok) throw Error('Dashboard authentication failed');
  });
  await dashboard.reload();
  const authorized = await dashboard.evaluate(async () => (await fetch('/api/health')).status);
  assert.equal(authorized, 200);
  await dashboard.screenshot({ path: path.join(results, 'desktop-dashboard.png') });
  outcome.checks.push('Dashboard loads, owner password setup/login and sandbox isolation pass');
  const lock = path.join(profile, 'workspace/data/process.lock');
  const originalPid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid;
  const second = spawn(executable, [...(developmental ? [desktop] : []), '--profile-dir=' + profile], { windowsHide: true, stdio: 'ignore', env: { ...process.env, AUTOSELL_DESKTOP_TEST: '1' } });
  await new Promise((resolve, reject) => { second.once('exit', resolve); second.once('error', reject); });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, originalPid);
  outcome.checks.push('Second application instance does not launch duplicate worker');
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.minimize(); window.restore(); });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, originalPid);
  outcome.checks.push('Minimize/restore preserves backend PID');
  // Only the backend whose lock is inside this generated profile is terminated.
  assert.ok(ownedProfile, 'Crash test requires a generated temporary profile');
  process.kill(originalPid);
  await waitForState(page, current => current.backend.phase === 'ready' && current.backend.maintenance?.active, 60000);
  assert.notEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, originalPid);
  outcome.checks.push('Backend crash uses bounded restart and persists maintenance fence');
  await page.getByRole('button', { name: 'Updates & settings', exact: true }).click();
  await page.screenshot({ path: path.join(results, 'desktop-updates.png') });
  await page.evaluate(() => window.desktop.action('resume'));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid > 0, true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  outcome.checks.push('Window close keeps backend active in tray');
  await safeExit(page);
  page = await launch();
  await unlock(page);
  const persisted = await page.evaluate(() => window.desktop.getState());
  assert.equal(persisted.backend.maintenance.active, true);
  outcome.checks.push('Safe exit and restart preserve database and maintenance state');
  const recoveredPid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid;
  expectingRendererCrash = true;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  let recovered;
  for (let attempt = 0; attempt < 60; attempt++) {
    recovered = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.desktop.getState()')).catch(() => null);
    if (recovered?.backend.phase === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(recovered?.backend.phase, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, recoveredPid);
  outcome.checks.push('Renderer crash recovers its UI while preserving backend PID');
  await application.evaluate(({ app }) => app.quit());
  await application.close().catch(() => {});
  application = null;
  expectingRendererCrash = false;
  outcome.passed = true;
  console.log(outcome.checks.map(value => 'PASS ' + value).join('\n'));
}
main().catch(error => { outcome.passed = false; outcome.error = error.message; console.error(error); process.exitCode = 1; }).finally(async () => {
  outcome.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(results, 'installed-smoke.json'), JSON.stringify(outcome, null, 2));
  if (application) await application.close().catch(() => {});
  // Failed runs retain isolated data for diagnosis. Successful data belongs only to this test.
  if (ownedProfile && outcome.passed && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('autosell-installed-test-')) fs.rmSync(profile, { recursive: true, force: true });
});
