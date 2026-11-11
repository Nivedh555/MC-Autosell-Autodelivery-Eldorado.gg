'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeEnvironment } = require('../lib/supervisor');
const { prepare } = require('../../marketplace/browser/chrome-profiles');

test('packaged worker environment retains system Chrome discovery paths', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autosell-chrome-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chrome = path.join(directory, 'programs', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const profiles = path.join(directory, 'profiles');
  fs.mkdirSync(path.dirname(chrome), { recursive: true });
  fs.writeFileSync(chrome, 'fixture: never executed');
  fs.mkdirSync(path.join(profiles, 'Profile 1'), { recursive: true });
  fs.writeFileSync(path.join(profiles, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Fixture seller' } } } }));
  const prior = process.env.ProgramFiles;
  process.env.ProgramFiles = path.join(directory, 'programs');
  try {
  const env = runtimeEnvironment(directory, directory, 'fixture', '', false);
  assert.equal(env.ProgramFiles, path.join(directory, 'programs'));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.ok(env.PATH.includes(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')));
  const result = await prepare('Profile 1', { mode: 'attach', root: profiles, processes: [] });
  assert.equal(result.executable, chrome);
  assert.equal(result.selectable, true);
  } finally { if (prior === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = prior; }
});
