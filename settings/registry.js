'use strict';

const SettingsStore = require('./settings-store');
const Vault = require('../vault/vault');
const constants = require('../constants');
const path = require('node:path');
const fs = require('node:fs');

class SettingsRegistry {
  constructor(dbPath, vaultPath, vaultPassphrase) {
    this.store = new SettingsStore(dbPath);
    this.vaultPath = path.resolve(vaultPath || constants.DEFAULT_VAULT_FILE);
    this.vaultPassphrase = vaultPassphrase;
    this.vault = null;
    this.definitions = new Map();
  }

  async init() {
    if (!this.vaultPassphrase || ['setup-wizard-default', 'default-migration-passphrase'].includes(this.vaultPassphrase)) throw new Error('Set an owner-controlled VAULT_PASSPHRASE; built-in passwords are refused');
    if (Vault.exists(this.vaultPath)) {
      if (!this.vaultPassphrase) throw new Error('Vault passphrase required');
      this.vault = await Vault.open(this.vaultPassphrase, this.vaultPath);
    } else {
      this.vault = await Vault.create(this.vaultPassphrase, this.vaultPath);
    }
  }

  register(definition) {
    if (!constants.SETTING_ID_REGEX.test(definition.id)) {
      throw new Error(`Invalid setting ID format: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
  }

  _getDef(id) {
    const def = this.definitions.get(id);
    if (!def) throw new Error(`Unknown setting: ${id}`);
    return def;
  }

  async get(id) {
    const def = this._getDef(id);
    if (def.secret) {
      if (!this.vault) return def.default;
      const val = await this.vault.retrieve(id);
      return val !== null ? val : def.default;
    }
    const val = this.store.get(id);
    return val !== undefined ? val : structuredClone(def.default);
  }
  
  getSync(id) {
    const def = this.definitions.get(id);
    if (!def) {
      return this.store.get(id);
    }
    if (def.secret) {
      throw new Error('Cannot read secrets synchronously');
    }
    const val = this.store.get(id);
    return val !== undefined ? val : structuredClone(def.default);
  }

  async set(id, value, actor) {
    const def = this._getDef(id);
    const { valid, error } = this.validate(id, value);
    if (!valid) throw new Error(`Validation failed for ${id}: ${error}`);

    if (def.secret) {
      const oldVal = await this.vault.retrieve(id);
      if (oldVal !== value) {
        await this.vault.store(id, value);
        this.store.auditLog.log(actor, 'SET_SECRET', id, '***', '***');
        this.store.emit('change', id, value, oldVal);
      }
    } else {
      this.store.set(id, value, actor, def.secret);
    }
  }

  onChange(id, handler) {
    this.store.on('change', (changedId, newValue, oldValue) => {
      if (changedId === id) {
        handler(newValue, oldValue);
      }
    });
  }

  getGroup(group) {
    return Array.from(this.definitions.values()).filter(d => d.group === group);
  }

  async getAll() {
    const all = [];
    for (const [id, def] of this.definitions.entries()) {
      const val = await this.get(id);
      all.push({ definition: def, value: val });
    }
    return all;
  }

  async reset(id, actor) {
    const def = this._getDef(id);
    if (def.secret) {
      await this.vault.delete(id);
      this.store.auditLog.log(actor, 'RESET_SECRET', id, '***', null);
      this.store.emit('change', id, def.default, undefined);
    } else {
      this.store.delete(id, actor, def.secret);
    }
  }

  validate(id, value) {
    const def = this._getDef(id);
    
                      
    if (value === null || value === undefined) return { valid: false, error: 'Value is required' };
    
    if (def.type === 'string' && typeof value !== 'string') return { valid: false, error: 'Must be a string' };
    if (def.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return { valid: false, error: 'Must be a finite number' };
    if (def.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return { valid: false, error: 'Must be an object' };
    if (def.type === 'secret' && typeof value !== 'string') return { valid: false, error: 'Must be a string' };
    if (def.type === 'boolean' && typeof value !== 'boolean') return { valid: false, error: 'Must be a boolean' };
    if (['wallet.ltc.apiBase', 'wallet.ltc.blockcypherBase'].includes(id)) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.search) throw Error('invalid');
      } catch { return { valid: false, error: 'Use a valid HTTPS URL without credentials, query parameters or fragment; its host must be allow-listed' }; }
    }
    if (def.type === 'stringArray') {
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
        return { valid: false, error: 'Must be an array of strings' };
      }
    }

    if (def.validation) {
      const v = def.validation;
      if (def.type === 'number') {
        if (v.min !== undefined && value < v.min) return { valid: false, error: `Must be >= ${v.min}` };
        if (v.max !== undefined && value > v.max) return { valid: false, error: `Must be <= ${v.max}` };
      }
      if (def.type === 'string' || def.type === 'secret') {
        if (v.minLength !== undefined && value.length < v.minLength) return { valid: false, error: `Length must be >= ${v.minLength}` };
        if (v.maxLength !== undefined && value.length > v.maxLength) return { valid: false, error: `Length must be <= ${v.maxLength}` };
        if (v.pattern) {
          const re = new RegExp(v.pattern);
          if (!re.test(value)) return { valid: false, error: 'Does not match required pattern' };
        }
        if (v.enum && !v.enum.includes(value)) return { valid: false, error: `Must be one of: ${v.enum.join(', ')}` };
      }
      if (v.custom) {
        const customErr = v.custom(value);
        if (customErr) return { valid: false, error: customErr };
      }
    }
    return { valid: true };
  }

  async export() {
    const dbValues = this.store.getAll();
    const result = {};
    for (const [id, def] of this.definitions.entries()) {
      if (!def.secret) {
        result[id] = dbValues[id] !== undefined ? dbValues[id] : def.default;
      }
    }
    return result;
  }

  async import(data, actor) {
    let applied = 0;
    const errors = [];
    
              
    for (const [id, value] of Object.entries(data)) {
      if (!this.definitions.has(id)) continue;
      const { valid, error } = this.validate(id, value);
      if (!valid) {
        errors.push(`${id}: ${error}`);
      }
    }
    
    if (errors.length > 0) return { applied: 0, errors };
    
    for (const [id, value] of Object.entries(data)) {
      if (!this.definitions.has(id)) continue;
      await this.set(id, value, actor);
      applied++;
    }
    return { applied, errors: [] };
  }
}

                                                            
                               
                                                            

function loadDefaults(registry) {
  const settings = [
                      
    { id: 'general.bot.paused', type: 'boolean', default: false, group: 'General', label: 'Bot Paused', description: 'Pause all selling', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'general.bot.name', type: 'string', default: 'AutoSell', group: 'General', label: 'Bot Name', description: 'Bot name', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'general.bot.owner', type: 'string', default: 'Owner', group: 'General', label: 'Owner Name', description: 'Owner name', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'general.feature.autoSweep', type: 'boolean', default: true, group: 'General', label: 'Auto Sweep', description: 'Enable auto sweeping', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'general.bot.trustedSystem', type: 'boolean', default: false, group: 'General', label: 'Trusted System', description: 'Enable trusted seller system', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'general.bot.trustThreshold', type: 'number', default: 4, group: 'General', label: 'Trust Threshold', description: 'Sales to become trusted', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: 'general.bot.trustedSystem', since: '2.0.0' },

                       
    { id: 'security.api.key', type: 'secret', default: '', group: 'Security', label: 'API Key', description: 'Key for dashboard', uiControl: 'password', dangerLevel: 'caution', restartRequired: true, hotReload: false, secret: true, dependsOn: 'security.api.enabled', since: '2.0.0' },
    { id: 'security.api.host', type: 'string', default: '127.0.0.1', group: 'Security', label: 'API Host', description: 'Host bind address', uiControl: 'input', dangerLevel: 'caution', restartRequired: true, hotReload: false, secret: false, dependsOn: 'security.api.enabled', since: '2.0.0' },
    { id: 'security.api.port', type: 'number', default: 4201, group: 'Security', label: 'API Port', description: 'API Port', uiControl: 'number', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: 'security.api.enabled', since: '2.0.0' },

                      
    { id: 'discord.bot.token', type: 'secret', default: '', group: 'Discord', label: 'Bot Token', description: 'Discord bot token', uiControl: 'password', dangerLevel: 'caution', restartRequired: true, hotReload: false, secret: true, dependsOn: null, since: '2.0.0' },
    { id: 'discord.guild.id', type: 'string', default: '', group: 'Discord', label: 'Guild ID', description: 'Server ID', uiControl: 'input', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.role.admin', type: 'string', default: '', group: 'Discord', label: 'Admin Role', description: 'Admin role ID', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.channel.logs', type: 'string', default: '', group: 'Discord', label: 'Logs Channel', description: 'Log channel ID', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.category.sell', type: 'string', default: '', group: 'Discord', label: 'Sell Category', description: 'Sell category ID', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.role.sold', type: 'string', default: '', group: 'Discord', label: 'Sold Role', description: 'Granted after first sale', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.channel.vouch', type: 'string', default: '', group: 'Discord', label: 'Vouch Channel', description: 'Where to leave vouches', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.role.automodExempt', type: 'string', default: '', group: 'Discord', label: 'Automod Exempt Role', description: 'Role to bypass automod', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'discord.user.ownerId', type: 'string', default: '', group: 'Discord', label: 'Owner ID', description: 'DM for alerts', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                              
    { id: 'pricing.spawner.priceUsd', type: 'number', default: 0.05, group: 'Sales & Pricing', label: 'Spawner Price (USD)', description: 'Price per spawner', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.money.ratePerMillion', type: 'number', default: 0.027, group: 'Sales & Pricing', label: 'Money Rate (USD/M)', description: 'Rate per million', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.spawner.enabled', type: 'boolean', default: true, group: 'Sales & Pricing', label: 'Buy Spawners', description: 'Enable spawner buying', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.money.enabled', type: 'boolean', default: true, group: 'Sales & Pricing', label: 'Buy Money', description: 'Enable money buying', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.money.minAmount', type: 'number', default: 10000000, group: 'Sales & Pricing', label: 'Min Money', description: 'Minimum money to sell', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.spawner.minAmount', type: 'number', default: 0, group: 'Sales & Pricing', label: 'Min Spawners', description: 'Minimum spawners to sell', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.spawner.itemName', type: 'string', default: 'spawner', group: 'Sales & Pricing', label: 'Spawner Item Name', description: 'Item name', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'pricing.spawner.match', type: 'string', default: 'skeleton', group: 'Sales & Pricing', label: 'Spawner Match', description: 'Match type', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                                      
    { id: 'verify.enabled', type: 'boolean', default: true, group: 'Payments & Verification', label: 'Verification Enabled', description: 'Require IGN link', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'verify.amount.min', type: 'number', default: 1, group: 'Payments & Verification', label: 'Verify Min Amount', description: 'Min random amount', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: 'verify.enabled', since: '2.0.0' },
    { id: 'verify.amount.max', type: 'number', default: 500, group: 'Payments & Verification', label: 'Verify Max Amount', description: 'Max random amount', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: 'verify.enabled', since: '2.0.0' },
    { id: 'verify.ttl.minutes', type: 'number', default: 20, group: 'Payments & Verification', label: 'Verify TTL (min)', description: 'How long to wait', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: 'verify.enabled', since: '2.0.0' },
    { id: 'payment.collect.tpaTimeout', type: 'number', default: 120000, group: 'Payments & Verification', label: 'TPA Timeout', description: 'Ms to wait for tpa', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'payment.collect.tpaUsesGui', type: 'boolean', default: false, group: 'Payments & Verification', label: 'TPA confirmation GUI', description: 'Spawner collection setting', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false },
    { id: 'payment.collect.tpaConfirmSlot', type: 'number', default: 13, validation: { min: 0 }, group: 'Payments & Verification', label: 'TPA confirm slot', description: 'Spawner collection setting', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false },
    { id: 'payment.collect.tpaGuiDelayMs', type: 'number', default: 600, validation: { min: 0 }, group: 'Payments & Verification', label: 'TPA GUI delay (ms)', description: 'Spawner collection setting', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false },
    { id: 'payment.collect.enderChestSearchRadius', type: 'number', default: 8, validation: { min: 1 }, group: 'Payments & Verification', label: 'Ender Chest search radius', description: 'Spawner collection setting', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false },
    { id: 'payment.collect.enderChestPlaceTimeoutMs', type: 'number', default: 60000, validation: { min: 1000 }, group: 'Payments & Verification', label: 'Ender Chest placement timeout (ms)', description: 'Spawner collection setting', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false },
    { id: 'payment.collect.radius', type: 'number', default: 8, group: 'Payments & Verification', label: 'Collect Radius', description: 'Blocks to search', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'payment.collect.delayMs', type: 'number', default: 30000, group: 'Payments & Verification', label: 'Collect Delay', description: 'Ms to wait', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'payment.chat.debug', type: 'boolean', default: false, group: 'Payments & Verification', label: 'Debug Chat', description: 'Log all mc chat', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                                 
    { id: 'mc.server.host', type: 'string', default: 'donutsmp.net', group: 'Minecraft Accounts', label: 'Server Host', description: 'MC IP', uiControl: 'input', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.server.port', type: 'number', default: 25565, group: 'Minecraft Accounts', label: 'Server Port', description: 'MC Port', uiControl: 'number', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.server.version', type: 'string', default: '1.21.1', group: 'Minecraft Accounts', label: 'MC Version', description: 'Version', uiControl: 'input', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.buyer1.email', type: 'secret', default: '', group: 'Minecraft Accounts', label: 'Buyer 1 Email', description: 'Microsoft email', uiControl: 'password', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: true, dependsOn: null, since: '2.0.0' },
    { id: 'mc.buyer1.ign', type: 'string', default: '', group: 'Minecraft Accounts', label: 'Buyer 1 IGN', description: 'In-game name', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.buyer2.email', type: 'secret', default: '', group: 'Minecraft Accounts', label: 'Buyer 2 Email', description: 'Microsoft email', uiControl: 'password', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: true, dependsOn: null, since: '2.0.0' },
    { id: 'mc.buyer2.ign', type: 'string', default: '', group: 'Minecraft Accounts', label: 'Buyer 2 IGN', description: 'In-game name', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.auth.cacheDir', type: 'string', default: './auth-cache', group: 'Minecraft Accounts', label: 'Auth Cache Dir', description: 'Where tokens save', uiControl: 'input', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.server.reconnectDelayMs', type: 'number', default: 30000, group: 'Minecraft Accounts', label: 'Reconnect Delay', description: 'Wait before reconnect', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.server.disconnectTimeoutMs', type: 'number', default: 5000, group: 'Minecraft Accounts', label: 'Logout timeout', description: 'Local wait for the old socket to close before forcing its closure; not a server limit.', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, since: '2.0.0' },
    { id: 'mc.server.disconnectGraceMs', type: 'number', default: 1500, group: 'Minecraft Accounts', label: 'Logout reconnect gap', description: 'Local settling time after a closed connection before a new login; server kicks can require a longer backoff.', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, since: '2.0.0' },
    { id: 'mc.server.hostFallbacks', type: 'stringArray', default: ['asia.donutsmp.net', 'eu.donutsmp.net', 'na.donutsmp.net'], group: 'Minecraft Accounts', label: 'Host Fallbacks', description: 'Fallback IPs', uiControl: 'json-editor', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.home.command', type: 'string', default: '/home 1', group: 'Minecraft Accounts', label: 'Home Command', description: 'Command to teleport home (e.g. /home 1)', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'mc.autoLeaveAfterDelivery', type: 'boolean', default: false, group: 'Minecraft Accounts', label: 'Auto Leave After Delivery', description: 'Automatically sleep bot after deliveries or sweeps', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                       
    { id: 'session.mode', type: 'string', default: 'always_on', validation: { enum: ['lease', 'always_on'] }, group: 'Sessions', label: 'Session Mode', description: 'Connection style', uiControl: 'select', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'session.lease.durationMs', type: 'number', default: 300000, group: 'Sessions', label: 'Lease Duration', description: 'Ms to keep alive', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'session.antiAfk.enabled', type: 'boolean', default: true, group: 'Sessions', label: 'Anti-AFK', description: 'Move to avoid kick', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'session.antiAfk.intervalMs', type: 'number', default: 45000, group: 'Sessions', label: 'Anti-AFK Interval', description: 'Ms between moves', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: 'session.antiAfk.enabled', since: '2.0.0' },
    { id: 'session.chat.commandsOnly', type: 'boolean', default: true, group: 'Sessions', label: 'Ignore Public Chat', description: 'Performance save', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'session.spawn.commands', type: 'stringArray', default: [], group: 'Sessions', label: 'Spawn Commands', description: 'Run on join', uiControl: 'json-editor', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                       
    { id: 'treasury.sweep.ign', type: 'string', default: '', group: 'Treasury', label: 'Sweep Target IGN', description: 'Main alt to send money', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'treasury.sweep.igns', type: 'stringArray', default: [], group: 'Treasury', label: 'Sweep Targets', description: 'List of alts', uiControl: 'json-editor', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'treasury.sweep.delayMs', type: 'number', default: 10000, group: 'Treasury', label: 'Sweep Delay', description: 'Delay between sends', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'treasury.balance.lowUsd', type: 'number', default: 4, group: 'Treasury', label: 'Low Balance Alert (USD)', description: 'Alert owner', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'treasury.balance.restockUsd', type: 'number', default: 20, group: 'Treasury', label: 'Restock Target (USD)', description: 'Target balance', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                             
    { id: 'autosell.pair_count', type: 'number', default: 2, group: 'AutoSell Pairs', label: 'Pair Count', description: 'Total number of Buyer/Seller pairs', uiControl: 'number', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'autosell.all_busy_action', type: 'string', default: 'queue', validation: { enum: ['queue', 'reject'] }, group: 'AutoSell Pairs', label: 'All Busy Action', description: 'Queue or reject when all pairs busy', uiControl: 'select', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                       
    { id: 'marketplace.eldorado.enabled', type: 'boolean', default: false, group: 'Eldorado', label: 'Eldorado Enabled', description: 'Enable syncing', uiControl: 'toggle', dangerLevel: 'safe', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'marketplace.dry_run', retired: true, type: 'boolean', default: false, group: 'Eldorado', label: 'Dry Run Mode', description: 'Simulate deliveries without executing live payments', uiControl: 'toggle', dangerLevel: 'caution', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'marketplace.eldorado.apiKey', type: 'secret', default: '', group: 'Eldorado', label: 'Eldorado API Key', description: 'API token', uiControl: 'password', dangerLevel: 'caution', restartRequired: true, hotReload: false, secret: true, dependsOn: 'marketplace.eldorado.enabled', since: '2.0.0' },
    { id: 'marketplace.eldorado.marginPercent', type: 'number', default: 15, group: 'Eldorado', label: 'Margin %', description: 'Markup for listings', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: 'marketplace.eldorado.enabled', since: '2.0.0' },
    { id: 'marketplace.eldorado.autoFulfill', type: 'boolean', default: false, group: 'Eldorado', label: 'Auto Fulfill', description: 'Deliver automatically', uiControl: 'toggle', dangerLevel: 'caution', restartRequired: false, hotReload: true, secret: false, dependsOn: 'marketplace.eldorado.enabled', since: '2.0.0' },

                         
    { id: 'wallet.maxPerTxUsd', type: 'number', default: 0, validation: { min: 0 }, group: 'LTC Wallet', label: 'Global transaction cap (USD)', description: 'Optional additional wallet cap; zero leaves the seller payout policy in control', secret: false },
    { id: 'wallet.maxPerDayUsd', type: 'number', default: 0, validation: { min: 0 }, group: 'LTC Wallet', label: 'Global daily cap (USD)', description: 'Optional additional wallet cap; zero leaves the seller payout policy in control', secret: false },
    { id: 'wallet.withdrawal.maxLtc', type: 'number', default: 100, validation: { min: 0.00000001 }, group: 'LTC Wallet', label: 'Withdrawal cap (LTC)', description: 'Owner withdrawal limit; existing positive USD caps also apply', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.withdrawal.dailyLtc', type: 'number', default: 1000, validation: { min: 0.00000001 }, group: 'LTC Wallet', label: 'Daily withdrawal cap (LTC, including fees)', description: 'Owner withdrawal limit; existing positive USD caps also apply', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.withdrawal.maxFeeLtc', type: 'number', default: 0.01, validation: { min: 0.00000001 }, group: 'LTC Wallet', label: 'Withdrawal fee cap (LTC)', description: 'Owner withdrawal limit; existing positive USD caps also apply', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.mnemonic', type: 'secret', default: '', group: 'LTC Wallet', label: 'Mnemonic', description: 'Wallet seed phrase', uiControl: 'password', dangerLevel: 'money', restartRequired: true, hotReload: false, secret: true, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.wif', type: 'secret', default: '', group: 'LTC Wallet', label: 'WIF', description: 'Private key', uiControl: 'password', dangerLevel: 'money', restartRequired: true, hotReload: false, secret: true, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.derivationPath', type: 'string', default: "m/84'/2'/0'/0/0", group: 'LTC Wallet', label: 'Derivation Path', description: 'BIP32 path', uiControl: 'input', dangerLevel: 'caution', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.addressType', type: 'string', default: 'segwit', validation: { enum: ['segwit', 'legacy'] }, group: 'LTC Wallet', label: 'Address Type', description: 'Format', uiControl: 'select', dangerLevel: 'caution', restartRequired: true, hotReload: false, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.sendEnabled', type: 'boolean', default: false, group: 'LTC Wallet', label: 'Send Enabled', description: 'Allow outgoing tx', uiControl: 'toggle', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.spendUnconfirmed', type: 'boolean', default: false, group: 'LTC Wallet', label: 'Spend Unconfirmed', description: 'Use mempool funds', uiControl: 'toggle', dangerLevel: 'caution', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.feeSatPerVb', type: 'number', default: 8, group: 'LTC Wallet', label: 'Fee (sat/vB)', description: 'Tx fee', uiControl: 'number', dangerLevel: 'money', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.provider', type: 'string', default: 'blockcypher', validation: { enum: ['blockcypher', 'esplora'] }, group: 'LTC Wallet', label: 'API Provider', description: 'Chain API', uiControl: 'select', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.apiBase', type: 'string', default: 'https://litecoinspace.org/api', group: 'LTC Wallet', label: 'Esplora Base URL', description: 'For esplora', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.blockcypherBase', type: 'string', default: 'https://api.blockcypher.com/v1/ltc/main', group: 'LTC Wallet', label: 'BlockCypher Base URL', description: 'Litecoin mainnet API; HTTPS host must be allow-listed', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },
    { id: 'wallet.ltc.blockcypherToken', type: 'secret', default: '', group: 'LTC Wallet', label: 'BlockCypher Token', description: 'API Key', uiControl: 'password', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: true, dependsOn: null, since: '2.0.0' },

                      
    { id: 'network.coingecko.url', type: 'string', default: 'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', group: 'Network', label: 'Price API URL', description: 'Ticker API', uiControl: 'input', dangerLevel: 'safe', restartRequired: false, hotReload: true, secret: false, dependsOn: null, since: '2.0.0' },

                            
  ];

  for (const s of settings) {
    registry.register(s);
  }
  const { registerEldoradoSettings } = require('../marketplace/api-config');
  registerEldoradoSettings(registry);
  require('./safety-settings').registerSafetySettings(registry);
}

module.exports = { SettingsRegistry, loadDefaults };
