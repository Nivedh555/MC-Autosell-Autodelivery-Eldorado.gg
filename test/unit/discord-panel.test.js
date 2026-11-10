'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const services = require('../../services');
const { EmbedBuilder } = require('discord.js');
const panel = require('../../discord/panel');
const designs = require('../../discord/panel-designs');
const template = require('../../discord/live-panel-template');
const original = { compute: designs.computeDisplay, render: designs.renderActive, style: designs.sellStyleActive, layout: designs.buttonLayoutActive, links: designs.linkButtonsActive, template: template.load };
designs.computeDisplay = () => ({}); designs.renderActive = () => new EmbedBuilder().setDescription('Fixture panel'); designs.sellStyleActive = () => 1; designs.buttonLayoutActive = () => 'moneyAutosell'; designs.linkButtonsActive = () => []; template.load = () => null;
after(() => { designs.computeDisplay = original.compute; designs.renderActive = original.render; designs.sellStyleActive = original.style; designs.buttonLayoutActive = original.layout; designs.linkButtonsActive = original.links; template.load = original.template; });

function fixture() {
  const events = []; const saved = [];
  services.store = { getPrice: () => 1, getRate: () => 1, buyMoneyEnabled: () => true, buySkellyEnabled: () => false, autosellPaused: () => false, setPanel: (...args) => saved.push(args) };
  services.wallet = { enabled: true, getBalanceLitoshi: async () => { events.push('balance'); return 100000000; }, getRate: async () => 50 };
  const interaction = {
    deferred: false,
    deferReply: async options => { assert.equal(options.flags, 64); events.push('ack'); interaction.deferred = true; },
    channel: { id: '111111111111111111', send: async () => { assert.equal(interaction.deferred, true); events.push('panel'); return { id: '222222222222222222' }; } },
    reply: async () => { throw Error('Second initial acknowledgement is forbidden'); },
    editReply: async () => { events.push('complete'); },
  };
  return { events, saved, interaction };
}

test('sell-panel acknowledges immediately, before slow wallet or channel work', async () => {
  const f = fixture(); let release;
  services.wallet.getBalanceLitoshi = () => { f.events.push('balance'); return new Promise(resolve => { release = resolve; }); };
  const pending = panel.postPanel(f.interaction);
  assert.deepEqual(f.events, ['ack']); await Promise.resolve();
  assert.deepEqual(f.events, ['ack', 'balance']); release(100000000); await pending;
  assert.deepEqual(f.events, ['ack', 'balance', 'panel', 'complete']);
  assert.deepEqual(f.saved, [['111111111111111111', '222222222222222222']]);
});

test('an expired Discord interaction never posts an orphan or duplicate sell panel', async () => {
  const f = fixture(); f.interaction.deferReply = async () => { throw Object.assign(Error('Unknown interaction'), { code: 10062 }); };
  await assert.rejects(panel.postPanel(f.interaction), /Unknown interaction/);
  assert.deepEqual(f.events, []); assert.deepEqual(f.saved, []);
});
