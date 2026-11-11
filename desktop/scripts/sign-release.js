'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { verifyManifest, verifyUpdateInfo } = require('../lib/security');
const directory = path.resolve(__dirname, '../dist');
const config = require('../release-config.json');
const version = require('../package.json').version;
const rootVersion = require('../../package.json').version;
if (!config.enabled || !process.env.AUTOSELL_UPDATE_PRIVATE_KEY) throw Error('Production signing configuration is required');
if (rootVersion !== version) throw Error('Root and desktop package versions must match');
if (!config.publisherName || config.publisherName !== String(process.env.AUTOSELL_PUBLISHER_NAME || config.publisherName).trim()) throw Error('Publisher identity does not match protected release configuration');
if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/tags/v' + version) throw Error('Release tag does not match package version');
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw Error('Invalid release version');
const channel = version.includes('-beta.') ? 'beta' : 'stable';
if (config.channel !== channel) throw Error('Release channel does not match the package version');
const filename = 'Autosell-Setup-' + version + '-x64.exe';
const filePath = path.join(directory, filename);
const blockmapPath = filePath + '.blockmap';
for (const file of [filePath, blockmapPath]) if (!fs.existsSync(file)) throw Error('Missing release artifact ' + path.basename(file));
const notesPath = path.join(directory, 'release-notes.md');
if (!fs.existsSync(notesPath)) throw Error('Signed release notes are missing');
const releaseNotes = fs.readFileSync(notesPath, 'utf8').trim();
if (!releaseNotes || releaseNotes.length > 100000) throw Error('Release notes must be non-empty and under 100,000 characters');
const file = fs.readFileSync(filePath);
const yamlName = channel === 'beta' ? 'beta.yml' : 'latest.yml';
const manifestName = config.channel + '-manifest.json';
const metadata = yaml.load(fs.readFileSync(path.join(directory, yamlName), 'utf8'));
if (metadata.version !== version) throw Error('Installer metadata version does not match the package version');
const manifest = {
  version,
  channel: config.channel,
  publisher: config.publisherName,
  artifact: { file: filename, sha512: crypto.createHash('sha512').update(file).digest('base64'), size: file.length },
  releaseNotes,
};
verifyUpdateInfo(metadata, manifest);
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const signature = crypto.sign(null, bytes, process.env.AUTOSELL_UPDATE_PRIVATE_KEY).toString('base64');
verifyManifest(bytes, signature, config.metadataPublicKey, config.channel, version, config.publisherName);
fs.writeFileSync(path.join(directory, manifestName), bytes);
fs.writeFileSync(path.join(directory, manifestName + '.sig'), signature + '\n');
const entries = [filename, filename + '.blockmap', yamlName, manifestName, manifestName + '.sig'];
const sums = entries.map(name => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') + '  ' + name).join('\n') + '\n';
fs.writeFileSync(path.join(directory, 'SHA256SUMS'), sums);
console.log('Signed release metadata, bound the publisher identity and checked every release artifact.');
