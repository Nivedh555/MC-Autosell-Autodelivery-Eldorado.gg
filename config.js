'use strict';

   
                                               
                                                                
                                                                                   
                                                                              
   

require('dotenv').config({ path: require('./ops/runtime-paths').envFile });

const { loadDefaults } = require('./settings/registry');

                                                                              
                                                                     
const registry = {
  definitions: new Map(),
  register(definition) { this.definitions.set(definition.id, definition); },
  getSync(id) { return structuredClone(this.definitions.get(id)?.default); },
};
loadDefaults(registry);

const overrides = new Map();
let activeRegistry = registry;

function get(id) {
  if (overrides.has(id)) return overrides.get(id);
  try {
    return activeRegistry.getSync(id);
  } catch {
    const def = registry.definitions.get(id);
    return def ? def.default : undefined;
  }
}

function set(id, val) {
  overrides.set(id, val);
  try {
    if (typeof activeRegistry.set === 'function') {
      activeRegistry.set(id, val, 'legacy-config').catch(() => {});
    }
  } catch {}
}

                                                                     
const config = {
  async bindRegistry(settings) {
    activeRegistry = settings;
                                                                                           
    for (const [id, definition] of settings.definitions) if (definition.secret) overrides.set(id, await settings.get(id));
    settings.store.on('change', (id, value) => {
      if (settings.definitions.get(id)?.secret) overrides.set(id, value);
    });
  },
  discord: {
    get token() { return get('discord.bot.token') || process.env.DISCORD_TOKEN || ''; },
    get guildId() { return get('discord.guild.id'); },
    get adminRoleId() { return get('discord.role.admin'); },
    get logsChannelId() { return get('discord.channel.logs'); },
    get sellCategoryId() { return get('discord.category.sell'); },
    get soldRoleId() { return get('discord.role.sold'); },
    get vouchChannelId() { return get('discord.channel.vouch'); },
    get automodExemptRoleId() { return get('discord.role.automodExempt'); },
    get ownerId() { return get('discord.user.ownerId'); },
  },

  wallet: {
    get mnemonic() { return get('wallet.ltc.mnemonic'); },
    get wif() { return get('wallet.ltc.wif'); },
    get derivationPath() { return get('wallet.ltc.derivationPath'); },
    get addressType() { return get('wallet.ltc.addressType'); },
    get spendUnconfirmed() { return get('wallet.ltc.spendUnconfirmed'); },
    get sendEnabled() { return get('wallet.ltc.sendEnabled'); },
    get feeSatPerVb() { return get('wallet.ltc.feeSatPerVb'); },
    get provider() { return get('wallet.ltc.provider'); },
    get apiBase() { return get('wallet.ltc.apiBase'); },
    get blockcypherBase() { return get('wallet.ltc.blockcypherBase'); },
    get blockcypherToken() { return get('wallet.ltc.blockcypherToken'); },
    get priceApiUrl() { return get('network.coingecko.url'); },
    priceCacheMs: 60000,
  },

  buy: {
    get pricePerSpawnerUsd() { return get('pricing.spawner.priceUsd'); },
    get itemName() { return get('pricing.spawner.itemName'); },
    get match() { return get('pricing.spawner.match'); },
    maxPerSell: 512,
  },

  economy: {
    get ratePerMillion() { return get('pricing.money.ratePerMillion'); },
  },

  sweep: {
    get igns() { return get('treasury.sweep.igns'); },
    set igns(v) { set('treasury.sweep.igns', v); },
    get ownerName() { return get('general.bot.owner'); },
    set ownerName(v) { set('general.bot.owner', v); },
    get autoMoney() { return get('general.feature.autoSweep'); },
    set autoMoney(v) { set('general.feature.autoSweep', v); },
    get delayMs() { return get('treasury.sweep.delayMs'); },
    set delayMs(v) { set('treasury.sweep.delayMs', v); },
  },

  setup: {
    get buyMoneyEnabled() { return get('pricing.money.enabled'); },
    set buyMoneyEnabled(v) { set('pricing.money.enabled', v); },
    get buySkellyEnabled() { return get('pricing.spawner.enabled'); },
    set buySkellyEnabled(v) { set('pricing.spawner.enabled', v); },
    get trustedSystemEnabled() { return get('general.bot.trustedSystem'); },
    set trustedSystemEnabled(v) { set('general.bot.trustedSystem', v); },
    get trustThresholdSales() { return get('general.bot.trustThreshold'); },
    set trustThresholdSales(v) { set('general.bot.trustThreshold', v); },
    get verifyEnabled() { return get('verify.enabled'); },
    set verifyEnabled(v) { set('verify.enabled', v); },
    get autosellPaused() { return get('general.bot.paused'); },
    set autosellPaused(v) { set('general.bot.paused', v); },
    get minMoneyDonut() { return get('pricing.money.minAmount'); },
    set minMoneyDonut(v) { set('pricing.money.minAmount', v); },
    get minSkellyCount() { return get('pricing.spawner.minAmount'); },
    set minSkellyCount(v) { set('pricing.spawner.minAmount', v); },
    get lowBalanceUsd() { return get('treasury.balance.lowUsd'); },
    set lowBalanceUsd(v) { set('treasury.balance.lowUsd', v); },
    get restockUsd() { return get('treasury.balance.restockUsd'); },
    set restockUsd(v) { set('treasury.balance.restockUsd', v); },
  },

  verify: {
    get enabled() { return get('verify.enabled'); },
    get min() { return get('verify.amount.min'); },
    get max() { return get('verify.amount.max'); },
    get ttlMs() { return get('verify.ttl.minutes') * 60000; },
  },

  mc: {
    get host() { return get('mc.server.host'); },
    set host(v) { set('mc.server.host', v); },
    get port() { return get('mc.server.port'); },
    set port(v) { set('mc.server.port', v); },
    get version() { return get('mc.server.version'); },
    set version(v) { set('mc.server.version', v); },
    get email() { return get('mc.buyer1.email'); },
    set email(v) { set('mc.buyer1.email', v); },
    get ign() { return get('mc.buyer1.ign'); },
    set ign(v) { set('mc.buyer1.ign', v); },
    get buyer1Email() { return get('mc.buyer1.email'); },
    set buyer1Email(v) { set('mc.buyer1.email', v); },
    get buyer1Ign() { return get('mc.buyer1.ign'); },
    set buyer1Ign(v) { set('mc.buyer1.ign', v); },
    get verifyEmail() { return get('mc.buyer2.email'); },
    set verifyEmail(v) { set('mc.buyer2.email', v); },
    get verifyIgn() { return get('mc.buyer2.ign'); },
    set verifyIgn(v) { set('mc.buyer2.ign', v); },
    get buyer2Email() { return get('mc.buyer2.email'); },
    set buyer2Email(v) { set('mc.buyer2.email', v); },
    get buyer2Ign() { return get('mc.buyer2.ign'); },
    set buyer2Ign(v) { set('mc.buyer2.ign', v); },
    get authCacheDir() { return get('mc.auth.cacheDir'); },
    set authCacheDir(v) { set('mc.auth.cacheDir', v); },
    get reconnectDelayMs() { return get('mc.server.reconnectDelayMs'); },
    set reconnectDelayMs(v) { set('mc.server.reconnectDelayMs', v); },
    get hostFallbacks() { return get('mc.server.hostFallbacks') || []; },
    set hostFallbacks(v) { set('mc.server.hostFallbacks', v); },
    get spawnCommands() { return get('session.spawn.commands'); },
    set spawnCommands(v) { set('session.spawn.commands', v); },
    get chatMode() { return get('session.chat.commandsOnly') ? 'commandsOnly' : 'all'; },
    set chatMode(v) { set('session.chat.commandsOnly', v === 'commandsOnly'); },
    get debugChat() { return get('payment.chat.debug'); },
    set debugChat(v) { set('payment.chat.debug', v); },
  },

  antiAfk: {
    get enabled() { return get('session.antiAfk.enabled'); },
    get intervalMs() { return get('session.antiAfk.intervalMs'); },
  },

  collect: {
    get tpaTimeoutMs() { return get('payment.collect.tpaTimeout'); },
    get collectMs() { return get('payment.collect.delayMs'); },
    get collectRadius() { return get('payment.collect.radius'); },
    get tpaUsesGui() { return get('payment.collect.tpaUsesGui'); },
    get tpaConfirmSlot() { return get('payment.collect.tpaConfirmSlot'); },
    get tpaGuiDelayMs() { return get('payment.collect.tpaGuiDelayMs'); },
    get enderChestSearchRadius() { return get('payment.collect.enderChestSearchRadius'); },
    get enderChestPlaceTimeoutMs() { return get('payment.collect.enderChestPlaceTimeoutMs'); },
  },

  api: {
    get key() { return get('security.api.key') || process.env.API_KEY || ''; },
    get port() { return get('security.api.port') || (process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 4201); },
    get host() { return get('security.api.host') || '127.0.0.1'; },
  },

  sellersFile: './data/sellers.json',
  ordersFile: './data/sell-orders.json',
};

module.exports = config;
