'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const desktop = path.resolve(__dirname, '..');
const root = path.dirname(desktop);
const staging = path.join(desktop, 'staging');
const backend = path.join(staging, 'backend');
const nodeVersion = '24.22.0';
const nodeHash = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3';
const roots = ['api', 'audit', 'db', 'discord', 'ledger', 'marketplace', 'minecraft', 'ops', 'payments', 'sell', 'services', 'settings', 'treasury', 'v3', 'vault', 'wallet', 'web'];
const files = ['index.js', 'config.js', 'constants.js', 'services.js', 'package.json', 'package-lock.json', 'THIRD-PARTY-NOTICES.txt'];
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw result.error || Error('Build command failed with exit code ' + result.status);
}
function copy(source, destination) {
  fs.cpSync(source, destination, { recursive: true, filter: file => !fs.lstatSync(file).isSymbolicLink() });
}
function resetBackend() {
  if (path.dirname(backend) !== staging || path.dirname(staging) !== desktop) throw Error('Unsafe staging path');
  fs.rmSync(backend, { recursive: true, force: true });
  fs.mkdirSync(backend, { recursive: true });
  for (const entry of [...roots, ...files]) copy(path.join(root, entry), path.join(backend, entry));
  for (const entry of ['release/SHA256SUMS', 'release/autosell-bridge-3.0.0.jar', 'release/fabric-api-0.165.2+26.3.jar', 'windows/install-client.ps1', 'windows/verify-release.ps1']) {
    fs.mkdirSync(path.dirname(path.join(backend, entry)), { recursive: true });
    copy(path.join(root, entry), path.join(backend, entry));
  }
}
async function prepareNode() {
  const cache = path.join(desktop, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, 'node-v' + nodeVersion + '-win-x64.zip');
  if (!fs.existsSync(archive)) {
    const response = await fetch('https://nodejs.org/dist/v' + nodeVersion + '/node-v' + nodeVersion + '-win-x64.zip');
    if (!response.ok) throw Error('Node download failed ' + response.status);
    await pipeline(response.body, fs.createWriteStream(archive + '.tmp'));
    fs.renameSync(archive + '.tmp', archive);
  }
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (actualHash !== nodeHash) throw Error('Bundled Node archive SHA256 verification failed');
  const unpacked = path.join(cache, 'node-v' + nodeVersion + '-win-x64');
  if (!fs.existsSync(path.join(unpacked, 'node.exe'))) {
    const quoted = value => "'" + value.replaceAll("'", "''") + "'";
    run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath ' + quoted(archive) + ' -DestinationPath ' + quoted(cache) + ' -Force']);
  }
  fs.mkdirSync(path.join(staging, 'node'), { recursive: true });
  const executable = path.join(staging, 'node', 'Autosell-Worker.exe');
  copy(path.join(unpacked, 'node.exe'), executable);
  copy(path.join(unpacked, 'LICENSE'), path.join(staging, 'node', 'LICENSE'));
  fs.rmSync(path.join(staging, 'node', 'node.exe'), { force: true });
  return executable;
}
function createIcon() {
  const { PNG } = require(path.join(root, 'node_modules/pngjs'));
  const png = new PNG({ width: 256, height: 256 });
  function polygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    const mark = polygon(x, y, [[122, 48], [149, 48], [221, 205], [177, 205], [134, 103], [89, 205], [45, 205]]) || polygon(x, y, [[102, 150], [163, 150], [179, 185], [86, 185]]);
    const edge = Math.hypot(Math.max(32 - x, x - 223, 0), Math.max(32 - y, y - 223, 0)) <= 32;
    png.data.set(mark ? [244, 63, 94, 255] : [11, 15, 24, edge ? 255 : 0], i);
  }
  const image = PNG.sync.write(png);
  fs.writeFileSync(path.join(desktop, 'assets/icon.png'), image);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(desktop, 'assets/icon.ico'), Buffer.concat([header, image]));
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Package on Windows x64');
  const backendPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
  if (backendPackage.version !== desktopPackage.version) throw Error('Backend and desktop versions must match');
  resetBackend();
  const node = await prepareNode();
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  run(process.execPath, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: backend });
  const browsers = path.join(staging, 'browsers');
  run(node, [path.join(backend, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers } });
  run(node, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE TABLE check_runtime(value)');d.close();console.log('Bundled Node '+process.version+' SQLite ready')"]);
  createIcon();
  fs.writeFileSync(path.join(staging, 'runtime.json'), JSON.stringify({ node: nodeVersion, nodeArchiveSha256: nodeHash, version: backendPackage.version, playwright: backendPackage.dependencies.playwright }, null, 2));
  console.log('Staged backend, verified Node, Chromium and both Fabric JARs.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
