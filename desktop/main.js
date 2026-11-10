'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, session, shell, dialog, Menu, Tray, safeStorage, screen, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Supervisor, runtimeEnvironment } = require('./lib/supervisor');
const { Updates } = require('./lib/updates');
const security = require('./lib/security');
const saved = require('./lib/state');
const releaseConfig = require('./release-config.json');
const { autoUpdater } = require('electron-updater');

protocol.registerSchemesAsPrivileged([{ scheme: 'autosell', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Autosell V3');
const override = app.commandLine.getSwitchValue('profile-dir');
if (override && !path.isAbsolute(override)) throw Error('Profile directory must be absolute');
const directory = override || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Autosell V3');
app.setPath('userData', path.join(directory, 'desktop'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
saved.write(path.join(directory, 'desktop-owner.json'), { appId: 'gg.autosell.desktop' });
const workspace = path.join(directory, 'workspace');
const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(__dirname, 'staging');
const backend = new Supervisor(runtime, workspace);
let window, tray, updates, passphrase = '', attempts = 0, quitting = false, closing = false, starting = false, importing = false, retryTimer;
let dashboardView, selectedTab = 'dashboard';
const status = { phase: 'starting', reason: 'Preparing your workspace…', origin: '', maintenance: null };
const preferenceFile = path.join(directory, 'window.json');
const onboardingFile = path.join(directory, 'onboarding.json');
const credentialFile = path.join(directory, 'vault.dpapi');
const diagnosticFile = path.join(directory, 'desktop-diagnostics.json');
let startupDiagnostic = '';
function diagnose(event, message) {
  const entries = saved.read(diagnosticFile, []);
  const recent = Array.isArray(entries) ? entries.slice(-199) : [];
  recent.push({ at: new Date().toISOString(), event, message });
  try { saved.write(diagnosticFile, recent); } catch {}
}
function migrationPending() {
  const journal = path.join(workspace + '.migration', 'migration.json');
  if (!fs.existsSync(journal)) return false;
  return saved.read(journal).phase !== 'COMMITTED';
}
function snapshot() {
  return { backend: status, updates: updates?.state, selectedTab, version: app.getVersion(), migrationPending: migrationPending(), hasWorkspace: fs.existsSync(path.join(workspace, 'data', 'autosell.db')), onboarded: saved.read(onboardingFile).complete === true, canRemember: safeStorage.isEncryptionAvailable() };
}
function placeDashboard() {
  if (!dashboardView || !window || window.isDestroyed()) return;
  const { width, height } = window.getContentBounds();
  dashboardView.setBounds({ x: 0, y: 68, width, height: Math.max(0, height - 68) });
  dashboardView.setVisible(status.phase === 'ready' && selectedTab === 'dashboard');
}
function publish(patch = {}) {
  Object.assign(status, patch);
  placeDashboard();
  if (window && !window.isDestroyed()) window.webContents.send('desktop:state', snapshot());
}
function showWindow() { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function saveWindow() {
  if (!window || window.isDestroyed()) return;
  saved.write(preferenceFile, { bounds: window.getNormalBounds(), maximized: window.isMaximized() });
}
function secureSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const local = url.protocol === 'autosell:' && url.hostname === 'app';
    const dashboard = backend.origin && url.origin === backend.origin;
    const font = url.protocol === 'https:' && ['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.cdnfonts.com', 'cdn.jsdelivr.net'].includes(url.hostname) && ['font', 'stylesheet'].includes(details.resourceType);
    callback({ cancel: !(local || dashboard || font || details.url === 'about:blank' || ['data:', 'blob:', 'devtools:'].includes(url.protocol)) });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers['X-Autosell-Desktop'];
    delete headers['x-autosell-desktop'];
    if (backend.origin && new URL(details.url).origin === backend.origin && details.webContentsId === dashboardView?.webContents.id) headers['X-Autosell-Desktop'] = backend.token;
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    if (backend.origin && new URL(details.url).origin === backend.origin) {
      responseHeaders['Content-Security-Policy'] = ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.cdnfonts.com https://cdn.jsdelivr.net; font-src 'self' data: https://fonts.gstatic.com https://fonts.cdnfonts.com https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors autosell://app; form-action 'self'"];
    }
    callback({ responseHeaders });
  });
}
function createWindow() {
  const previous = saved.read(preferenceFile);
  let bounds = previous.bounds || { width: 1440, height: 940 };
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) bounds = { width: 1440, height: 940 };
  bounds.width = Math.max(1000, Math.min(3840, bounds.width));
  bounds.height = Math.max(700, Math.min(2160, bounds.height));
  if (Number.isFinite(bounds.x) && !screen.getAllDisplays().some(display => bounds.x < display.bounds.x + display.bounds.width && bounds.x + bounds.width > display.bounds.x && bounds.y < display.bounds.y + display.bounds.height && bounds.y + bounds.height > display.bounds.y)) { delete bounds.x; delete bounds.y; }
  window = new BrowserWindow({ ...bounds, minWidth: 1000, minHeight: 700, show: false, title: 'Autosell V3', backgroundColor: '#080b12', icon: path.join(__dirname, 'assets/icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false } });
  // A sibling WebContentsView keeps the existing strict dashboard session cookies
  // first-party and never gives the backend page a desktop preload or IPC bridge.
  dashboardView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false } });
  window.contentView.addChildView(dashboardView);
  placeDashboard();
  window.on('resize', placeDashboard);
  dashboardView.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(security.externalUrl(url)).catch(() => {}); } catch {}
    return { action: 'deny' };
  });
  dashboardView.webContents.on('will-frame-navigate', event => {
    if (event.url === 'about:blank') return;
    if (!backend.origin || new URL(event.url).origin !== backend.origin) event.preventDefault();
  });
  dashboardView.webContents.on('will-attach-webview', event => event.preventDefault());
  dashboardView.webContents.on('render-process-gone', () => { if (backend.origin) dashboardView.webContents.loadURL(backend.origin).catch(() => {}); });
  dashboardView.webContents.loadURL('about:blank');
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(security.externalUrl(url)).catch(() => {}); } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (url !== 'autosell://app/index.html') event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => {
    const url = new URL(event.url);
    if (event.isMainFrame ? event.url !== 'autosell://app/index.html' : !(backend.origin && url.origin === backend.origin)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    // Renderer replacement never restarts a financial worker.
    window.loadURL('autosell://app/index.html');
  });
  window.once('ready-to-show', () => { if (previous.maximized) window.maximize(); window.show(); });
  window.on('close', event => {
    saveWindow();
    if (!quitting) { event.preventDefault(); window.hide(); }
  });
  window.loadURL('autosell://app/index.html');
  tray = new Tray(path.join(__dirname, 'assets/icon.ico'));
  tray.setToolTip('Autosell V3 — backend stays active when the window is closed');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Autosell V3', click: showWindow }, { label: 'Exit safely', click: () => safeQuit().catch(error => { showWindow(); publish({ reason: error.message }); }) }]));
  tray.on('double-click', showWindow);
}
async function refreshMaintenance() {
  if (!backend.child || !backend.origin) return;
  try { publish({ maintenance: await backend.control('status') }); } catch {}
}
async function startBackend(secret, recovery = false) {
  if (starting || importing || backend.child) throw Error('Workspace initialization is already in progress');
  if (migrationPending()) throw Error('Finish the interrupted import. Choose the original installation folder again to resume verification.');
  starting = true;
  startupDiagnostic = '';
  diagnose('backend-start', recovery ? 'Starting under the recovery maintenance fence' : 'Opening the configured workspace');
  passphrase = secret || passphrase;
  fs.mkdirSync(workspace, { recursive: true });
  publish({ phase: 'starting', reason: 'Opening the vault and payment journals…', origin: '' });
  try {
    await backend.start(passphrase, recovery);
    if (backend.ready.version !== app.getVersion()) throw Error('Bundled backend version does not match the desktop application');
    const health = await fetch(backend.origin + '/api/auth/status', { headers: { 'X-Autosell-Desktop': backend.token }, signal: AbortSignal.timeout(15000) });
    if (!health.ok || typeof (await health.json()).setupRequired !== 'boolean') throw Error('Backend readiness verification failed');
    await dashboardView.webContents.loadURL(backend.origin);
    publish({ phase: 'ready', reason: '', origin: backend.origin });
    saved.write(onboardingFile, { complete: true });
    await updates.validateRestart();
    await refreshMaintenance();
    diagnose('backend-ready', 'Authenticated dashboard and backend version verified');
    setTimeout(() => updates.check().catch(() => {}), 15000).unref();
  } catch (error) {
    const reason = startupDiagnostic || error.message;
    diagnose('backend-start-failed', reason);
    publish({ phase: 'error', reason, origin: '' });
    throw Error(reason);
  }
  finally { starting = false; }
}
async function safeQuit() {
  if (closing) return;
  if (importing) throw Error('Wait for the workspace import to finish before exiting');
  closing = true;
  try {
    clearTimeout(retryTimer);
    if (backend.child) {
      publish({ reason: 'Waiting for deliveries to reach a safe shutdown boundary…' });
      const result = await backend.control('maintenance', { reason: 'shutdown' });
      if (result.safe !== true) { showWindow(); publish({ maintenance: result }); throw Error(result.reason || 'Active or uncertain payments are holding shutdown. Review maintenance in Updates.'); }
      await backend.stop();
    }
    saveWindow();
    quitting = true;
    app.quit();
  } finally { closing = false; }
}
function registerIpc() {
  const handle = (name, handler) => ipcMain.handle(name, async (event, ...args) => {
    if (!security.trustedFrame(event, window)) throw Error('Desktop IPC requires the trusted main window');
    return handler(...args);
  });
  handle('desktop:state', () => snapshot());
  handle('desktop:start', async value => {
    const minimumLength = fs.existsSync(path.join(workspace, 'data', 'vault.enc')) ? 1 : 12;
    if (!value || typeof value.passphrase !== 'string' || value.passphrase.length < minimumLength || value.passphrase.length > 1024 || typeof value.remember !== 'boolean') throw Error('Enter the existing vault passphrase, or at least 12 characters for a new workspace');
    if (backend.child || starting) throw Error('Backend is already running');
    await startBackend(value.passphrase, attempts > 0);
    if (value.remember) {
      if (!safeStorage.isEncryptionAvailable()) throw Error('Windows credential protection is unavailable');
      fs.writeFileSync(credentialFile, safeStorage.encryptString(value.passphrase), { mode: 0o600 });
    } else if (fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
    return snapshot();
  });
  handle('desktop:import', async () => {
    if (backend.child || starting || importing || (!migrationPending() && fs.existsSync(path.join(workspace, 'data', 'autosell.db')))) throw Error('Import requires an available workspace and a stopped backend');
    importing = true;
    try {
    const selected = await dialog.showOpenDialog(window, { title: 'Choose your previous Autosell installation folder', properties: ['openDirectory'] });
    if (selected.canceled) return { canceled: true };
    publish({ phase: 'importing', reason: 'Verifying the backup and importing your existing workspace…' });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(path.join(runtime, 'node/Autosell-Worker.exe'), [path.join(runtime, 'backend/ops/desktop-migration.js'), selected.filePaths[0], workspace], { windowsHide: true, env: runtimeEnvironment(runtime, workspace, '', '', false), stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.resume();
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve({ imported: true }) : reject(Error('Import failed. Stop the original backend and check migration diagnostics before retrying.')));
    }).catch(error => { publish({ phase: 'setup', reason: error.message }); throw error; });
    publish({ phase: 'unlock', reason: 'Workspace imported. Enter its existing vault passphrase.' });
    return result;
    } finally { importing = false; }
  });
  handle('desktop:action', async action => {
    if (typeof action !== 'string') throw Error('Invalid desktop action');
    switch (action) {
      case 'channel-stable': updates.selectChannel('stable'); break;
      case 'channel-beta': updates.selectChannel('beta'); break;
      case 'show-dashboard': selectedTab = 'dashboard'; publish(); break;
      case 'show-updates': selectedTab = 'updates'; publish(); break;
      case 'check': await updates.check(); break;
      case 'download': await updates.download(); break;
      case 'install': await updates.requestInstall(); break;
      case 'cancel-update': await updates.cancel(); break;
      case 'resume': {
        const result = await backend.control('resume');
        if (result.safe !== true) throw Error(result.reason || 'Reconcile pending payments before resuming');
        await refreshMaintenance(); break;
      }
      case 'open-data': await shell.openPath(workspace); break;
      case 'open-mods': await shell.openPath(path.join(runtime, 'backend/release')); break;
      case 'quit': await safeQuit(); break;
      default: throw Error('Unknown desktop action');
    }
    return snapshot();
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); safeQuit().catch(error => { showWindow(); publish({ reason: error.message }); }); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    app.setAppUserModelId('gg.autosell.desktop');
    protocol.handle('autosell', request => {
      const url = new URL(request.url);
      const files = { '/index.html': 'text/html', '/shell.js': 'text/javascript', '/shell.css': 'text/css' };
      if (url.hostname !== 'app' || !files[url.pathname]) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(path.join(__dirname, 'ui', url.pathname.slice(1))), { headers: { 'Content-Type': files[url.pathname] + '; charset=utf-8' } });
    });
    secureSession();
    updates = new Updates({ updater: autoUpdater, config: releaseConfig, version: app.getVersion(), directory, backend, packaged: app.isPackaged, install: () => { quitting = true; autoUpdater.quitAndInstall(false, true); } });
    updates.on('change', () => publish());
    backend.on('diagnostic', chunk => {
      // Only recognized categories reach the desktop journal. Raw backend output
      // can contain account identifiers and must stay out of the shell/renderer.
      if (/EADDRINUSE/.test(chunk)) startupDiagnostic = 'The Minecraft bridge port is already in use. Exit the previous Autosell backend safely before opening this workspace.';
      else if (/Invalid passphrase|vault passphrase required|VAULT_PASSPHRASE/i.test(chunk)) startupDiagnostic = 'The vault could not be unlocked. Enter the passphrase used by this workspace.';
      else if (/Another Autosell process|workspace was migrated/i.test(chunk)) startupDiagnostic = 'This workspace is already running or was retired by migration. Open the active desktop instance.';
      else if (/SQLITE_CORRUPT|database disk image is malformed/i.test(chunk)) startupDiagnostic = 'SQLite reported damaged data. Preserve the workspace and restore a verified backup after reconciling payment history.';
    });
    backend.on('slow-start', () => {
      diagnose('backend-slow-start', 'The backend remains alive and supervised after the readiness deadline');
      publish({ phase: 'starting', reason: 'Startup is taking longer than expected. Autosell is still waiting for its backend to finish safely.' });
    });
    backend.on('exit', info => {
      diagnose('backend-exit', 'Exit code ' + info.code + ', signal ' + info.signal + ', expected ' + info.expected + ', previously ready ' + info.wasReady);
      if (info.expected || quitting) return;
      publish({ phase: 'error', origin: '', reason: 'The backend stopped. Payment journals will be reconciled before activity resumes.' });
      if (info.wasReady && attempts < 3) {
        attempts++;
        retryTimer = setTimeout(() => startBackend(passphrase, true).catch(() => {}), 5000 * attempts);
      }
    });
    registerIpc();
    createWindow();
    powerMonitor.on('shutdown', event => { if (backend.child) { event.preventDefault(); safeQuit().catch(error => { showWindow(); publish({ reason: error.message }); }); } });
    const poll = setInterval(async () => {
      if (updates.state.phase === 'waiting') await updates.requestInstall().catch(error => publish({ reason: error.message }));
      await refreshMaintenance();
    }, 15000);
    poll.unref();
    const autoCheck = setInterval(() => updates.check().catch(() => {}), 6 * 60 * 60 * 1000);
    autoCheck.unref();
    if (fs.existsSync(credentialFile) && safeStorage.isEncryptionAvailable()) {
      try { await startBackend(safeStorage.decryptString(fs.readFileSync(credentialFile))); return; } catch {}
    }
    publish({ phase: saved.read(onboardingFile).complete ? 'unlock' : 'setup', reason: '' });
  }).catch(error => { dialog.showErrorBox('Autosell V3 startup failed', error.message); quitting = true; app.quit(); });
}
