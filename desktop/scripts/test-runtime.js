'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Supervisor, runtimeEnvironment } = require('../lib/supervisor');
const directory = path.resolve(__dirname, '..');
const runtime = process.env.AUTOSELL_TEST_RUNTIME || path.join(directory, 'staging');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'autosell-runtime-test-'));
const backend = new Supervisor(runtime, profile);
process.env.AUTOSELL_DESKTOP_TEST = '1';
let diagnostics = '';
backend.on('diagnostic', chunk => { diagnostics = (diagnostics + chunk).slice(-10000); });
async function request(url, options = {}, authenticated = true) {
  return fetch(backend.origin + url, { ...options, headers: { ...(authenticated ? { 'X-Autosell-Desktop': backend.token } : {}), ...options.headers }, signal: AbortSignal.timeout(15000) });
}
async function main() {
  const environment = runtimeEnvironment(runtime, profile, '', '', false);
  const browserCheck = spawnSync(path.join(runtime, 'node/Autosell-Worker.exe'), ['-e', "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE runtime_check(value)');db.close();const {chromium}=require('playwright');(async()=>{const browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.setContent('<h1>Bundled Chromium ready</h1>');if(await page.textContent('h1')!=='Bundled Chromium ready')throw Error('Browser check failed');console.log(JSON.stringify({node:process.version,browser:browser.version()}));await browser.close()})().catch(e=>{console.error(e);process.exitCode=1})"], { cwd: path.join(runtime, 'backend'), env: environment, encoding: 'utf8', windowsHide: true, timeout: 45000 });
  assert.equal(browserCheck.status, 0, browserCheck.stderr);
  console.log(browserCheck.stdout.trim());
  const ready = await backend.start('isolated-runtime-vault-passphrase-234');
  assert.equal(ready.version, require('../package.json').version);
  assert.equal((await request('/', {}, false)).status, 403);
  assert.equal((await request('/api/auth/status', {}, false)).status, 403);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/v3/dashboard')).status, 401);
  const setup = await request('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: backend.origin }, body: JSON.stringify({ password: 'desktop-test-dashboard-123', confirmPassword: 'desktop-test-dashboard-123' }) });
  assert.equal(setup.status, 200, await setup.text());
  const result = await backend.control('maintenance');
  assert.equal(result.safe, true);
  await backend.stop();
  await backend.start('isolated-runtime-vault-passphrase-234');
  const auth = await request('/api/auth/status');
  assert.equal((await auth.json()).setupRequired, false);
  const persisted = await backend.control('status');
  assert.equal(persisted.active, true);
  assert.equal((await backend.control('resume')).safe, true);
  await backend.control('maintenance');
  await backend.stop();
  console.log('PASS bundled Node/SQLite, Chromium, authenticated loopback, dashboard, owner setup, restart persistence and maintenance lifecycle');
}
main().catch(error => { console.error(error); console.error(diagnostics); process.exitCode = 1; }).finally(async () => {
  if (backend.child) {
    try { await backend.control('maintenance'); await backend.stop(); } catch { backend.child.kill(); }
  }
  // This profile was created by this test and contains only generated fixtures.
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('autosell-runtime-test-')) fs.rmSync(profile, { recursive: true, force: true });
});
