'use strict';
const fs = require('node:fs'), path = require('node:path');
const rejected = ['setup-wizard-default', 'default-migration-passphrase'];
function inspect(root, environment = process.env) {
  const dotenv = require('dotenv').parse(fs.existsSync(path.join(root,'.env')) ? fs.readFileSync(path.join(root,'.env')) : '');
  const password = Object.hasOwn(environment,'VAULT_PASSPHRASE') ? environment.VAULT_PASSPHRASE : dotenv.VAULT_PASSPHRASE;
  return { nodeSupported: Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 13,
    vaultExists: fs.existsSync(path.join(root,'data','vault.enc')), passphraseConfigured: Boolean(password && !rejected.includes(password)), passphraseRejected: rejected.includes(password) };
}
function validateNew(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || rejected.includes(password)) {
    const error = Error('Choose an owner-controlled vault passphrase of 12–1024 characters; built-in passwords are refused');
    error.code = 'VAULT_NEW_PASSPHRASE_INVALID';
    throw error;
  }
}
if (require.main === module) console.log(JSON.stringify(inspect(process.argv[2] || path.join(__dirname,'..'))));
module.exports = { inspect, validateNew };
