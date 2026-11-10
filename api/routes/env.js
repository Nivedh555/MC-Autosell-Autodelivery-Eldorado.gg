'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const services = require('../../services');

                                                          
const ENV_MAPPINGS = [
  { group: 'Spawner Collection', id: 'payment.collect.tpaUsesGui', envKey: 'TPA_USES_GUI', label: 'TPA confirmation GUI', description: 'Spawner collection setting', type: 'boolean', default: false },
  { group: 'Spawner Collection', id: 'payment.collect.tpaConfirmSlot', envKey: 'TPA_CONFIRM_SLOT', label: 'TPA confirm slot', description: 'Spawner collection setting', type: 'number', default: 13 },
  { group: 'Spawner Collection', id: 'payment.collect.tpaGuiDelayMs', envKey: 'TPA_GUI_DELAY_MS', label: 'TPA GUI delay (ms)', description: 'Spawner collection setting', type: 'number', default: 600 },
  { group: 'Spawner Collection', id: 'payment.collect.enderChestSearchRadius', envKey: 'ENDER_CHEST_SEARCH_RADIUS', label: 'Ender Chest search radius', description: 'Spawner collection setting', type: 'number', default: 8 },
  { group: 'Spawner Collection', id: 'payment.collect.enderChestPlaceTimeoutMs', envKey: 'ENDER_CHEST_PLACE_TIMEOUT_MS', label: 'Ender Chest placement timeout (ms)', description: 'Spawner collection setting', type: 'number', default: 60000 },
  { group: 'Minecraft & Accounts', id: 'session.mode', envKey: 'MC_SESSION_MODE', label: 'Session Mode', description: 'always_on stays connected; lease connects only while needed', type: 'string', default: 'always_on' },
  { group: 'LTC Wallet', id: 'wallet.withdrawal.maxLtc', envKey: 'LTC_WITHDRAWAL_MAX_LTC', label: 'Withdrawal cap (LTC)', description: 'Owner withdrawal limit; positive USD caps also apply', type: 'number', default: 100 },
  { group: 'LTC Wallet', id: 'wallet.withdrawal.dailyLtc', envKey: 'LTC_WITHDRAWAL_DAILY_LTC', label: 'Daily withdrawal cap including fees (LTC)', description: 'Owner withdrawal limit; positive USD caps also apply', type: 'number', default: 1000 },
  { group: 'LTC Wallet', id: 'wallet.withdrawal.maxFeeLtc', envKey: 'LTC_WITHDRAWAL_MAX_FEE_LTC', label: 'Withdrawal fee cap (LTC)', description: 'Owner withdrawal limit; positive USD caps also apply', type: 'number', default: 0.01 },
  { group: 'LTC Wallet', id: 'wallet.ltc.blockcypherBase', envKey: 'BLOCKCYPHER_BASE', label: 'BlockCypher Base URL', description: 'Litecoin mainnet HTTPS API', type: 'string', default: 'https://api.blockcypher.com/v1/ltc/main' },
                    
  {
    group: 'Discord Bot',
    id: 'discord.bot.token',
    envKey: 'DISCORD_TOKEN',
    label: 'Discord Bot Token',
    description: 'Bot user authorization token from Discord Developer Portal',
    type: 'secret',
    default: ''
  },
  {
    group: 'Discord Bot',
    id: 'discord.guild.id',
    envKey: 'DISCORD_GUILD_ID',
    label: 'Discord Server (Guild) ID',
    description: 'The server snowflake ID where AutoSell operates',
    type: 'string',
    default: ''
  },
  {
    group: 'Discord Bot',
    id: 'discord.role.admin',
    envKey: 'DISCORD_ADMIN_ROLE_ID',
    label: 'Admin Role ID',
    description: 'Role with full administrative privileges to command bots and execute sweeps',
    type: 'string',
    default: ''
  },
  {
    group: 'Discord Bot',
    id: 'discord.channel.logs',
    envKey: 'DISCORD_LOGS_CHANNEL_ID',
    label: 'Logs Channel ID',
    description: 'Channel where sales, sweeps, and alerts are posted',
    type: 'string',
    default: ''
  },
  {
    group: 'Discord Bot',
    id: 'discord.category.sell',
    envKey: 'DISCORD_SELL_CATEGORY_ID',
    label: 'Sell Category ID',
    description: 'Category where temporary private selling ticket channels are spawned',
    type: 'string',
    default: ''
  },
  {
    group: 'Discord Bot',
    id: 'discord.channel.vouch',
    envKey: 'DISCORD_VOUCH_CHANNEL_ID',
    label: 'Vouch Channel ID',
    description: 'Channel where completed deal vouches and receipts are published',
    type: 'string',
    default: ''
  },
  {
    group: 'Discord Bot',
    id: 'discord.user.ownerId',
    envKey: 'DISCORD_OWNER_ID',
    label: 'Discord Owner ID',
    description: 'Your personal Discord user ID for priority DM notifications and alerts',
    type: 'string',
    default: ''
  },

                                 
  {
    group: 'Minecraft & Accounts',
    id: 'mc.server.host',
    envKey: 'MC_HOST',
    label: 'Minecraft Server Host',
    description: 'Server address (e.g. donutsmp.net)',
    type: 'string',
    default: 'donutsmp.net'
  },
  {
    group: 'Minecraft & Accounts',
    id: 'mc.server.port',
    envKey: 'MC_PORT',
    label: 'Minecraft Server Port',
    description: 'Server connection port (default 25565)',
    type: 'number',
    default: 25565
  },
  {
    group: 'Minecraft & Accounts',
    id: 'mc.server.version',
    envKey: 'MC_VERSION',
    label: 'Minecraft Version',
    description: 'Target protocol version (e.g. 1.21.1)',
    type: 'string',
    default: '1.21.1'
  },
  {
    group: 'Minecraft & Accounts',
    id: 'mc.home.command',
    envKey: 'MC_HOME_COMMAND',
    label: 'Default Home Command',
    description: 'Command used for Ender Chest storage & returning home after deliveries (e.g. /home 1)',
    type: 'string',
    default: '/home 1'
  },
  {
    group: 'Minecraft & Accounts',
    id: 'mc.autoLeaveAfterDelivery',
    envKey: 'MC_AUTO_LEAVE',
    label: 'Auto Leave After Delivery',
    description: 'Compatibility setting; Session Mode controls account lifetime',
    type: 'boolean',
    default: false
  },
  {
    group: 'Minecraft & Accounts',
    id: 'mc.server.reconnectDelayMs',
    envKey: 'MC_RECONNECT_DELAY_MS',
    label: 'Reconnect Base Delay (ms)',
    description: 'Base delay before bot automatically reconnects after disconnection',
    type: 'number',
    default: 30000
  },

                            
  {
    group: 'Litecoin Wallet',
    id: 'wallet.ltc.mnemonic',
    envKey: 'LTC_MNEMONIC',
    label: 'Wallet 12/24 Seed Phrase',
    description: 'BIP39 recovery mnemonic for automated payouts',
    type: 'secret',
    default: ''
  },
  {
    group: 'Litecoin Wallet',
    id: 'wallet.ltc.wif',
    envKey: 'LTC_WIF',
    label: 'Wallet Private Key (WIF)',
    description: 'Alternative private key in Wallet Import Format',
    type: 'secret',
    default: ''
  },
  {
    group: 'Litecoin Wallet',
    id: 'wallet.ltc.sendEnabled',
    envKey: 'LTC_SEND_ENABLED',
    label: 'Automated Payouts Enabled',
    description: 'Allow sending real Litecoin transactions to sellers',
    type: 'boolean',
    default: false
  },
  {
    group: 'Litecoin Wallet',
    id: 'wallet.ltc.feeSatPerVb',
    envKey: 'LTC_FEE_PER_VB',
    label: 'Mining Fee (sat/vB)',
    description: 'Fee rate for transaction confirmation speed',
    type: 'number',
    default: 8
  },
  {
    group: 'Litecoin Wallet',
    id: 'wallet.ltc.blockcypherToken',
    envKey: 'BLOCKCYPHER_TOKEN',
    label: 'BlockCypher API Token',
    description: 'Optional API token for higher broadcast and query rate limits',
    type: 'secret',
    default: ''
  },

                                     
  {
    group: 'Security & API',
    id: 'security.api.key',
    envKey: 'API_KEY',
    label: 'Dashboard API Key',
    description: 'Secret bearer authentication key for accessing this control dashboard',
    type: 'secret',
    default: ''
  },
  {
    group: 'Security & API',
    id: 'security.api.port',
    envKey: 'API_PORT',
    label: 'Web Server Port',
    description: 'Port number the web dashboard binds to (default 4201)',
    type: 'number',
    default: 4201
  },
  {
    group: 'Security & API',
    id: 'security.api.host',
    envKey: 'API_HOST',
    label: 'Web Server Host',
    description: 'Bind interface (0.0.0.0 for all interfaces, 127.0.0.1 for local only)',
    type: 'string',
    default: '127.0.0.1'
  },

                             

  {
    group: 'AutoSell Economy',
    id: 'pricing.money.ratePerMillion',
    envKey: 'MONEY_RATE_PER_MILLION',
    label: 'Payout Rate ($ USD per 1M Coins)',
    description: 'LTC equivalent paid to sellers per 1,000,000 DonutSMP coins',
    type: 'number',
    default: 0.027
  },
  {
    group: 'AutoSell Economy',
    id: 'pricing.spawner.priceUsd',
    envKey: 'SPAWNER_PRICE_USD',
    label: 'Payout Rate ($ USD per Skeleton Spawner)',
    description: 'LTC equivalent paid to sellers per 1 Skeleton Spawner',
    type: 'number',
    default: 0.05
  }
];

function syncToEnvFile(updates) {
  try {
    const envPath = path.resolve('.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const lines = envContent.split(/\r?\n/);
    const existingKeys = new Set();
    const updatedLines = lines.map((line) => {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (match) {
        const k = match[1];
        existingKeys.add(k);
        if (Object.prototype.hasOwnProperty.call(updates, k)) {
          return `${k}=${updates[k]}`;
        }
      }
      return line;
    });

                                          
    const newLines = [];
    for (const [k, v] of Object.entries(updates)) {
      if (!existingKeys.has(k) && v !== undefined && v !== '') {
        newLines.push(`${k}=${v}`);
      }
    }

    if (newLines.length > 0) {
      if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== '') {
        updatedLines.push('');
      }
      updatedLines.push('# Added via AutoSell Dashboard Environment Studio');
      updatedLines.push(...newLines);
    }

    fs.writeFileSync(envPath, updatedLines.join('\n'), 'utf8');
  } catch (err) {
    console.error('Failed to sync to .env file:', err.message);
  }
}

                                                                             
router.get('/', async (req, res) => {
  const result = [];
  const s = services.settings;

  for (const item of ENV_MAPPINGS) {
    let currentVal = undefined;

                                 
    if (s) {
      try {
        if (item.type === 'secret') {
          currentVal = await s.get(item.id);
        } else if (typeof s.getSync === 'function') {
          currentVal = s.getSync(item.id);
        }
      } catch {}
    }

                                    
    if (currentVal === undefined || currentVal === '' || currentVal === null) {
      if (process.env[item.envKey] !== undefined) {
        currentVal = process.env[item.envKey];
      }
    }

                             
    if (currentVal === undefined || currentVal === null) {
      currentVal = item.default;
    }

                    
    if (item.type === 'number' && typeof currentVal === 'string') {
      currentVal = Number(currentVal) || item.default;
    } else if (item.type === 'boolean' && typeof currentVal === 'string') {
      currentVal = currentVal === 'true' || currentVal === '1';
    }

    const hasValue = Boolean(currentVal && String(currentVal).trim() !== '');

    result.push({
      ...item,
      value: item.type === 'secret' && hasValue ? '••••••••' : currentVal,
      rawProvided: hasValue,
      isSet: hasValue
    });
  }

  res.json({
    success: true,
    variables: result
  });
});

                                                                                       
router.post('/', async (req, res) => {
  const { variables } = req.body || {};
  if (!variables || typeof variables !== 'object') {
    return res.status(400).json({ success: false, error: 'variables object required' });
  }

  const known = new Set(ENV_MAPPINGS.flatMap(item => [item.id,item.envKey]));
  const unknown = Object.keys(variables).filter(key => !known.has(key));
  if (unknown.length) return res.status(400).json({error:'These settings belong in Pairs or Eldorado Setup, or are unsupported: '+unknown.join(', ')});
  const s = services.settings;
  const envUpdates = {};
  const changedList = [];
  if (!s?.set) return res.status(503).json({ success: false, error: 'Settings unavailable' });

  for (const item of ENV_MAPPINGS) {
                                         
    let submittedVal = undefined;
    if (Object.prototype.hasOwnProperty.call(variables, item.id)) {
      submittedVal = variables[item.id];
    } else if (Object.prototype.hasOwnProperty.call(variables, item.envKey)) {
      submittedVal = variables[item.envKey];
    }

    if (submittedVal === undefined) continue;
    if (typeof submittedVal === 'string' && /[\r\n\0]/.test(submittedVal)) return res.status(400).json({ success: false, error: 'Multiline environment values are not allowed' });

                                                               
    if (item.type === 'secret' && (submittedVal === '••••••••' || submittedVal === '')) {
      continue;
    }

                    
    let parsedVal = submittedVal;
    if (item.type === 'number') parsedVal = Number(submittedVal);
    if (item.type === 'boolean') parsedVal = submittedVal === true || submittedVal === 'true' || submittedVal === 1;

                                            
    if (s) {
      try {
        await s.set(item.id, parsedVal, 'EnvironmentStudio');
      } catch (err) {
        return res.status(400).json({ success: false, error: `Setting rejected: ${item.id}` });
      }
    }

                            
    if (item.type !== 'secret') {
      process.env[item.envKey] = String(parsedVal);
      envUpdates[item.envKey] = String(parsedVal);
    }

                                 
    if (services.config) {
      if (item.id === 'security.api.key') services.apiKey = parsedVal;
      if (item.id === 'mc.home.command') {
        if (!services.config.mc) services.config.mc = {};
        services.config.mc.homeCommand = parsedVal;
      }
    }

    changedList.push(item.envKey);
  }

                                        
  if (Object.keys(envUpdates).length > 0) {
    syncToEnvFile(envUpdates);
  }

  if (services.logger) {
    services.logger.info(
      'Environment variables updated',
      `Updated ${changedList.length} settings via Environment Studio (${changedList.slice(0, 5).join(', ')}${changedList.length > 5 ? '...' : ''}).`
    );
  }

  if (changedList.length) setImmediate(() => require('../../discord/panel').refresh().catch(() => {}));
  res.json({
    success: true,
    message: `Saved ${changedList.length} settings. Connection changes may require restart. Secrets are stored in the vault.`,
    updated: changedList
  });
});

module.exports = router;
