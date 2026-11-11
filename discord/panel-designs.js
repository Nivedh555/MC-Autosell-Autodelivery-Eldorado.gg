'use strict';

   
                                                                                  
                                                                         
  
                                                                                   
                                                                              
                                                               
  
                                                                                   
                                                                                  
                                                                      
   

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ButtonStyle } = require('discord.js');
const { formatDonut } = require('../sell/money-format');

const ORANGE = 0xdc143c;
const FOOTER = 'Instant LTC payouts • secure one-time linking • /mystats • /top-sellers';

function vouchUrl() {
  try {
    const { guildId, vouchChannelId } = require('../services').config.discord;
    if (!vouchChannelId || !guildId) return null;
    return `https://discord.com/channels/${guildId}/${vouchChannelId}`;
  } catch {
    return null;
  }
}
const FILE = path.resolve(__dirname, '..', 'data', 'panel-design.json');
const LOGO = () => require('./payments').LTC_LOGO;

                                                                               

                                                                              
function computeDisplay(s, moneyOn, skellyOn, paused) {
  const usdStr = s.usd != null ? `$${s.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
  const ratePerBNum = s.ratePerM * 1000;
  const ratePer1b =
    `$${Number.isInteger(ratePerBNum) ? ratePerBNum : Number(ratePerBNum.toFixed(2))} per 1b`;
  let minMoneyStr = '10m';
  try {
    const store = require('../services').store;
    if (store && typeof store.getMinMoney === 'function') minMoneyStr = formatDonut(store.getMinMoney()) || '10m';
  } catch {
                 
  }
  return {
    moneyOn,
    skellyOn,
    paused,
    ratePerM: `$${Number(s.ratePerM.toFixed(4))}`,
                                                                                
    ratePerB: `$${(s.ratePerM * 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    ratePer1b,
    minMoneyStr,
    pricePerSkelly: `$${s.price.toFixed(2)}`,
    usdStr,
    ltcStr: Number.isFinite(s.ltc) ? `${s.ltc.toFixed(4)} LTC` : 'Not available',
    moneyCap: s.canDonut != null ? formatDonut(s.canDonut) : '—',
    skellyCap: s.canSkellys != null ? `${s.canSkellys.toLocaleString('en-US')} skellys` : '—',
  };
}

const box = (v) => '```\n' + v + '\n```';
function pausedPrefix(d) {
  return d.paused ? '⏸️ **Autosell is currently PAUSED — please check back soon.**\n\n' : '';
}
function sellLine(d) {
  return d.moneyOn && d.skellyOn ? '💰 **Sell Money** or 💀 **Sell Skellys**' : d.moneyOn ? '💰 **Sell Money**' : d.skellyOn ? '💀 **Sell Skellys**' : '_(selling is paused right now)_';
}
function rateValue(d) {
  const lines = [];
  lines.push(d.moneyOn ? `${d.ratePerM}/M  (${d.ratePerB}/B)` : `💰 ${d.ratePerM}/M  (${d.ratePerB}/B) — _not buying_`);
  lines.push(d.skellyOn ? `${d.pricePerSkelly} per skelly` : `💀 ${d.pricePerSkelly} per skelly — _not buying_`);
  return d.paused ? `⏸️ Autosell paused\n${lines.join('\n')}` : lines.join('\n');
}
function boxedFields(d) {
  const f = [
    { name: '💱 Current Rate', value: box(rateValue(d)), inline: false },
    { name: '🏦 Wallet Balance', value: box(`${d.usdStr}  •  ${d.ltcStr}`), inline: false },
  ];
  if (d.moneyOn) f.push({ name: '💰 Max Money Sell', value: box(d.moneyCap), inline: false });
  if (d.skellyOn) f.push({ name: '💀 Max Skelly Sell', value: box(d.skellyCap), inline: false });
  return f;
}
function inlineTiles(d) {
  const f = [
    { name: '💱 Rate', value: `**${d.ratePerM}**/M\n(${d.ratePerB}/B)`, inline: true },
    { name: '🏦 Balance', value: `**${d.usdStr}**\n${d.ltcStr}`, inline: true },
    { name: '​', value: '​', inline: true },
  ];
  if (d.moneyOn) f.push({ name: '💰 Max Money', value: `**${d.moneyCap}**`, inline: true });
  if (d.skellyOn) f.push({ name: '💀 Max Skellys', value: `**${d.skellyCap}**`, inline: true });
  f.push({ name: '​', value: '​', inline: true });
  return f;
}

                                                                               
                                                                         

                                                                                      
function d1(d) {
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪙 DonutSMP Autosell — Sell for Litecoin')
    .setThumbnail(LOGO())
    .setDescription(
      pausedPrefix(d) +
        '**Sell your in-game money or skeleton spawners and get paid instantly in Litecoin.**\n\n' +
        '## How it works\n' +
        '**1.** ⚙️ **Settings** — link your IGN + LTC address _(one-time)_\n' +
        `**2.** ${sellLine(d)} — enter how much\n` +
        '**3.** Pick 🌐 **Public** or 🕵️ **Anonymous** for the sale\n' +
        '**4.** 💸 Get **paid in Litecoin**, straight to your wallet'
    )
    .addFields(...boxedFields(d))
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

                                                            
function d2(d) {
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setAuthor({ name: 'DonutSMP Autosell', iconURL: LOGO() })
    .setTitle('Sell your money & spawners for Litecoin 🪙')
    .setThumbnail(LOGO())
    .setDescription(pausedPrefix(d) + '**Instant payouts, straight to your wallet.**\n\n**⚙️ Link once → 💰 Sell → 🌐/🕵️ Public/Anon → 💸 Paid in LTC**')
    .addFields(...inlineTiles(d))
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

                                                                 
function d3(d) {
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪙 DonutSMP Autosell')
    .setThumbnail(LOGO())
    .setDescription(pausedPrefix(d) + '**Sell in-game money or spawners → paid instantly in Litecoin.**\n\n1️⃣ **Link** IGN + LTC  ·  2️⃣ **Sell**  ·  3️⃣ **Public / Anon**  ·  4️⃣ **Get paid**')
    .addFields(...boxedFields(d))
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

                                                             
function d4(d) {
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪙 DonutSMP Autosell — Sell for Litecoin')
    .setThumbnail(LOGO())
    .setDescription(
      pausedPrefix(d) +
        '_Sell your money & spawners for **real Litecoin**, instantly._\n\n' +
        `## 💱 ${d.ratePerM}/M  (${d.ratePerB}/B)\n` +
        (d.moneyOn ? `### 💰 Max sell — ${d.moneyCap}\n` : '') +
        (d.skellyOn ? `### 💀 Max sell — ${d.skellyCap}\n` : '') +
        `\n🏦 **Wallet:** ${d.usdStr} · ${d.ltcStr}\n\n` +
        '**⚙️ Link → 💰 Sell → 🌐/🕵️ Pick → 💸 Paid**'
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

                                                                
function d5(d) {
  const f = [
    { name: '💱 Rate', value: `**${d.ratePerM}**/M\n(${d.ratePerB}/B)`, inline: true },
    { name: '🏦 Balance', value: `**${d.usdStr}**`, inline: true },
    { name: '⛓️ In LTC', value: d.ltcStr, inline: true },
  ];
  if (d.moneyOn) f.push({ name: '💰 Max money', value: `**${d.moneyCap}**`, inline: true });
  if (d.skellyOn) f.push({ name: '💀 Max skellys', value: `**${d.skellyCap}**`, inline: true });
  f.push({ name: '⚡ Payout', value: '**Instant**', inline: true });
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪙 DonutSMP Autosell — Sell for Litecoin')
    .setThumbnail(LOGO())
    .setDescription(pausedPrefix(d) + '**Link IGN + LTC once → sell → pick public/anon → paid instantly.**')
    .addFields(...f)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

                                                                           
function d6(d) {
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🛡️ DonutSMP Autosell — Trusted & Instant')
    .setThumbnail(LOGO())
    .setDescription(
      pausedPrefix(d) +
        '✅ **Instant payouts**  ·  ✅ **Real Litecoin**  ·  ✅ **Vouched**\n\n' +
        '**Sell your money or spawners and get paid to your own wallet in seconds.**\n\n' +
        `**1.** ⚙️ Link  **·  2.** ${d.moneyOn && d.skellyOn ? '💰/💀 Sell' : d.moneyOn ? '💰 Sell' : '💀 Sell'}  **·  3.** 🌐/🕵️ Pick  **·  4.** 💸 Paid`
    )
    .addFields(...inlineTiles(d))
    .setFooter({ text: FOOTER + ' • ⭐ vouches below' })
    .setTimestamp();
}

                                                                       
function d7(d) {
  const pad = (l, v) => (l + ':').padEnd(15, ' ') + v;
  const lines = [pad('Rate', `${d.ratePerM}/M (${d.ratePerB}/B)`), pad('Wallet', `${d.usdStr} (${d.ltcStr})`)];
  if (d.moneyOn) lines.push(pad('Max money', d.moneyCap));
  if (d.skellyOn) lines.push(pad('Max skellys', d.skellyCap));
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪙 DonutSMP Autosell — Sell for Litecoin')
    .setDescription(pausedPrefix(d) + '**Instant Litecoin for your in-game money & spawners.**\n' + '```\n' + lines.join('\n') + '\n```' + '**⚙️ Link → 💰 Sell → 🌐/🕵️ Pick → 💸 Paid**')
    .setFooter({ text: FOOTER });
}

                                                                             
function d8(d) {
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪙 DonutSMP Autosell')
    .setThumbnail(LOGO())
    .setDescription(
      pausedPrefix(d) +
        '**💸 Sell your in-game money & spawners for real Litecoin — instantly.**\n\n' +
        '**__How it works__**\n' +
        '**1.** ⚙️ Link IGN + LTC _(one-time)_\n' +
        `**2.** ${sellLine(d)} — enter amount\n` +
        '**3.** 🌐 **Public** or 🕵️ **Anonymous**\n' +
        '**4.** 💸 **Paid instantly** to your wallet'
    )
    .addFields(...inlineTiles(d))
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

const DESIGNS = [
  { label: 'Bright Steps', embed: d1, sellStyle: ButtonStyle.Success },
  { label: 'Clean Tiles', embed: d2, sellStyle: ButtonStyle.Success },
  { label: 'Boxed Cards', embed: d3, sellStyle: ButtonStyle.Primary },
  { label: 'Hero Rate', embed: d4, sellStyle: ButtonStyle.Success },
  { label: 'Compact Bright', embed: d5, sellStyle: ButtonStyle.Primary },
  { label: 'Trust + Vouch', embed: d6, sellStyle: ButtonStyle.Success, links: [{ label: 'Vouches', emoji: '⭐', vouch: true }] },
  { label: 'All-in-Box', embed: d7, sellStyle: ButtonStyle.Secondary },
  { label: 'Modern Sections', embed: d8, sellStyle: ButtonStyle.Success },
];

                                                                               
                                                                              

const PURPLE = 0x9b59b6;
const GOLD = 0xf1c40f;
const NEON = 0x00ff88;
const ICE = 0x74c0fc;
const CRIMSON = 0xdc143c;
const SLATE = 0x5865f2;

function statsBlock(d) {
  const rows = [`RATE ${d.ratePerM}/M (${d.ratePerB}/B)`, `WALLET ${d.usdStr} / ${d.ltcStr}`];
  if (d.moneyOn) rows.push(`MAX MONEY ${d.moneyCap}`);
  if (d.skellyOn) rows.push(`MAX SKELLY ${d.skellyCap}`);
  return '```\n' + rows.join('\n') + '\n```';
}

                                                                    
function t1(d) {
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle('▸ AUTOBUY TERMINAL')
    .setDescription(
      pausedPrefix(d) +
        '```\n' +
        '╔══════════════════════════════╗\n' +
        '║  DONUTSMP  →  LTC  →  YOU    ║\n' +
        '╚══════════════════════════════╝\n' +
        '```\n' +
        statsBlock(d) +
        '\n**> link ign + wallet  →  sell  →  receive ltc**'
    )
    .setFooter({ text: 'system online • payouts instant • /stats' });
}

                                                               
function t2(d) {
  const f = [
    { name: 'Exchange rate', value: `**${d.ratePerM}** per million\n**${d.ratePerB}** per billion`, inline: true },
    { name: 'Liquidity', value: `**${d.usdStr}**\n${d.ltcStr}`, inline: true },
    { name: 'Payout', value: '**Instant**\nLitecoin', inline: true },
  ];
  if (d.moneyOn) f.push({ name: 'Buying money', value: `Up to **${d.moneyCap}**`, inline: true });
  if (d.skellyOn) f.push({ name: 'Buying skellys', value: `Up to **${d.skellyCap}**\nat **${d.pricePerSkelly}**`, inline: true });
  return new EmbedBuilder()
    .setColor(GOLD)
    .setAuthor({ name: 'Autosell Exchange', iconURL: LOGO() })
    .setTitle('Sell In-Game Assets for Litecoin')
    .setDescription(pausedPrefix(d) + '_Configure your wallet once. Sell money or spawners. Paid on confirmation._')
    .addFields(...f)
    .setFooter({ text: 'Settings → Sell → Public or Anonymous' });
}

                                                                 
function t3(d) {
  return new EmbedBuilder()
    .setColor(NEON)
    .setTitle('💸 INSTANT CASH OUT')
    .setThumbnail(LOGO())
    .setDescription(
      pausedPrefix(d) +
        '# DonutSMP → Litecoin\n' +
        `**${d.ratePerM}/M** · **${d.pricePerSkelly}**/skelly\n\n` +
        `We're loaded with **${d.usdStr}** ready to buy.` +
        (d.moneyOn ? `\n💰 Taking up to **${d.moneyCap}**` : '') +
        (d.skellyOn ? `\n💀 Taking up to **${d.skellyCap}**` : '') +
        '\n\n⚙️ **Set up** → **Sell** → **Paid**'
    )
    .setFooter({ text: 'Real LTC • Your wallet • No waiting' })
    .setTimestamp();
}

                                                                       
function t4(d) {
  const sep = '━━━━━━━━━━━━━━━━━━━━━━';
  let table =
    sep +
    '\n' +
    `  Rate      │ ${d.ratePerM}/M (${d.ratePerB}/B)\n` +
    `  Balance   │ ${d.usdStr} (${d.ltcStr})\n`;
  if (d.moneyOn) table += `  Max money │ ${d.moneyCap}\n`;
  if (d.skellyOn) table += `  Max skelly│ ${d.skellyCap} @ ${d.pricePerSkelly}\n`;
  table += sep;
  return new EmbedBuilder()
    .setColor(ICE)
    .setAuthor({ name: 'Autosell Ledger', iconURL: LOGO() })
    .setTitle('📋 Live Buy Sheet')
    .setDescription(pausedPrefix(d) + '```\n' + table + '\n```\nLink account in **Settings**, then press **Sell Money** or **Sell Skellys**.')
    .setFooter({ text: FOOTER });
}

                                                                    
function t5(d) {
  return new EmbedBuilder()
    .setColor(CRIMSON)
    .setTitle('🔥 SELL NOW — GET LTC INSTANTLY')
    .setDescription(
      pausedPrefix(d) +
        '**Money & skeleton spawners wanted.**\n' +
        'Paid in **real Litecoin** the second your sale lands.\n\n' +
        `▸ **${d.ratePerM}/M** (${d.ratePerB}/B)` +
        (d.skellyOn ? `\n▸ **${d.pricePerSkelly}** per skelly` : '') +
        `\n▸ **${d.usdStr}** in the wallet right now`
    )
    .addFields(
      { name: '💰 Money cap', value: d.moneyOn ? `**${d.moneyCap}**` : '_off_', inline: true },
      { name: '💀 Skelly cap', value: d.skellyOn ? `**${d.skellyCap}**` : '_off_', inline: true },
      { name: '⚡ Speed', value: '**Instant**', inline: true }
    )
    .setFooter({ text: '⚙️ Settings first if you\'re new' });
}

                                                                                   
function t6(d) {
  return new EmbedBuilder()
    .setColor(SLATE)
    .setAuthor({ name: 'Autosell', iconURL: LOGO() })
    .setDescription(
      pausedPrefix(d) +
        `**${d.usdStr}** available · **${d.ratePerM}/M** · **${d.ltcStr}**\n` +
        (d.moneyOn && d.skellyOn
          ? `Buying **${d.moneyCap}** money & **${d.skellyCap}** skellys`
          : d.moneyOn
            ? `Buying up to **${d.moneyCap}** money`
            : d.skellyOn
              ? `Buying up to **${d.skellyCap}** skellys @ ${d.pricePerSkelly}`
              : '_Buying paused_') +
        '\n\nSettings → Sell → Litecoin to your address.'
    )
    .setFooter({ text: '/stats · /leaderboard' });
}

                                  
const RED_ACC = 0xdc143c;

function t7(d) {
  return new EmbedBuilder()
    .setColor(RED_ACC)
    .setAuthor({ name: 'Instant Litecoin Payouts', iconURL: LOGO() })
    .setTitle('💰 Money AutoSell')
    .setThumbnail(LOGO())
    .setDescription(
      pausedPrefix(d) +
        '> ⚙️ **Setup your IGN and LTC address using Settings**\n\n' +
        '**1.** Click **Sell** and use the exact command shown in the reply\n' +
        '**2.** Use the **same IGN** in settings that you pay from in-game\n' +
        `**3.** Payments under \`${d.minMoneyStr}\` are ignored`
    )
    .addFields(
      { name: '💱 Current Rate -', value: box(d.ratePer1b), inline: false },
      { name: '💵 USD Balance -', value: box(d.usdStr), inline: false },
      { name: '📈 Max Sell -', value: box(d.moneyCap), inline: false }
    )
    .setFooter({ text: '⚡ Paid in LTC • secure linking • /stats' })
    .setTimestamp();
}

const TEST_DESIGNS = [
  { label: 'Obsidian Terminal', embed: t1, sellStyle: ButtonStyle.Secondary },
  { label: 'Gold Exchange', embed: t2, sellStyle: ButtonStyle.Primary },
  { label: 'Neon Cash-Out', embed: t3, sellStyle: ButtonStyle.Success },
  { label: 'Ice Ledger', embed: t4, sellStyle: ButtonStyle.Primary },
  { label: 'Crimson Urgency', embed: t5, sellStyle: ButtonStyle.Danger },
  { label: 'Discord Slate', embed: t6, sellStyle: ButtonStyle.Secondary },
  { label: 'Money AutoSell', embed: t7, sellStyle: ButtonStyle.Success, buttonLayout: 'moneyAutosell' },
];

                                                                               

const clampMain = (n) => Math.min(Math.max(0, Number(n) || 0), DESIGNS.length - 1);
const clampTest = (n) => Math.min(Math.max(0, Number(n) || 0), TEST_DESIGNS.length - 1);
let choice = null;                                            

function loadChoice() {
  if (choice) return choice;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && raw.source === 'test') {
      choice = { source: 'test', index: clampTest(raw.design) };
    } else {
      const idx = raw && raw.design != null ? raw.design : raw;
      choice = { source: 'main', index: clampMain(idx) };
    }
  } catch {
    choice = { source: 'main', index: 0 };
  }
  return choice;
}

function saveChoice(c) {
  choice = c;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ source: c.source, design: c.index }, null, 2));
  } catch (err) {
                                          
    console.error('[panel-designs] save failed:', err.message);
  }
}

function getChoice() {
  return loadChoice();
}

                                                                    
function getChosen() {
  return loadChoice().index;
}

function setChosenMain(n) {
  require('./live-panel-template').clear();
  const idx = clampMain(n);
  saveChoice({ source: 'main', index: idx });
  return idx;
}

function setChosenTest(n) {
  require('./live-panel-template').clear();
  const idx = clampTest(n);
  saveChoice({ source: 'test', index: idx });
  return idx;
}

                                                
function setChosen(n) {
  return setChosenMain(n);
}

function listFor(source) {
  return source === 'test' ? TEST_DESIGNS : DESIGNS;
}

function renderEmbed(idx, d, source = 'main') {
  const list = listFor(source);
  const i = source === 'test' ? clampTest(idx) : clampMain(idx);
  return (list[i] || list[0]).embed(d);
}

function renderActive(d) {
  const c = loadChoice();
  return renderEmbed(c.index, d, c.source);
}

function sellStyleFor(idx, source = 'main') {
  const list = listFor(source);
  const i = source === 'test' ? clampTest(idx) : clampMain(idx);
  return (list[i] || list[0]).sellStyle || ButtonStyle.Success;
}

function sellStyleActive() {
  const c = loadChoice();
  return sellStyleFor(c.index, c.source);
}

function linksFor(idx, source = 'main') {
  const list = listFor(source);
  const i = source === 'test' ? clampTest(idx) : clampMain(idx);
  const raw = (list[i] || list[0]).links || [];
  return raw
    .map((l) => {
      if (l.vouch) {
        const url = vouchUrl();
        return url ? { label: l.label, emoji: l.emoji, url } : null;
      }
      return l;
    })
    .filter(Boolean);
}

function linksActive() {
  const c = loadChoice();
  return linksFor(c.index, c.source);
}

function labelFor(idx, source = 'main') {
  const list = listFor(source);
  const i = source === 'test' ? clampTest(idx) : clampMain(idx);
  return (list[i] || list[0]).label;
}

function labelActive() {
  const c = loadChoice();
  return labelFor(c.index, c.source);
}

function buttonLayoutFor(idx, source = 'main') {
  const list = listFor(source);
  const i = source === 'test' ? clampTest(idx) : clampMain(idx);
  return (list[i] || list[0]).buttonLayout || 'default';
}

function buttonLayoutActive() {
  const c = loadChoice();
  return buttonLayoutFor(c.index, c.source);
}

function isActive(source, idx) {
  const c = loadChoice();
  return c.source === source && c.index === (source === 'test' ? clampTest(idx) : clampMain(idx));
}

module.exports = {
  computeDisplay,
  renderEmbed,
  renderActive,
  sellStyleFor,
  sellStyleActive,
  linksFor,
  linksActive,
  labelFor,
  labelActive,
  buttonLayoutFor,
  buttonLayoutActive,
  getChoice,
  getChosen,
  setChosen,
  setChosenMain,
  setChosenTest,
  isActive,
  count: DESIGNS.length,
  testCount: TEST_DESIGNS.length,
  TEST_DESIGNS,
};
