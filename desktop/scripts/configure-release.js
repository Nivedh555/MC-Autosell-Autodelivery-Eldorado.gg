'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const desktop = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (process.env.GITHUB_REF !== 'refs/tags/v' + version) throw Error('Release tag must match the desktop package version');
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw Error('Use a semantic version or X.Y.Z-beta.N');
const channel = version.includes('-beta.') ? 'beta' : 'stable';
for (const name of ['AUTOSELL_PUBLISHER_NAME', 'AUTOSELL_UPDATE_PUBLIC_KEY', 'AUTOSELL_UPDATE_PRIVATE_KEY', 'CSC_LINK', 'CSC_KEY_PASSWORD']) {
  if (!process.env[name]) throw Error('Protected release configuration is missing ' + name);
}
const publicKey = crypto.createPublicKey(process.env.AUTOSELL_UPDATE_PUBLIC_KEY);
const privateKey = crypto.createPrivateKey(process.env.AUTOSELL_UPDATE_PRIVATE_KEY);
if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519') throw Error('Release metadata requires Ed25519 keys');
const probe = Buffer.from('Autosell release-key check');
if (!crypto.verify(null, probe, publicKey, crypto.sign(null, probe, privateKey))) throw Error('Metadata signing key does not match public key');
fs.writeFileSync(path.join(desktop, 'release-config.json'), JSON.stringify({ enabled: true, owner: 'Nivedh555', repo: 'MC-Autosell-Autodelivery-Eldorado.gg', channel, publisherName: process.env.AUTOSELL_PUBLISHER_NAME, metadataPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) }, null, 2));
console.log('Production release configuration validated.');
