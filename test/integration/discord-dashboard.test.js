'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const services = require('../../services');
const { SESSIONS, CONFIRM_TOKENS } = require('../../api/middleware');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const MESSAGE = '333333333333333333';
const OWNER = '444444444444444444';

function settingsFixture(initial = {}) {
  const values = { 'discord.bot.token': 'fixture-token', 'discord.guild.id': GUILD, 'discord.user.ownerId': OWNER, ...initial };
  return {
    values,
    definitions: new Map(),
    async get(id) { return values[id] ?? ''; },
    async set(id, value) { values[id] = value; },
    validate(id, value) { return { valid: typeof value === 'string' }; },
  };
}

function storeFixture(panel = null) {
  const state = { panel, price: 0.05, rate: 0.027, money: true, spawner: true, paused: false };
  return {
    state,
    getPanel: () => state.panel,
    setPanel: (channelId, messageId) => { state.panel = { channelId, messageId }; },
    getPrice: () => state.price, setPrice: value => { state.price = value; },
    getRate: () => state.rate, setRate: value => { state.rate = value; },
    buyMoneyEnabled: () => state.money, setBuyMoneyEnabled: value => { state.money = value; },
    buySkellyEnabled: () => state.spawner, setBuySkellyEnabled: value => { state.spawner = value; },
    autosellPaused: () => state.paused, setAutosellPaused: value => { state.paused = value; },
    getMinMoney: () => 10000000,
  };
}

function clientFixture({ send = true, permissions = true, missingMessage = false } = {}) {
  const sent = [];
  const channel = {
    id: CHANNEL, name: 'sell-here', type: 0, guildId: GUILD,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => permissions }),
    messages: { fetch: async () => { if (missingMessage) throw Error('Unknown Message'); return { id: MESSAGE }; } },
    send: async payload => { if (!send) throw Error('Missing Access'); sent.push(payload); return { id: MESSAGE }; },
  };
  const guild = {
    id: GUILD, name: 'Fixture Guild',
    channels: { fetch: async () => new Map([[CHANNEL, channel]]) },
    roles: { fetch: async () => new Map([['555555555555555555', { id: '555555555555555555', name: 'Admin' }]]) },
  };
  return {
    sent,
    client: {
      isReady: () => true,
      user: { tag: 'FixtureBot#0001' },
      guilds: { fetch: async () => guild },
      channels: { fetch: async id => id === CHANNEL ? channel : (() => { throw Error('Unknown Channel'); })() },
    },
  };
}

async function fixture(t, options = {}) {
  const settings = settingsFixture(options.settings);
  const store = storeFixture(options.panel ?? null);
  const fake = clientFixture(options);
  services.apiKey = 'fixture-owner';
  services.settings = settings;
  services.store = store;
  services.discordClient = options.offline ? null : fake.client;
  services.wallet = { enabled: false, getBalanceLitoshi: async () => null, getRate: async () => null };
  services.config = { discord: { guildId: GUILD }, bindRegistry: async () => {} };
  services.listingManager = { requestSync() {} };
  const app = express();
  app.use(express.json());
  app.use('/api/v2/discord', require('../../api/middleware').verifyAuth, require('../../api/middleware').csrfProtection, require('../../api/routes/discord'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { 'content-type': 'application/json', 'x-api-key': services.apiKey };
  const session = 'fixture-discord-session';
  const expires = Date.now() + 60000;
  SESSIONS.set(session, { expires, dashboardUntil: expires, csrfToken: 'fixture-csrf' });
  CONFIRM_TOKENS.set('fixture-discord-confirm', { subject: 'api-owner', expires });
  t.after(() => { SESSIONS.delete(session); CONFIRM_TOKENS.delete('fixture-discord-confirm'); });
  const auth = { 'content-type': 'application/json', cookie: `sessionId=${session}; csrfToken=fixture-csrf`, 'x-csrf-token': 'fixture-csrf' };
  return { base, headers, auth, settings, store, fake, channel: fake.client };
}

test('Discord dashboard masks the saved token and saving a blank token keeps it', async t => {
  const { base, headers, auth, settings } = await fixture(t);
  const dashboard = await fetch(base + '/v2/discord/dashboard', { headers });
  assert.equal(dashboard.status, 200);
  const data = await dashboard.json();
  const token = data.fields.find(field => field.id === 'discord.bot.token');
  assert.equal(token.value, '');
  assert.equal(token.configured, true);
  assert.equal(data.fields.find(field => field.id === 'discord.guild.id').value, GUILD);

  const saved = await fetch(base + '/v2/discord/settings', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ values: { 'discord.bot.token': '', 'discord.channel.logs': CHANNEL } }),
  });
  if (saved.status !== 200) assert.fail(await saved.text());
  assert.equal(settings.values['discord.bot.token'], 'fixture-token');
  assert.equal(settings.values['discord.channel.logs'], CHANNEL);

  const reloaded = await (await fetch(base + '/v2/discord/dashboard', { headers })).json();
  assert.equal(reloaded.fields.find(field => field.id === 'discord.bot.token').configured, true);
  assert.equal(reloaded.fields.find(field => field.id === 'discord.channel.logs').value, CHANNEL);
});

test('Discord mutations require owner re-authentication and reject invalid IDs', async t => {
  const { base, headers, auth } = await fixture(t);
  const denied = await fetch(base + '/v2/discord/settings', {
    method: 'POST', headers,
    body: JSON.stringify({ values: { 'discord.guild.id': GUILD } }),
  });
  assert.equal(denied.status, 403);
  const invalid = await fetch(base + '/v2/discord/settings', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ values: { 'discord.channel.logs': 'not-a-snowflake' } }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /numeric Discord ID/);
});

test('connection checks report configured channels, roles and offline failures', async t => {
  const { base, headers, auth, fake } = await fixture(t, {
    settings: { 'discord.channel.logs': CHANNEL, 'discord.channel.vouch': CHANNEL, 'discord.role.admin': '555555555555555555' },
  });
  const checked = await fetch(base + '/v2/discord/check', { method: 'POST', headers: auth, body: '{}' });
  if (checked.status !== 200) assert.fail(await checked.text());
  const data = await checked.json();
  assert.equal(data.connected, true);
  assert.equal(data.guildName, 'Fixture Guild');
  assert.equal(data.checks.find(check => check.id === 'discord.channel.logs').state, 'ok');
  assert.equal(data.checks.find(check => check.id === 'discord.category.sell').state, 'missing');

  const offline = await fixture(t, { offline: true });
  const failure = await fetch(offline.base + '/v2/discord/check', { method: 'POST', headers: offline.auth, body: '{}' });
  assert.equal(failure.status, 409);
  assert.match((await failure.json()).error, /offline/);
  assert.equal(fake.sent.length, 0);
});

test('panel posting refuses missing channel permissions and reports a stale saved panel', async t => {
  const { base, auth, store } = await fixture(t, {
    panel: { channelId: CHANNEL, messageId: MESSAGE }, permissions: false, missingMessage: true,
  });
  const denied = await fetch(base + '/v2/discord/panel/post', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ channelId: CHANNEL }),
  });
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).error, /View Channel/);
  assert.equal(store.state.panel.channelId, CHANNEL);

  const dashboard = await (await fetch(base + '/v2/discord/dashboard', { headers: auth })).json();
  assert.equal(dashboard.panel.stale, true);
  assert.match(dashboard.panel.reason, /missing|no longer/);
});

test('a permitted panel post records the exact message and preview uses the saved design', async t => {
  const { base, auth, fake, store } = await fixture(t);
  const preview = await fetch(base + '/v2/discord/panel/preview', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ template: { title: 'Sell to Autosell', description: 'Sell now', color: '#dc143c', buttonLayout: 'moneyAutosell', fields: [{ name: 'Rate', value: '{{ratePer1b}}' }] } }),
  });
  if (preview.status !== 200) assert.fail(await preview.text());
  const rendered = await preview.json();
  assert.equal(rendered.embed.title, 'Sell to Autosell');
  assert.equal(rendered.embed.fields[0].name, 'Rate');

  const posted = await fetch(base + '/v2/discord/panel/post', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ channelId: CHANNEL }),
  });
  if (posted.status !== 200) assert.fail(await posted.text());
  const result = await posted.json();
  assert.equal(result.messageId, MESSAGE);
  assert.deepEqual(store.state.panel, { channelId: CHANNEL, messageId: MESSAGE });
  assert.equal(fake.sent.length, 1);
  assert.ok(fake.sent[0].embeds?.length);
});
