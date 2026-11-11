'use strict';
// Real signed A-to-B acceptance. This only runs against two published signed
// releases; an unsigned development build cannot enable the update feed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('../../node_modules/playwright');
const executable = process.env.AUTOSELL_TEST_EXECUTABLE;
const profile = process.env.AUTOSELL_TEST_PROFILE;
const target = String(process.env.AUTOSELL_TEST_TARGET_VERSION || '').replace(/^v/, '');
const channel = process.env.AUTOSELL_TEST_CHANNEL === 'beta' ? 'beta' : 'stable';
if (!executable || !profile || !target) throw Error('AUTOSELL_TEST_EXECUTABLE, AUTOSELL_TEST_PROFILE and AUTOSELL_TEST_TARGET_VERSION are required');
const results = path.resolve(__dirname, '../test-results');
fs.mkdirSync(results, { recursive: true });
const password = 'signed-acceptance-passphrase-478';
let application;
async function state(page) { return page.evaluate(() => window.desktop.getState()); }
async function waitFor(page, predicate, timeout = 15 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await state(page).catch(() => null);
    if (latest && predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Timed out waiting for update state: ' + JSON.stringify(latest?.updates));
}
async function launch() {
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: executable, args: ['--profile-dir=' + profile], env, timeout: 60000 });
  let page = application.context().pages().find(candidate => candidate.url() === 'autosell://app/index.html');
  if (!page) page = await application.waitForEvent('window', candidate => candidate.url() === 'autosell://app/index.html');
  await page.waitForFunction(() => Boolean(window.desktop), { timeout: 30000 });
  return page;
}
async function unlock(page) {
  if (await page.getByLabel('Vault passphrase', { exact: true }).count()) {
    await page.getByLabel('Vault passphrase', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  }
  await waitFor(page, current => current.backend.phase === 'ready', 120000);
}
(async () => {
  fs.mkdirSync(profile, { recursive: true });
  let page = await launch();
  await unlock(page);
  const before = await state(page);
  if (!before.updates || before.updates.phase === 'unconfigured') throw Error('The installed build has no signed update configuration');
  await page.getByRole('button', { name: 'Updates & settings', exact: true }).click();
  if (channel === 'beta') await page.getByLabel('Channel', { exact: true }).selectOption('beta');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  const checked = await waitFor(page, current => ['downloaded', 'current', 'error', 'waiting'].includes(current.updates.phase));
  if (checked.updates.phase !== 'downloaded') throw Error('Update check did not reach a verified download: ' + JSON.stringify(checked.updates));
  if (checked.updates.latestVersion !== target) throw Error('Published update version ' + checked.updates.latestVersion + ' does not match expected ' + target);
  const marker = path.join(profile, 'workspace', 'data', 'signed-acceptance-marker.txt');
  const database = path.join(profile, 'workspace', 'data', 'autosell.db');
  fs.writeFileSync(marker, 'signed A-to-B acceptance ' + new Date().toISOString());
  if (!fs.existsSync(database)) throw Error('Workspace database was not created before update');
  const databaseBytes = fs.statSync(database).size;
  await page.getByRole('button', { name: 'Restart and install safely', exact: true }).click();
  await application.process().exitCode;
  application = null;
  // The updater may auto-launch the new build. Stop only that installed test
  // process, then launch it under Playwright with the same generated profile.
  spawnSync('taskkill', ['/IM', 'Autosell V3.exe', '/F', '/T'], { windowsHide: true, stdio: 'ignore' });
  page = await launch();
  const installed = await application.evaluate(({ app }) => app.getVersion());
  if (installed !== target) throw Error('Installed version ' + installed + ' does not match target ' + target);
  await unlock(page);
  if (!fs.existsSync(marker) || !fs.existsSync(database)) throw Error('Workspace data was not retained across the signed update');
  const outcome = { passed: true, executable, profile, channel, target, installedVersion: installed, databaseBytes, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(results, 'signed-update-acceptance.json'), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify(outcome, null, 2));
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await application.close().catch(() => {});
})().catch(async error => {
  fs.writeFileSync(path.join(results, 'signed-update-acceptance.json'), JSON.stringify({ passed: false, error: error.message, executable, profile, target, checkedAt: new Date().toISOString() }, null, 2));
  console.error(error);
  if (application) await application.close().catch(() => {});
  process.exitCode = 1;
});
