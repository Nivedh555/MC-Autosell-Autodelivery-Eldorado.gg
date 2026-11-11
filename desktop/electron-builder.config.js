'use strict';
const fs = require('node:fs');
const path = require('node:path');
const release = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-config.json'), 'utf8'));
const signing = release.signing || { provider: 'pfx' };
if (release.enabled && !['pfx', 'azure'].includes(signing.provider)) throw Error('Unknown Windows signing provider');
const windowsSigning = release.enabled
  ? signing.provider === 'azure'
    ? { azureSignOptions: {
        publisherName: release.publisherName,
        endpoint: signing.endpoint,
        codeSigningAccountName: signing.accountName,
        certificateProfileName: signing.profileName,
        fileDigest: 'SHA256',
        timestampDigest: 'SHA256',
        timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      } }
    : { signtoolOptions: { publisherName: release.publisherName } }
  : {};
module.exports = {
  appId: 'gg.autosell.desktop',
  productName: 'Autosell V3',
  artifactName: 'Autosell-Setup-${version}-${arch}.${ext}',
  directories: { output: 'dist', buildResources: 'assets' },
  files: ['main.js', 'preload.js', 'lib/**', 'ui/**', 'release-config.json', 'assets/icon.ico', 'package.json'],
  extraResources: [{ from: 'staging', to: 'runtime', filter: ['**/*'] }],
  asar: true,
  npmRebuild: false,
  forceCodeSigning: release.enabled,
  win: {
    target: ['nsis'],
    icon: 'assets/icon.ico',
    executableName: 'Autosell V3',
    verifyUpdateCodeSignature: true,
    ...windowsSigning,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: 'Autosell V3',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    include: 'assets/installer.nsh',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico'
  },
  publish: [{ provider: 'github', owner: 'Nivedh555', repo: 'MC-Autosell-Autodelivery-Eldorado.gg', channel: release.channel === 'beta' ? 'beta' : 'latest', releaseType: 'draft' }]
};
