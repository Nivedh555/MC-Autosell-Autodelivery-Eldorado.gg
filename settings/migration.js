'use strict';

const fs = require('node:fs');
const path = require('node:path');

   
                                                                
   
                                     
   
async function migrateV1(registry) {
  const envPath = path.resolve('./.env');
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  }

                               
  const sellersPath = path.resolve('./data/sellers.json');
  let sellersSettings = {};
  if (fs.existsSync(sellersPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sellersPath, 'utf8'));
      if (data.settings) {
        sellersSettings = data.settings;
      }
    } catch (e) {
               
    }
  }

  const envMap = {
    DISCORD_TOKEN: 'discord.bot.token',
    GUILD_ID: 'discord.guild.id',
    ADMIN_ROLE_ID: 'discord.role.admin',
    OWNER_ID: 'discord.user.ownerId',
    LOGS_CHANNEL_ID: 'discord.channel.logs',
    SELL_CATEGORY_ID: 'discord.category.sell',
    SOLD_ROLE_ID: 'discord.role.sold',
    VOUCH_CHANNEL_ID: 'discord.channel.vouch',
    AUTOMOD_EXEMPT_ROLE_ID: 'discord.role.automodExempt',
    
    LTC_MNEMONIC: 'wallet.ltc.mnemonic',
    LTC_WIF: 'wallet.ltc.wif',
    LTC_DERIVATION_PATH: 'wallet.ltc.derivationPath',
    LTC_SEND_ENABLED: 'wallet.ltc.sendEnabled',

    BUYER1_EMAIL: 'mc.buyer1.email',
    BUYER1_IGN: 'mc.buyer1.ign',
    BUYER2_EMAIL: 'mc.buyer2.email',
    BUYER2_IGN: 'mc.buyer2.ign',
    
    MC_HOST: 'mc.server.host',
    MC_PORT: 'mc.server.port',
    MC_VERSION: 'mc.server.version',

    PRICE_PER_SPAWNER_USD: 'pricing.spawner.priceUsd',
    RATE_PER_MILLION: 'pricing.money.ratePerMillion',
    MIN_MONEY_DONUT: 'pricing.money.minAmount',
    MIN_SKELLY_COUNT: 'pricing.spawner.minAmount',
    
    SWEEP_OWNER_NAME: 'general.bot.owner',
    SWEEP_IGNS: 'treasury.sweep.igns',
    SWEEP_AUTO_MONEY: 'general.feature.autoSweep',
    SWEEP_DELAY_MS: 'treasury.sweep.delayMs',
    
    BUY_MONEY_ENABLED: 'pricing.money.enabled',
    BUY_SKELLY_ENABLED: 'pricing.spawner.enabled',
    TRUSTED_SYSTEM_ENABLED: 'general.bot.trustedSystem',
    TRUST_THRESHOLD_SALES: 'general.bot.trustThreshold',
    SINGLE_ACCOUNT_INDEX: 'general.bot.singleAccount',
    VERIFY_ENABLED: 'verify.enabled',
    AUTOSELL_PAUSED: 'general.bot.paused',
    
    LOW_BALANCE_USD: 'treasury.balance.lowUsd',
    RESTOCK_USD: 'treasury.balance.restockUsd',
    
    API_KEY: 'security.api.key',
    API_PORT: 'security.api.port',
    API_HOST: 'security.api.host',
    
    AUTH_CACHE_DIR: 'mc.auth.cacheDir'
  };

  const toImport = {};
  
                     
  for (const [envKey, regKey] of Object.entries(envMap)) {
    if (env[envKey] !== undefined && env[envKey] !== '') {
      const def = registry.definitions.get(regKey);
      if (!def) continue;

      let val = env[envKey];
      if (def.type === 'number') val = Number(val);
      if (def.type === 'boolean') val = (val === 'true' || val === '1' || val === 'yes');
      if (def.type === 'stringArray') val = val.split(',').map(s => s.trim()).filter(Boolean);

      toImport[regKey] = val;
    }
  }

                             
  const sellersMap = {
    buyMoneyEnabled: 'pricing.money.enabled',
    buySkellyEnabled: 'pricing.spawner.enabled',
    trustedSystemEnabled: 'general.bot.trustedSystem',
    singleAccountIndex: 'general.bot.singleAccount',
    trustThresholdSales: 'general.bot.trustThreshold',
    verifyEnabled: 'verify.enabled',
    autosellPaused: 'general.bot.paused',
    minMoneyDonut: 'pricing.money.minAmount',
    minSkellyCount: 'pricing.spawner.minAmount',
    lowBalanceUsd: 'treasury.balance.lowUsd',
    restockUsd: 'treasury.balance.restockUsd',
    pricePerSpawnerUsd: 'pricing.spawner.priceUsd',
    ratePerMillion: 'pricing.money.ratePerMillion'
  };

  for (const [sellersKey, regKey] of Object.entries(sellersMap)) {
    if (sellersSettings[sellersKey] !== undefined) {
      let val = sellersSettings[sellersKey];
                                                                                      
      const def = registry.definitions.get(regKey);
      if (!def) continue;
      
      if (sellersKey === 'singleAccountIndex' && def.type === 'boolean') {
        val = (val === 0);
      }

      toImport[regKey] = val;                               
    }
  }

  if (Object.keys(toImport).length > 0) {
    const { applied, errors } = await registry.import(toImport, 'system-migration');
    if (errors.length > 0) {
      console.warn('Migration warnings:', errors);
    }
  }

                
  const migratedPath = path.resolve('./.env.migrated');
  fs.writeFileSync(migratedPath, '# MIGRATED TO V2 SETTINGS REGISTRY\n' + envContent);
  fs.unlinkSync(envPath);
}

module.exports = { migrateV1 };
