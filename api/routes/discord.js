'use strict';
const router = require('express').Router();
const services = require('../../services');
const { asyncHandler, requireReauth } = require('../middleware');
const { isSnowflake } = require('../../discord/ids');
const { postingChannel, validateTemplate } = require('../../discord/dashboard-validation');
const templateStore = require('../../discord/live-panel-template');

const FIELDS = [
  ['discord.bot.token', 'Bot token', true],
  ['discord.guild.id', 'Server ID'],
  ['discord.user.ownerId', 'Owner user ID'],
  ['discord.role.admin', 'Admin role ID'],
  ['discord.channel.logs', 'Logs channel ID'],
  ['discord.category.sell', 'Selling tickets category ID'],
  ['discord.role.sold', 'Completed seller role ID'],
  ['discord.channel.vouch', 'Vouch channel ID'],
  ['discord.role.automodExempt', 'Moderation exempt role ID'],
];
const FIELD_MAP = new Map(FIELDS.map(field => [field[0], field]));
const CHANNEL_KEYS = ['discord.channel.logs', 'discord.channel.vouch', 'discord.category.sell'];
const ROLE_KEYS = ['discord.role.admin', 'discord.role.sold', 'discord.role.automodExempt'];

function httpError(status, message) {
  const error = Error(message);
  error.statusCode = status;
  return error;
}

function requireSettings() {
  if (!services.settings) throw httpError(503, 'Discord settings are unavailable.');
}

function currentGuildId() {
  return services.config?.discord?.guildId || null;
}

function buyingSnapshot() {
  const store = services.store;
  return {
    pricePerSpawnerUsd: store?.getPrice?.() ?? null,
    ratePerMillion: store?.getRate?.() ?? null,
    moneyEnabled: store?.buyMoneyEnabled?.() ?? null,
    spawnerEnabled: store?.buySkellyEnabled?.() ?? null,
    paused: store?.autosellPaused?.() ?? null,
  };
}

async function panelPreview(template) {
  const design = require('../../discord/panel-designs');
  const snapshot = await require('../../discord/panel').snapshot();
  const display = design.computeDisplay(snapshot, services.store.buyMoneyEnabled(),
    services.store.buySkellyEnabled(), services.store.autosellPaused());
  if (!template) return { display, embed: null };
  return { display, embed: templateStore.render(template, display).toJSON() };
}

async function guildInventory() {
  if (!services.discordClient?.isReady?.()) return { guild: null, channels: [], roles: [], error: '' };
  const guildId = currentGuildId();
  if (!isSnowflake(guildId)) return { guild: null, channels: [], roles: [], error: 'Save a valid Discord server ID first.' };
  try {
    const guild = await services.discordClient.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const roles = await guild.roles.fetch();
    return {
      guild: { id: guild.id, name: guild.name },
      channels: [...channels.values()].filter(Boolean).map(channel => ({
        id: channel.id, name: channel.name, parent: channel.parent?.name || '',
        type: channel.type,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      roles: [...roles.values()].filter(Boolean).map(role => ({
        id: role.id, name: role.name, color: role.hexColor || null, managed: Boolean(role.managed),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      error: '',
    };
  } catch (error) {
    return { guild: null, channels: [], roles: [], error: 'Could not read the Discord server. Check the bot connection and permissions.' };
  }
}

async function panelState() {
  const panel = services.store?.getPanel?.() || null;
  if (!panel) return { panel: null, stale: null, reason: '' };
  if (!services.discordClient?.isReady?.()) return { panel, stale: null, reason: 'Connect the bot to verify this saved panel.' };
  try {
    const channel = await services.discordClient.channels.fetch(panel.channelId);
    if (!channel || !channel.isTextBased()) return { panel, stale: true, reason: 'The saved panel channel no longer exists.' };
    if (channel.guildId !== currentGuildId()) return { panel, stale: true, reason: 'The saved panel belongs to a different server.' };
    if (typeof channel.messages?.fetch === 'function') await channel.messages.fetch(panel.messageId);
    return { panel, stale: false, reason: '' };
  } catch {
    return { panel, stale: true, reason: 'The saved panel message is missing. Post a new panel to replace it.' };
  }
}

function intakeChecks(fields, inventory) {
  const byId = new Map(fields.map(field => [field.id, field]));
  const channelIds = new Set((inventory.channels || []).map(channel => channel.id));
  const channelTypes = new Map((inventory.channels || []).map(channel => [channel.id, channel.type]));
  const roleIds = new Set((inventory.roles || []).map(role => role.id));
  const checks = [
    { id: 'guild', label: 'Server', state: byId.get('discord.guild.id')?.configured ? 'configured' : 'missing',
      detail: byId.get('discord.guild.id')?.configured ? 'Server ID is saved.' : 'Save the Discord server ID.' },
    { id: 'owner', label: 'Owner account', state: byId.get('discord.user.ownerId')?.configured ? 'configured' : 'missing',
      detail: byId.get('discord.user.ownerId')?.configured ? 'Owner user ID is saved.' : 'Save the owner user ID for alerts.' },
  ];
  for (const id of CHANNEL_KEYS) {
    const field = FIELD_MAP.get(id);
    const actual = byId.get(id);
    const value = actual?.value || '';
    let state = value ? 'configured' : 'missing';
    let detail = value ? 'Channel or category is saved.' : 'Not configured.';
    if (value && inventory.guild) {
      state = channelIds.has(value) ? 'ok' : 'missing';
      if (id === 'discord.category.sell' && state === 'ok' && channelTypes.get(value) !== 4) state = 'invalid';
      if (id !== 'discord.category.sell' && state === 'ok' && ![0, 5].includes(channelTypes.get(value))) state = 'invalid';
      detail = state === 'ok' ? field.label + ' is in this server.' : field.label + ' was not found in this server.';
    } else if (!inventory.guild) {
      detail = value ? 'Saved; connect the bot to verify it.' : 'Not configured.';
    }
    checks.push({ id, label: field.label, state, detail });
  }
  for (const id of ROLE_KEYS) {
    const field = FIELD_MAP.get(id);
    const actual = byId.get(id);
    const value = actual?.value || '';
    let state = value ? 'configured' : 'missing';
    let detail = value ? 'Role is saved.' : 'Not configured.';
    if (value && inventory.guild) {
      state = roleIds.has(value) ? 'ok' : 'missing';
      detail = state === 'ok' ? field.label + ' is in this server.' : field.label + ' was not found in this server.';
    }
    checks.push({ id, label: field.label, state, detail });
  }
  return checks;
}

router.get('/dashboard', asyncHandler(async (_req, res) => {
  requireSettings();
  const fields = [];
  for (const [id, label, secret] of FIELDS) {
    const raw = await services.settings.get(id);
    fields.push({ id, label, secret: Boolean(secret), value: secret ? '' : raw || '', configured: Boolean(raw) });
  }
  const inventory = await guildInventory();
  const saved = await panelState();
  const template = templateStore.load();
  const preview = await panelPreview(template);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    connected: Boolean(services.discordClient?.isReady?.()),
    botName: services.discordClient?.user?.tag || null,
    guild: inventory.guild,
    guildError: inventory.error,
    fields,
    buying: buyingSnapshot(),
    panel: saved.panel ? { ...saved.panel, stale: saved.stale, reason: saved.reason } : null,
    template,
    preview: preview.embed,
    display: preview.display,
    channels: inventory.channels,
    roles: inventory.roles,
    intake: intakeChecks(fields, inventory),
    links: {
      pairs: '#pairs',
      sellers: '#sellers',
      wallet: '#wallet',
      intake: '/intake-setup',
      operations: '/operations',
    },
  });
}));

router.post('/settings', requireReauth, asyncHandler(async (req, res) => {
  requireSettings();
  const values = req.body?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw httpError(400, 'Choose the Discord settings to save.');
  const changes = [];
  // Validate the whole submission before writing anything. A blank token keeps
  // the encrypted token that is already stored.
  for (const [id, raw] of Object.entries(values)) {
    const field = FIELD_MAP.get(id);
    if (!field || typeof raw !== 'string' || /[\r\n\0]/.test(raw)) throw httpError(400, 'Invalid Discord setting.');
    const value = raw.trim();
    if (field[2] && !value) continue;
    if (field[2] && value.length > 256) throw httpError(400, field[1] + ' is too long.');
    if (!field[2] && value && !isSnowflake(value)) throw httpError(400, field[1] + ' must be a numeric Discord ID.');
    const validation = services.settings.validate?.(id, value);
    if (validation && !validation.valid) throw httpError(400, field[1] + ' is invalid.');
    if (await services.settings.get(id) !== value) changes.push([id, value]);
  }
  for (const [id, value] of changes) await services.settings.set(id, value, 'DiscordDashboard');
  if (changes.length && typeof services.config?.bindRegistry === 'function') await services.config.bindRegistry(services.settings);
  const restartRequired = changes.some(([id]) => ['discord.bot.token', 'discord.guild.id'].includes(id));
  res.json({
    success: true,
    changed: changes.map(([id]) => id),
    restartRequired,
    message: restartRequired
      ? 'Settings saved. Restart Autosell when all payments have finished to connect this bot and server.'
      : 'Discord settings saved.',
  });
}));

router.post('/buying', requireReauth, asyncHandler(async (req, res) => {
  requireSettings();
  const body = req.body || {};
  const numbers = ['pricePerSpawnerUsd', 'ratePerMillion'];
  for (const name of numbers) {
    if (body[name] !== undefined && (!Number.isFinite(body[name]) || body[name] <= 0 || body[name] > 100000)) {
      throw httpError(400, 'Enter a positive buying rate.');
    }
  }
  for (const name of ['moneyEnabled', 'spawnerEnabled', 'paused']) {
    if (body[name] !== undefined && typeof body[name] !== 'boolean') throw httpError(400, 'Choose on or off.');
  }
  if (body.pricePerSpawnerUsd !== undefined) {
    await services.settings.set('pricing.spawner.priceUsd', body.pricePerSpawnerUsd, 'DiscordDashboard');
    services.store.setPrice(body.pricePerSpawnerUsd);
  }
  if (body.ratePerMillion !== undefined) {
    await services.settings.set('pricing.money.ratePerMillion', body.ratePerMillion, 'DiscordDashboard');
    services.store.setRate(body.ratePerMillion);
  }
  if (body.moneyEnabled !== undefined) {
    await services.settings.set('pricing.money.enabled', body.moneyEnabled, 'DiscordDashboard');
    services.store.setBuyMoneyEnabled(body.moneyEnabled);
  }
  if (body.spawnerEnabled !== undefined) {
    await services.settings.set('pricing.spawner.enabled', body.spawnerEnabled, 'DiscordDashboard');
    services.store.setBuySkellyEnabled(body.spawnerEnabled);
  }
  if (body.paused !== undefined) {
    await services.settings.set('general.bot.paused', body.paused, 'DiscordDashboard');
    services.store.setAutosellPaused(body.paused);
    services.listingManager?.requestSync?.({ pauseOnly: body.paused });
  }
  await services.config?.bindRegistry?.(services.settings);
  await require('../../discord/panel').refresh().catch(() => {});
  res.json({ success: true, buying: buyingSnapshot(), message: 'Buying controls saved.' });
}));

router.get('/channels', asyncHandler(async (_req, res) => {
  const inventory = await guildInventory();
  res.json({ success: true, channels: inventory.channels, error: inventory.error });
}));

router.get('/roles', asyncHandler(async (_req, res) => {
  const inventory = await guildInventory();
  res.json({ success: true, roles: inventory.roles, error: inventory.error });
}));

router.post('/check', requireReauth, asyncHandler(async (_req, res) => {
  requireSettings();
  if (!services.discordClient?.isReady?.()) throw httpError(409, 'The Discord bot is offline. Save its token and server ID, then restart Autosell when payments have finished.');
  const guildId = currentGuildId();
  if (!isSnowflake(guildId)) throw httpError(409, 'Save a valid Discord server ID first.');
  const guild = await services.discordClient.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw httpError(409, 'The bot could not read this server. Check that it is a member and has permission to view channels.');
  const fields = [];
  for (const [id, label, secret] of FIELDS) {
    const raw = await services.settings.get(id);
    fields.push({ id, label, secret: Boolean(secret), value: secret ? '' : raw || '', configured: Boolean(raw) });
  }
  const channels = await guild.channels.fetch();
  const roles = await guild.roles.fetch();
  const inventory = {
    guild: { id: guild.id, name: guild.name },
    channels: [...channels.values()].filter(Boolean).map(channel => ({ id: channel.id, name: channel.name, type: channel.type, parent: channel.parent?.name || '' })),
    roles: [...roles.values()].filter(Boolean).map(role => ({ id: role.id, name: role.name })),
  };
  const checks = intakeChecks(fields, inventory);
  const problems = checks.filter(check => !['ok', 'configured'].includes(check.state));
  res.json({
    success: true,
    ok: problems.length === 0,
    connected: true,
    guildName: guild.name,
    channelCount: inventory.channels.filter(channel => [0, 5].includes(channel.type)).length,
    roleCount: inventory.roles.length,
    checks,
    message: problems.length
      ? 'Review ' + problems.length + ' Discord setting' + (problems.length === 1 ? '' : 's') + ' before enabling intake.'
      : 'Connected to ' + guild.name + '. All configured channels and roles were found.',
  });
}));

router.post('/panel/preview', requireReauth, asyncHandler(async (req, res) => {
  requireSettings();
  const body = req.body?.template ?? templateStore.load();
  if (!body) throw httpError(400, 'Create an embed before previewing it.');
  const template = validateTemplate(body);
  const preview = await panelPreview(template);
  res.json({ success: true, template, display: preview.display, embed: preview.embed });
}));

router.post('/panel/save', requireReauth, asyncHandler(async (req, res) => {
  requireSettings();
  const template = validateTemplate(req.body?.template || {});
  templateStore.save(template);
  res.json({ success: true, template, message: 'Panel design saved for future posts and refreshes.' });
}));

router.post('/panel/post', requireReauth, asyncHandler(async (req, res) => {
  requireSettings();
  const channelId = req.body?.channelId;
  if (!isSnowflake(channelId)) throw httpError(400, 'Choose a Discord text channel.');
  const channel = await postingChannel(services, channelId).catch(error => { throw httpError(409, error.message); });
  if (req.body?.template) templateStore.save(validateTemplate(req.body.template));
  const panelHelper = require('../../discord/panel');
  const payload = await panelHelper.buildPanel();
  const message = await channel.send(payload).catch(error => {
    throw httpError(502, 'Discord did not accept the panel: ' + (error.message || 'the channel refused the message'));
  });
  services.store.setPanel(channel.id, message.id);
  res.json({
    success: true,
    channelId: channel.id,
    messageId: message.id,
    message: 'Panel posted to #' + channel.name + '. Autosell will keep the saved panel updated.',
  });
}));

router.post('/panel/refresh', requireReauth, asyncHandler(async (_req, res) => {
  const result = await require('../../discord/panel').refresh(true).catch(() => ({ ok: false, reason: 'failed' }));
  if (!result.ok) throw httpError(409, result.reason === 'no-panel'
    ? 'Post a panel before refreshing it.'
    : 'The saved panel could not be refreshed. Post a new panel.');
  res.json({ success: true, message: 'Saved panel refreshed.' });
}));

router.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(error.statusCode || 400).json({ success: false, error: error.message || 'Discord request failed.' });
});

module.exports = router;
