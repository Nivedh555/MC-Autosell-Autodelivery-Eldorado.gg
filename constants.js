'use strict';

   
                     
                                                                                
                                                                         
   
module.exports = Object.freeze({
                                                                            
  VAULT_KDF_ALGO: 'scrypt',
  VAULT_CIPHER: 'aes-256-gcm',
  VAULT_SALT_BYTES: 32,
  VAULT_NONCE_BYTES: 12,
  VAULT_TAG_BYTES: 16,
  VAULT_SCRYPT_OPTIONS: {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
  },
  
                                                     
  LTC_DUST_SATOSHIS: 294,                                                 
  LTC_DERIVATION_PATH_SEGWIT: "m/84'/2'/0'/0/0",
  LTC_DERIVATION_PATH_LEGACY: "m/44'/2'/0'/0/0",
  
                               
  SETTINGS_TABLE_NAME: 'settings',
  AUDIT_TABLE_NAME: 'audit_log',
  
                    
  DEFAULT_DATA_DIR: require('node:path').join(__dirname, 'data'),
  DEFAULT_DB_FILE: require('node:path').join(__dirname, 'data/autosell.db'),
  DEFAULT_VAULT_FILE: require('node:path').join(__dirname, 'data/vault.dat'),
  
                                     
  SETTING_ID_REGEX: /^[a-z0-9_-]+\.[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i,
});
