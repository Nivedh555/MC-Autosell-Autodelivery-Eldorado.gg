'use strict';
const fs = require('node:fs'), path = require('node:path');
const { EmbedBuilder } = require('discord.js');
const file = require('../ops/runtime-paths').data('custom-panel.json');
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function save(template) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(template, null, 2)); }
function clear() { if (fs.existsSync(file)) fs.unlinkSync(file); }
function binding(field) {
  const name = String(field.name || '').toLowerCase();
  if (/max.*(skell|spawn)/.test(name)) return 'skellyCap';
  if (/max.*(sell|money|coin)/.test(name)) return 'moneyCap';
  if (/(price|rate).*(skell|spawn)/.test(name)) return 'pricePerSkelly';
  if (/rate|per.*billion|price.*billion/.test(name)) return 'ratePer1b';
  if (/balance|wallet/.test(name)) return /ltc|litecoin/.test(name) ? 'ltcStr' : 'usdStr';
  if (/minimum|min.*(sell|money|coin)/.test(name)) return 'minMoneyStr';
  return null;
}
function render(template, display) {
  const text = value => String(value || '').replace(/\{\{(ratePer1b|usdStr|ltcStr|moneyCap|skellyCap|minMoneyStr|pricePerSkelly)\}\}/g, (_, key) => display[key]);
  let description = text(template.description || '> ⚙️ Setup your IGN and LTC address using Settings\n\n1. Click Sell and use the exact command shown.\n2. Use the same IGN you pay from in-game.\n3. Minimum sale: {{minMoneyStr}}');
                                                                 
  description = description.replace(/Payments under\s+`?[^\s`]+`?\s+are ignored/gi, 'Payments under ' + display.minMoneyStr + ' are ignored');
  const embed = new EmbedBuilder().setTitle(text(template.title || '💰 Money AutoSell'))
    .setDescription((display.paused ? '⏸️ Autosell is paused.\n\n' : '') + description)
    .setColor(/^#?[a-f\d]{6}$/i.test(template.color || '') ? parseInt(template.color.replace('#', ''), 16) : 0xdc143c)
    .setFooter({ text: text(template.footer || 'Paid in LTC • secure linking • /mystats') }).setTimestamp()
    .setThumbnail(require('./payments').LTC_LOGO);
  if (template.author) embed.setAuthor({ name: typeof template.author === 'string' ? template.author : template.author.name || 'Litecoin payouts', iconURL: require('./payments').LTC_LOGO });
  const fields = template.fields?.length ? template.fields : [
    { name: '💱 Current Rate', boxed: true }, { name: '💵 USD Balance', boxed: true }, { name: '📈 Max Sell', boxed: true },
  ];
  embed.addFields(...fields.slice(0, 25).map(field => {
    const key = binding(field), value = key ? display[key] : text(field.value) || '—';
    return { name: text(field.name || 'Details'), value: field.boxed ? '```\n' + value + '\n```' : value, inline: Boolean(field.inline) };
  }));
  return embed;
}
module.exports = { load, save, clear, binding, render };
