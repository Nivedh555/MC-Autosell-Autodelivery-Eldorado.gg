'use strict';

const fs = require('node:fs');
const path = require('node:path');
const constants = require('../constants');

class VaultStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath || constants.DEFAULT_VAULT_FILE);
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  load() {
    if (!this.exists()) return null;
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      throw new Error(`Failed to load vault file: ${e.message}`);
    }
  }

  save(data) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
                   
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}

module.exports = VaultStore;
