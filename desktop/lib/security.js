'use strict';
const crypto = require('node:crypto');
function trustedFrame(event, window) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === 'autosell://app/index.html');
}
function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid external link');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw Error('Only standard HTTPS links can be opened');
  const allowed = ['eldorado.gg', 'www.eldorado.gg', 'github.com', 'fabricmc.net', 'www.minecraft.net', 'adoptium.net', 'prismlauncher.org', 'litecoinspace.org'];
  if (!allowed.includes(url.hostname)) throw Error('External link host is not allowed');
  return url.href;
}
function verifyManifest(bytes, signature, publicKey, channel, currentVersion) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 262144) throw Error('Invalid release metadata');
  if (!crypto.verify(null, bytes, publicKey, Buffer.from(signature.trim(), 'base64'))) throw Error('Release metadata signature verification failed');
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.channel !== channel || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(data.version)) throw Error('Release channel or version is invalid');
  if (data.version.includes('-beta.') !== (channel === 'beta')) throw Error('Release version does not belong to the selected channel');
  if (!data.artifact || !/^Autosell-Setup-\d+\.\d+\.\d+(?:-beta\.\d+)?-x64\.exe$/.test(data.artifact.file)) throw Error('Unexpected update artifact');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(data.artifact.sha512) || !Number.isSafeInteger(data.artifact.size) || data.artifact.size < 1) throw Error('Invalid artifact digest or size');
  if (data.artifact.file !== 'Autosell-Setup-' + data.version + '-x64.exe') throw Error('Release filename does not match version');
  const semver = require('semver');
  if (semver.lt(data.version, currentVersion)) throw Error('Update rollback refused');
  return data;
}
function verifyUpdateInfo(info, manifest) {
  if (info.version !== manifest.version || !Array.isArray(info.files) || info.files.length !== 1) throw Error('Update metadata does not match signed release');
  const file = info.files[0];
  if (file.url !== manifest.artifact.file || file.sha512 !== manifest.artifact.sha512 || file.size !== manifest.artifact.size) throw Error('Update artifact does not match signed release');
}
module.exports = { trustedFrame, externalUrl, verifyManifest, verifyUpdateInfo };
