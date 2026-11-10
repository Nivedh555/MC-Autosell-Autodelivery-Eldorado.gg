'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { verifyManifest, verifyUpdateInfo } = require('./security');
const state = require('./state');
class Updates extends EventEmitter {
  constructor({ updater, config, version, directory, backend, install, packaged }) {
    super();
    Object.assign(this, { updater, config, version, directory, backend, install });
    this.journalFile = path.join(directory, 'update-journal.json');
    this.channelFile = path.join(directory, 'update-preferences.json');
    const previous = state.read(this.channelFile);
    const channel = ['stable', 'beta'].includes(previous.channel) ? previous.channel : config.channel;
    this.state = { installedVersion: version, latestVersion: null, channel, lastCheck: previous.lastCheck || null, phase: 'idle', progress: 0, releaseNotes: '', error: '', reason: '' };
    this.enabled = Boolean(packaged && config.enabled && config.publisherName && config.metadataPublicKey);
    if (!this.enabled) Object.assign(this.state, { phase: 'unconfigured', reason: config.reason || 'This development build has no production signing configuration.' });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = channel === 'beta';
    updater.on('checking-for-update', () => this.set({ phase: 'checking', error: '' }));
    updater.on('download-progress', progress => this.set({ phase: 'downloading', progress: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond }));
    updater.on('update-not-available', () => this.set({ phase: 'current' }));
    updater.on('error', error => this.fail(error));
    updater.on('update-downloaded', info => {
      try {
        verifyUpdateInfo(info, this.manifest);
        this.set({ phase: 'downloaded', progress: 100, latestVersion: info.version });
      } catch (error) { this.fail(error); }
    });
  }
  set(patch) { Object.assign(this.state, patch); this.emit('change', this.state); }
  fail(error) { this.set({ phase: 'error', error: String(error.message || error).slice(0, 1000) }); }
  selectChannel(channel) {
    if (!['stable', 'beta'].includes(channel)) throw Error('Invalid update channel');
    if (['checking', 'available', 'downloading', 'downloaded', 'waiting', 'installing'].includes(this.state.phase)) throw Error('Finish the pending update before changing channels');
    this.updater.allowPrerelease = channel === 'beta';
    this.manifest = null;
    state.write(this.channelFile, { channel, lastCheck: null });
    this.set({ channel, lastCheck: null, phase: this.enabled ? 'idle' : 'unconfigured', latestVersion: null, releaseNotes: '', error: '', progress: 0 });
  }
  async manifestBase() {
    const repository = this.config.owner + '/' + this.config.repo;
    if (this.state.channel === 'stable') return 'https://github.com/' + repository + '/releases/latest/download/';
    const response = await fetch('https://api.github.com/repos/' + repository + '/releases?per_page=100', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('GitHub could not list beta releases');
    const candidates = (await response.json()).filter(item => !item.draft && item.prerelease && /^v\d+\.\d+\.\d+-beta\.\d+$/.test(item.tag_name));
    candidates.sort((a, b) => require('semver').rcompare(a.tag_name.slice(1), b.tag_name.slice(1)));
    if (!candidates.length) throw Error('No public beta release is available yet');
    return 'https://github.com/' + repository + '/releases/download/' + candidates[0].tag_name + '/';
  }
  async check() {
    if (!this.enabled) throw Error(this.state.reason);
    if (['checking', 'downloading', 'downloaded', 'waiting', 'installing'].includes(this.state.phase)) return this.state;
    this.set({ phase: 'checking', lastCheck: new Date().toISOString(), error: '', reason: '' });
    try {
      state.write(this.channelFile, { channel: this.state.channel, lastCheck: this.state.lastCheck });
      const base = await this.manifestBase();
      const filename = this.state.channel + '-manifest.json';
      const responses = await Promise.all([fetch(base + filename, { signal: AbortSignal.timeout(30000) }), fetch(base + filename + '.sig', { signal: AbortSignal.timeout(30000) })]);
      if (responses.some(response => !response.ok)) throw Error('The publisher has not published a signed release manifest for this channel');
      const bytes = Buffer.from(await responses[0].arrayBuffer());
      const signature = await responses[1].text();
      this.manifest = verifyManifest(bytes, signature, this.config.metadataPublicKey, this.state.channel, this.version);
      this.set({ latestVersion: this.manifest.version, releaseNotes: String(this.manifest.releaseNotes || '').slice(0, 100000) });
      if (this.manifest.version === this.version) { this.set({ phase: 'current' }); return this.state; }
      const url = 'https://github.com/' + this.config.owner + '/' + this.config.repo + '/releases/download/v' + this.manifest.version + '/';
      this.updater.setFeedURL({ provider: 'generic', url, channel: this.state.channel === 'beta' ? 'beta' : 'latest' });
      const checked = await this.updater.checkForUpdates();
      verifyUpdateInfo(checked.updateInfo, this.manifest);
      this.set({ phase: 'available' });
      await this.download();
      return this.state;
    } catch (error) { this.fail(error); throw error; }
  }
  async download() {
    if (!this.manifest || !['available', 'error'].includes(this.state.phase)) throw Error('Check for an update before downloading');
    this.set({ phase: 'downloading', error: '', progress: 0 });
    try { await this.updater.downloadUpdate(); } catch (error) { this.fail(error); throw error; }
  }
  async requestInstall() {
    if (this.installationInProgress) return this.state;
    if (!['downloaded', 'waiting'].includes(this.state.phase)) throw Error('A verified update must finish downloading first');
    this.installationInProgress = true;
    try {
    this.set({ phase: 'waiting', reason: 'Waiting for active deliveries to finish.' });
    const status = await this.backend.control('maintenance', { targetVersion: this.state.latestVersion, reason: 'update' });
    if (status.safe !== true) { this.set({ reason: status.reason || 'An executing or uncertain payment is holding this update.' }); return this.state; }
    await this.finishInstall();
    return this.state;
    } finally { this.installationInProgress = false; }
  }
  async finishInstall() {
    // Backend status is rechecked after the persistent fence, immediately before shutdown.
    const status = await this.backend.control('status');
    if (status.safe !== true) { this.set({ phase: 'waiting', reason: status.reason || 'Payments require operator attention.' }); return; }
    state.write(this.journalFile, { from: this.version, target: this.state.latestVersion, requestedAt: new Date().toISOString(), phase: 'installing' });
    await this.backend.stop();
    this.set({ phase: 'installing', reason: 'Installing update…' });
    this.install();
  }
  async cancel() {
    if (this.state.phase !== 'waiting') throw Error('No installation is waiting');
    const result = await this.backend.control('resume');
    if (result.safe !== true) throw Error(result.reason || 'Backend requires reconciliation before resuming');
    this.set({ phase: 'downloaded', reason: '' });
  }
  async validateRestart() {
    const journal = state.read(this.journalFile, null);
    if (!journal || journal.phase !== 'installing') return;
    if (journal.target !== this.version) {
      this.set({ phase: 'recovery', reason: 'The prior update did not reach its target version. Inspect the release and maintenance status before resuming.' });
      return;
    }
    const status = await this.backend.control('status');
    if (status.targetVersion !== journal.target || status.safe !== true) {
      this.set({ phase: 'recovery', reason: status.reason || 'The persisted maintenance target does not match this installation.' });
      return;
    }
    const result = await this.backend.control('resume');
    if (result.safe !== true) { this.set({ phase: 'recovery', reason: result.reason || 'Reconcile unfinished payments before resuming.' }); return; }
    state.write(this.journalFile, { ...journal, phase: 'validated', validatedAt: new Date().toISOString() });
    this.set({ phase: 'installed', reason: 'Update successfully installed.' });
  }
}
module.exports = { Updates };
