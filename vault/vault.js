'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const VaultStore = require('./vault-store');
const constants = require('../constants');

const scryptAsync = promisify(crypto.scrypt);
const randomBytesAsync = promisify(crypto.randomBytes);

class Vault {
  constructor(store, masterKey) {
    this.vaultStore = store;
    this.masterKey = masterKey;                        
    this.locked = false;
  }

  static async _deriveKey(passphrase, salt) {
    return await scryptAsync(
      passphrase,
      salt,
      32,
      constants.VAULT_SCRYPT_OPTIONS
    );
  }

  static exists(filePath) {
    const store = new VaultStore(filePath);
    return store.exists();
  }

  static async create(passphrase, filePath) {
    const store = new VaultStore(filePath);
    if (store.exists()) {
      throw new Error('Vault already exists');
    }
    const salt = await randomBytesAsync(constants.VAULT_SALT_BYTES);
    const verifyNonce = await randomBytesAsync(constants.VAULT_NONCE_BYTES);
    const masterKey = await Vault._deriveKey(passphrase, salt);
    
                                                       
    const cipher = crypto.createCipheriv(constants.VAULT_CIPHER, masterKey, verifyNonce);
    let verifyCiphertext = cipher.update('autosell-vault', 'utf8', 'base64');
    verifyCiphertext += cipher.final('base64');
    const verifyTag = cipher.getAuthTag().toString('base64');

    const vaultData = {
      version: 1,
      salt: salt.toString('base64'),
      verify: {
        nonce: verifyNonce.toString('base64'),
        ciphertext: verifyCiphertext,
        tag: verifyTag
      },
      secrets: {}
    };

    store.save(vaultData);
    return new Vault(store, masterKey);
  }

  static async open(passphrase, filePath) {
    const store = new VaultStore(filePath);
    if (!store.exists()) {
      throw new Error('Vault does not exist');
    }
    const data = store.load();
    const salt = Buffer.from(data.salt, 'base64');
    const masterKey = await Vault._deriveKey(passphrase, salt);

                        
    try {
      const verifyNonce = Buffer.from(data.verify.nonce, 'base64');
      const verifyTag = Buffer.from(data.verify.tag, 'base64');
      const decipher = crypto.createDecipheriv(constants.VAULT_CIPHER, masterKey, verifyNonce);
      decipher.setAuthTag(verifyTag);
      let cleartext = decipher.update(data.verify.ciphertext, 'base64', 'utf8');
      cleartext += decipher.final('utf8');
      if (cleartext !== 'autosell-vault') throw new Error('Bad verify');
    } catch (e) {
      throw new Error('Invalid passphrase');
    }

    return new Vault(store, masterKey);
  }

  _checkLocked() {
    if (this.locked) throw new Error('Vault is locked');
  }

  async store(key, value) {
    this._checkLocked();
    const nonce = await randomBytesAsync(constants.VAULT_NONCE_BYTES);
    const cipher = crypto.createCipheriv(constants.VAULT_CIPHER, this.masterKey, nonce);
    let ciphertext = cipher.update(value, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const tag = cipher.getAuthTag().toString('base64');

    const data = this.vaultStore.load();
    data.secrets[key] = {
      nonce: nonce.toString('base64'),
      ciphertext,
      tag: tag.toString('base64')
    };
    this.vaultStore.save(data);
  }

  async retrieve(key) {
    this._checkLocked();
    const data = this.vaultStore.load();
    const secretInfo = data.secrets[key];
    if (!secretInfo) return null;

    const nonce = Buffer.from(secretInfo.nonce, 'base64');
    const tag = Buffer.from(secretInfo.tag, 'base64');
    const decipher = crypto.createDecipheriv(constants.VAULT_CIPHER, this.masterKey, nonce);
    decipher.setAuthTag(tag);

    try {
      let cleartext = decipher.update(secretInfo.ciphertext, 'base64', 'utf8');
      cleartext += decipher.final('utf8');
      return cleartext;
    } catch (e) {
      throw new Error(`Failed to decrypt secret ${key}`);
    }
  }

  async delete(key) {
    this._checkLocked();
    const data = this.vaultStore.load();
    if (data.secrets[key]) {
      delete data.secrets[key];
      this.vaultStore.save(data);
    }
  }

  async listKeys() {
    this._checkLocked();
    const data = this.vaultStore.load();
    return Object.keys(data.secrets);
  }

  async changePassphrase(oldPass, newPass) {
    this._checkLocked();
                      
    const data = this.vaultStore.load();
    const salt = Buffer.from(data.salt, 'base64');
    const testKey = await Vault._deriveKey(oldPass, salt);
    if (!testKey.equals(this.masterKey)) {
      throw new Error('Invalid old passphrase');
    }

                                   
    const cleartexts = {};
    for (const key of Object.keys(data.secrets)) {
      cleartexts[key] = await this.retrieve(key);
    }

                                                  
    const newSalt = await randomBytesAsync(constants.VAULT_SALT_BYTES);
    const newMasterKey = await Vault._deriveKey(newPass, newSalt);
    
    const verifyNonce = await randomBytesAsync(constants.VAULT_NONCE_BYTES);
    const cipher = crypto.createCipheriv(constants.VAULT_CIPHER, newMasterKey, verifyNonce);
    let verifyCiphertext = cipher.update('autosell-vault', 'utf8', 'base64');
    verifyCiphertext += cipher.final('base64');
    const verifyTag = cipher.getAuthTag().toString('base64');

    data.salt = newSalt.toString('base64');
    data.verify = {
      nonce: verifyNonce.toString('base64'),
      ciphertext: verifyCiphertext,
      tag: verifyTag
    };
    data.secrets = {};
                                                                               
                                                                              
    for (const [key, value] of Object.entries(cleartexts)) {
      const nonce = await randomBytesAsync(constants.VAULT_NONCE_BYTES);
      const secretCipher = crypto.createCipheriv(constants.VAULT_CIPHER,newMasterKey,nonce);
      const ciphertext = secretCipher.update(value,'utf8','base64') + secretCipher.final('base64');
      data.secrets[key] = { nonce:nonce.toString('base64'),ciphertext,tag:secretCipher.getAuthTag().toString('base64') };
    }
    this.vaultStore.save(data);
    this.masterKey.fill(0);
    this.masterKey = newMasterKey;
  }

  async verify(passphrase) {
    try {
      const data = this.vaultStore.load();
      const salt = Buffer.from(data.salt, 'base64');
      const testKey = await Vault._deriveKey(passphrase, salt);
      return testKey.equals(this.masterKey);
    } catch {
      return false;
    }
  }

  lock() {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    this.locked = true;
  }
  
  isUnlocked() {
    return !this.locked;
  }
}

module.exports = Vault;
