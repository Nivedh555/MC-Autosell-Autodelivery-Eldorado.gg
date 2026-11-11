'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const desktop = path.resolve(__dirname, '..');
const root = path.dirname(desktop);
const version = require('../package.json').version;
const backend = require(path.join(root, 'package.json'));
if (backend.version !== version) throw Error('Root and desktop package versions must match');
if (process.env.GITHUB_REF !== 'refs/tags/v' + version) throw Error('Release tag must match the desktop package version');
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw Error('Use a semantic version or X.Y.Z-beta.N');
const channel = version.includes('-beta.') ? 'beta' : 'stable';
const provider = process.env.AUTOSELL_SIGNING_PROVIDER || 'pfx';
if (!['azure', 'pfx'].includes(provider)) throw Error('AUTOSELL_SIGNING_PROVIDER must be azure or pfx');
const publisherName = String(process.env.AUTOSELL_PUBLISHER_NAME || '').trim();
if (!publisherName || /[\r\n]/.test(publisherName)) throw Error('AUTOSELL_PUBLISHER_NAME must be the exact certificate publisher');
for (const name of ['AUTOSELL_UPDATE_PUBLIC_KEY', 'AUTOSELL_UPDATE_PRIVATE_KEY']) {
  if (!process.env[name]) throw Error('Protected release configuration is missing ' + name);
}
if (provider === 'pfx') {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
    if (!process.env[name]) throw Error('Protected PFX release configuration is missing ' + name);
  }
} else {
  for (const name of ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE']) {
    if (!process.env[name]) throw Error('Azure signing configuration is missing ' + name);
  }
  const endpoint = new URL(process.env.AZURE_SIGNING_ENDPOINT);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw Error('AZURE_SIGNING_ENDPOINT must be a plain HTTPS URL');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/.test(process.env.AZURE_SIGNING_ACCOUNT)) throw Error('AZURE_SIGNING_ACCOUNT is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/.test(process.env.AZURE_SIGNING_PROFILE)) throw Error('AZURE_SIGNING_PROFILE is invalid');
  if (!process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET) {
    throw Error('Azure signing requires AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET');
  }
}
const publicKey = crypto.createPublicKey(process.env.AUTOSELL_UPDATE_PUBLIC_KEY);
const privateKey = crypto.createPrivateKey(process.env.AUTOSELL_UPDATE_PRIVATE_KEY);
if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519') throw Error('Release metadata requires Ed25519 keys');
const probe = Buffer.from('Autosell release-key check');
if (!crypto.verify(null, probe, publicKey, crypto.sign(null, probe, privateKey))) throw Error('Metadata signing key does not match public key');
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== 'v' + version) throw Error('GitHub tag name does not match the package version');
const config = {
  enabled: true,
  owner: 'Nivedh555',
  repo: 'MC-Autosell-Autodelivery-Eldorado.gg',
  channel,
  publisherName,
  metadataPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  signing: provider === 'azure'
    ? { provider: 'azure', endpoint: process.env.AZURE_SIGNING_ENDPOINT, accountName: process.env.AZURE_SIGNING_ACCOUNT, profileName: process.env.AZURE_SIGNING_PROFILE }
    : { provider: 'pfx' },
};
fs.writeFileSync(path.join(desktop, 'release-config.json'), JSON.stringify(config, null, 2) + '\n');
console.log('Production release configuration validated using ' + provider + ' signing.');
