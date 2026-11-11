'use strict';
const byId = id => document.getElementById(id);
let state, tab = 'dashboard', busy = false;
const labels = { idle: 'Ready to check for updates', unconfigured: 'Automatic updates are unavailable in this installation', checking: 'Checking for updates…', current: 'You are up to date.', available: 'An update is available', downloading: 'Downloading update…', downloaded: 'Download complete. Ready to restart.', waiting: 'Waiting for active deliveries to finish.', installing: 'Installing update…', installed: 'Update successfully installed.', error: 'Update needs attention', recovery: 'Update recovery requires attention' };
function showError(error) { byId('notice').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); byId('notice').hidden = false; }
async function run(operation) {
  if (busy) return;
  busy = true;
  byId('notice').hidden = true;
  byId('start-button').disabled = true;
  byId('import-button').disabled = true;
  try { await operation(); render(await window.desktop.getState()); } catch (error) { showError(error); }
  finally { busy = false; byId('start-button').disabled = false; byId('import-button').disabled = false; }
}
function render(next) {
  state = next;
  tab = next.selectedTab || 'dashboard';
  const backend = state.backend;
  const ready = backend.phase === 'ready';
  byId('connection').textContent = ready ? 'Delivery service connected' : ({ starting: 'Starting delivery service…', importing: 'Importing workspace…', error: 'Delivery service needs attention' }[backend.phase] || 'Workspace locked');
  byId('startup').hidden = ready || tab !== 'dashboard';
  byId('updates').hidden = tab !== 'updates';
  byId('dashboard-tab').setAttribute('aria-pressed', String(tab === 'dashboard'));
  byId('updates-tab').setAttribute('aria-pressed', String(tab === 'updates'));
  byId('startup-title').textContent = ({ setup: 'Welcome to Autosell V3', unlock: 'Unlock your workspace', starting: 'Starting Autosell V3', importing: 'Importing your workspace', error: 'Let’s get your workspace running' })[backend.phase] || 'Autosell V3';
  byId('startup-reason').textContent = backend.reason || (state.migrationPending ? 'An interrupted import needs to finish. Select the original installation folder again.' : state.hasWorkspace ? 'Enter your existing vault passphrase to continue.' : 'Create your protected workspace or import an existing installation.');
  byId('import-section').hidden = (state.hasWorkspace && !state.migrationPending) || ['starting', 'importing'].includes(backend.phase);
  byId('unlock-form').hidden = state.migrationPending || ['starting', 'importing'].includes(backend.phase);
  byId('import-button').textContent = state.migrationPending ? 'Resume existing import' : 'Import existing installation';
  byId('remember').disabled = !state.canRemember;
  byId('passphrase').minLength = state.hasWorkspace ? 1 : 12;
  const update = state.updates || {};
  byId('update-status').textContent = labels[update.phase] || 'Update status unavailable';
  byId('update-reason').textContent = update.reason || '';
  byId('update-error').textContent = update.error || '';
  byId('installed').textContent = update.installedVersion || state.version;
  byId('latest').textContent = update.latestVersion || 'Awaiting release check';
  byId('last-check').textContent = update.lastCheck ? new Date(update.lastCheck).toLocaleString() : 'No check yet';
  byId('channel').value = update.channel || 'stable';
  byId('channel').disabled = ['checking', 'available', 'downloading', 'downloaded', 'waiting', 'installing'].includes(update.phase);
  byId('check-button').disabled = ['unconfigured', 'checking', 'downloading', 'waiting', 'installing'].includes(update.phase);
  byId('download-progress').hidden = update.phase !== 'downloading';
  byId('progress').value = update.progress || 0;
  byId('progress-text').textContent = Math.floor(update.progress || 0) + '% · ' + Math.round((update.transferred || 0) / 1048576) + ' of ' + Math.round((update.total || 0) / 1048576) + ' MB';
  byId('install-button').hidden = update.phase !== 'downloaded';
  byId('install-button').disabled = !ready;
  byId('retry-button').hidden = update.phase !== 'error';
  byId('cancel-button').hidden = update.phase !== 'waiting';
  byId('release-notes').hidden = !update.releaseNotes;
  byId('notes').textContent = update.releaseNotes || '';
  const maintenance = backend.maintenance;
  byId('maintenance-card').hidden = !maintenance || !(maintenance.active || maintenance.reasons?.length);
  byId('maintenance-reason').textContent = maintenance?.reason || 'New payments are paused. Review unfinished payments before resuming.';
  if (ready && backend.reason) showError(backend.reason);
}
byId('dashboard-tab').onclick = () => run(() => window.desktop.action('show-dashboard'));
byId('updates-tab').onclick = () => run(() => window.desktop.action('show-updates'));
byId('unlock-form').onsubmit = event => {
  event.preventDefault();
  const passphrase = byId('passphrase').value;
  byId('passphrase').value = '';
  run(() => window.desktop.start({ passphrase, remember: byId('remember').checked }));
};
byId('import-button').onclick = () => run(() => window.desktop.importWorkspace());
byId('channel').onchange = event => run(() => window.desktop.action('channel-' + event.target.value));
for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => run(() => window.desktop.action(button.dataset.action));
window.desktop.onState(render);
window.desktop.getState().then(render).catch(showError);
