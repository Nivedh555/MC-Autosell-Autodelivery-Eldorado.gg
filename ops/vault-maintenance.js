'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Vault = require('../vault/vault');
async function migrate(file, oldPassword, newPassword) {
  require('./startup-check').validateNew(newPassword);
  let release;
  try { release = require('./instance-lock').acquire(path.dirname(path.resolve(file))); }
  catch (error) { error.code = 'VAULT_LOCK_FAILED'; throw error; }
  let vault;
  try {
    try { vault = await Vault.open(oldPassword,file); }                                          
    catch (error) { if (error.message === 'Invalid passphrase') error.code = 'VAULT_OLD_PASSPHRASE_INVALID'; throw error; }
    const backup = file+'.backup-'+crypto.randomUUID();
    fs.writeFileSync(backup,fs.readFileSync(file),{flag:'wx',mode:0o600});
    await vault.changePassphrase(oldPassword,newPassword);
    return {backup,changed:true};
  } finally { vault?.lock();release(); }
}
async function migrateLegacy(file,newPassword) {
  require('./startup-check').validateNew(newPassword);
  for (const oldPassword of ['setup-wizard-default','default-migration-passphrase']) {
    let vault;
    try { vault=await Vault.open(oldPassword,file); }
    catch (error) { if(error.message==='Invalid passphrase')continue;throw error; }
    vault.lock();return migrate(file,oldPassword,newPassword);
  }
  const error = Error('Vault does not use a known legacy built-in passphrase; use migration with the original owner passphrase');
  error.code = 'VAULT_NOT_LEGACY';
  throw error;
}
function failureMessage(error) {
  const reasons = {
    VAULT_NEW_PASSPHRASE_INVALID: 'New passphrase must be 12–1024 characters and cannot be a built-in password. Nothing changed; retry with a longer owner-chosen passphrase.',
    VAULT_OLD_PASSPHRASE_INVALID: 'The existing passphrase was incorrect. Nothing changed; use the original vault passphrase.',
    VAULT_NOT_LEGACY: 'This vault does not use a known legacy password. Nothing changed; use -MigrateVault with its original owner passphrase.',
    VAULT_LOCK_FAILED: 'Could not obtain the exclusive vault lock. Stop Autosell and inspect data/process.lock before retrying; do not remove a live process lock.',
    EACCES: 'File access was denied. Preserve the vault/backups and check permissions before retrying.',
    EPERM: 'File access was denied or a file is locked. Preserve the vault/backups and check running processes and permissions.',
    ENOSPC: 'Storage is full. Preserve the vault/backups and free space before retrying.'
  };
  return 'Vault migration failed: ' + (reasons[error?.code] || 'Unexpected vault or file error. Preserve the vault/backups; do not delete or reset the vault.');
}
if (require.main === module) (process.argv.includes('--legacy')
  ? migrateLegacy(path.join(__dirname,'../data/vault.enc'),process.env.AUTOSELL_NEW_VAULT_PASSWORD)
  : migrate(path.join(__dirname,'../data/vault.enc'),process.env.AUTOSELL_OLD_VAULT_PASSWORD,process.env.AUTOSELL_NEW_VAULT_PASSWORD))
  .then(result=>console.log('Vault migrated; encrypted backup: '+result.backup),error=>{console.error(failureMessage(error));process.exitCode=1;});
module.exports = { migrate, migrateLegacy, failureMessage };
