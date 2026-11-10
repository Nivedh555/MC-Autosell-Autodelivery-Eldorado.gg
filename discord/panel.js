'use strict';

   
                                                                               
                                                                    
                                                  
  
                                                                             
                                                                               
                                                                               
                                                                    
   

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const services = require('../services');
const exchange = require('../sell/exchange');
const { parseDonutAmount, formatDonut } = require('../sell/money-format');
const templates = require('./templates/panel-text');
const engine = require('./templates/engine');
const { isSnowflake } = require('./ids');

const ORANGE = 0xdc143c;

const IDS = {
  SELL_MONEY: 'panel_sell_money',
  SELL_SKELLY: 'panel_sell_skelly',
  BALANCE: 'panel_balance',
  SETTINGS: 'panel_settings',
  SETTINGS_MODAL: 'panel_settings_modal',
  MONEY_MODAL: 'panel_money_modal',
  SKELLY_MODAL: 'panel_skelly_modal',
};

                                          
function isIgn(v) {
  return /^\.?[A-Za-z0-9_]{2,16}$/.test(String(v || '').trim());
}
                                                                                    
function buyBotForSeller(discordId) {
  const idx = services.store.buyerIndexForSeller(discordId);
  return idx === 1 ? services.buyer2Bot : services.mcBot;
}
                                                                                     
function buyIgnForSeller(discordId) {
  const idx = services.store.buyerIndexForSeller(discordId);
  const wrapper = idx === 1 ? services.buyer2Bot : services.mcBot;
  const live = wrapper && wrapper.bot && wrapper.bot.username;
  return live || services.store.getBuyerIgn(idx) || 'the buy account';
}
function verifyIgnName() {
                                                                     
  return (services.mcBot && services.mcBot.bot && services.mcBot.bot.username) || services.store.getBuyerIgn(0) || 'our buy account';
}

                                                                       
async function dmCopy(userId, payload) {
  try {
    const u = await services.discordClient.users.fetch(userId);
    await u.send(payload);
  } catch {
                    
  }
}

async function snapshot() {
  const { wallet, store } = services;
  const price = store.getPrice();
  const ratePerM = store.getRate();
  let litoshi = null;
  let ltcPrice = null;
  try {
    if (wallet?.enabled !== false) litoshi = await wallet.getBalanceLitoshi();
  } catch {
           
  }
  try {
    ltcPrice = await wallet.getRate();
  } catch {
    ltcPrice = wallet?.cachedRate?.() ?? null;
  }
  const ltc = Number.isFinite(litoshi) ? litoshi / 1e8 : null;
  const usd = Number.isFinite(ltcPrice) && ltcPrice > 0 && ltc !== null ? ltc * ltcPrice : null;
  return {
    price,
    ratePerM,
    ltc,
    usd,
    canSkellys: usd != null && price > 0 ? Math.floor(usd / price) : null,
    canDonut: usd != null && ratePerM > 0 ? (usd / ratePerM) * 1e6 : null,
  };
}

async function buildPanel() {
  const s = await snapshot();
  const moneyOn = services.store.buyMoneyEnabled();
  const skellyOn = services.store.buySkellyEnabled();
  const paused = services.store.autosellPaused();

                                                                            
                                                                                  
                                                              
  const designs = require('./panel-designs');
  const d = designs.computeDisplay(s, moneyOn, skellyOn, paused);
  const custom = require('./live-panel-template').load();
  const embed = custom ? require('./live-panel-template').render(custom, d) : designs.renderActive(d);
  const sellStyle = designs.sellStyleActive();
  const layout = custom?.buttonLayout || designs.buttonLayoutActive();

  const buttons = [];
  if (layout === 'moneyAutosell') {
    if (moneyOn) buttons.push(new ButtonBuilder().setCustomId(IDS.SELL_MONEY).setLabel(engine.render(templates.labels.sellMoneyShort)).setStyle(ButtonStyle.Success));
    buttons.push(new ButtonBuilder().setCustomId(IDS.BALANCE).setLabel(engine.render(templates.labels.balance)).setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setCustomId(IDS.SETTINGS).setLabel(engine.render(templates.labels.settings)).setStyle(ButtonStyle.Primary));
  } else {
    if (moneyOn) buttons.push(new ButtonBuilder().setCustomId(IDS.SELL_MONEY).setLabel(engine.render(templates.labels.sellMoney)).setEmoji('💰').setStyle(sellStyle));
    if (skellyOn) buttons.push(new ButtonBuilder().setCustomId(IDS.SELL_SKELLY).setLabel(engine.render(templates.labels.sellSkelly)).setEmoji('💀').setStyle(sellStyle));
    buttons.push(new ButtonBuilder().setCustomId(IDS.SETTINGS).setLabel(engine.render(templates.labels.settings)).setEmoji('⚙️').setStyle(ButtonStyle.Secondary));
  }
  const components = [new ActionRowBuilder().addComponents(...buttons)];

  const links = designs.linksActive();
  if (links.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        ...links.map((l) => {
          const b = new ButtonBuilder().setLabel(l.label).setStyle(ButtonStyle.Link).setURL(l.url);
          if (l.emoji) b.setEmoji(l.emoji);
          return b;
        })
      )
    );
  }
  return { embeds: [embed], components };
}

async function postPanel(interaction) {
                                                                              
                                                                                
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = await buildPanel();
  const msg = await interaction.channel.send(panel);
  services.store.setPanel(interaction.channel.id, msg.id);
  return interaction.editReply({ content: '✅ Autosell panel posted (updates live).' });
}

async function refresh(force = false) {
                                                                                 
                                                                                  
  if (force && services.wallet && typeof services.wallet.invalidateBalanceCache === 'function') {
    services.wallet.invalidateBalanceCache();
  }
  const loc = services.store.getPanel();
  if (!loc) return { ok: false, reason: 'no-panel' };
  if (!isSnowflake(loc.channelId) || !isSnowflake(loc.messageId)) {
    services.store.clearPanel();
    return { ok: false, reason: 'invalid-panel-reference', cleared: true };
  }
  if (!services.discordClient) return { ok: false, reason: 'offline' };
  try {
                                                                                
                                                                         
    const ch = await services.discordClient.channels.fetch(loc.channelId);
    if (!ch || !ch.isTextBased()) {
      services.store.clearPanel();
      return { ok: false, reason: 'bad-channel', cleared: true };
    }
    if (ch.guildId !== services.config.discord.guildId) {
      services.store.clearPanel();
      return { ok: false, reason: 'wrong-guild', cleared: true };
    }
    const msg = await ch.messages.fetch(loc.messageId);
    await msg.edit(await buildPanel());
    return { ok: true };
  } catch (err) {
                                                                              
                                                                               
    const cleared = [10008, 10003].includes(err.code);
    if (cleared) {
      services.store.clearPanel();
    }
                                          
    console.error('[panel] refresh failed:', err.message, cleared ? '— re-run /sell-panel.' : '— reference retained; check Discord access/connectivity.');
    return { ok: false, reason: err.message || 'refresh-failed', cleared };
  }
}

                                                                          
async function validatePanelRef() {
  const loc = services.store.getPanel();
  if (!loc || !services.discordClient) return;
  const result = await refresh(false);
  if (result.cleared) {
                                          
    console.warn('[panel] cleared stale panel ref:', result.reason);
  }
}

                                                                               

async function handleButton(interaction) {
  switch (interaction.customId) {
    case IDS.SELL_MONEY:
      return startSell(interaction, 'money');
    case IDS.SELL_SKELLY:
      return startSell(interaction, 'skelly');
    case IDS.BALANCE:
      return showBalance(interaction);
    case IDS.SETTINGS:
      return showSettingsModal(interaction);
    default:
      return undefined;
  }
}

   
                                                                             
                                                                          
   
function blockedIfPaused(interaction, kind) {
  const { store } = services;
  if (kind === 'money' && !store.buyMoneyEnabled()) {
    const alt = store.buySkellyEnabled() ? ' You can still sell **skeleton spawners** with 💀 **Sell Skellys**.' : '';
    interaction.reply({ content: `🚫 We’re **not buying money** right now.${alt}`, flags: 64 }).catch(() => {});
    return true;
  }
  if (kind === 'skelly' && !store.buySkellyEnabled()) {
    const alt = store.buyMoneyEnabled() ? ' You can still sell in-game **money** with 💰 **Sell Money**.' : '';
    interaction.reply({ content: `🚫 We’re **not buying skeleton spawners** right now.${alt}`, flags: 64 }).catch(() => {});
    return true;
  }
  return false;
}

                                                         
function pausedNotice(interaction) {
  if (!services.store.autosellPaused()) return false;
  interaction
    .reply({ content: '⏸️ **Autosell is paused right now.** Please check back a little later — we’ll be open again soon!', flags: 64 })
    .catch(() => {});
  return true;
}

                                                                                               
async function startSell(interaction, kind) {
  const { store } = services;
  require('./activity').track({ interaction, kind, action: 'clicked' });                                     
  if (pausedNotice(interaction)) return;
  if (blockedIfPaused(interaction, kind)) return;
  const seller = store.getSeller(interaction.user.id);

                          
  if (!seller || !isIgn(seller.ign) || !seller.ltcAddress) {
    return showSettingsModal(interaction);
  }

                                                                               
  if (store.verifyEnabled() && !store.isVerified(interaction.user.id, seller.ign)) {
    await interaction.deferReply({ flags: 64 });
    let challenge;
    try { challenge = await exchange.startVerify(interaction.user.id, seller.ign, interaction); }
    catch (error) { return interaction.editReply({ content: 'Do not send money: ' + error.message }); }
    const { amount, intakeIgn } = challenge;
    const linkEmbed = exchange.orangeEmbed(
      '🔗 One-Time Account Linking',
      `To prove you own **${seller.ign}**, pay this exact amount in-game to our verify account:\n\n` +
        `\`\`\`/pay ${intakeIgn} ${amount}\`\`\`\n` +
        `Pay **$${amount}** to **${intakeIgn}**. Linking requires a matching receipt and balance change. You won't need to repeat it ` +
        '(unless you change your IGN or an admin unlinks you).\n\nThen click **Sell** again to continue.'
    );
    await interaction.editReply({ embeds: [linkEmbed] });
    dmCopy(interaction.user.id, { embeds: [linkEmbed] });
    return undefined;
  }

                                                                                  
                                                        
  return showAmountModal(interaction, kind);
}

                                                
function showAmountModal(interaction, kind) {
  if (kind === 'money') {
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('How much money to sell?')
      .setPlaceholder('100m, 1b, 500k, 1000000')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    const modal = new ModalBuilder().setCustomId(IDS.MONEY_MODAL).setTitle('Sell In-game Money').addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }
  const input = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('How many skeleton spawners?')
    .setPlaceholder(`1 – ${services.config.buy.maxPerSell}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const modal = new ModalBuilder().setCustomId(IDS.SKELLY_MODAL).setTitle('Sell Skeleton Spawners').addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function showBalance(interaction) {
  await interaction.deferReply({ flags: 64 });
  const s = await snapshot();
  const d = require('./panel-designs').computeDisplay(s, services.store.buyMoneyEnabled(), services.store.buySkellyEnabled(), services.store.autosellPaused());
  const me = services.store.getSeller(interaction.user.id) || {};
  const lines = [
    `**Current rate:** ${d.ratePer1b}`,
    `**USD balance:** ${d.usdStr}`,
    `**Max sell:** ${d.moneyCap}`,
  ];
  if (me.ign) lines.push(`\n**Your IGN:** \`${me.ign}\``);
  if (me.ltcAddress) lines.push(`**Your LTC:** \`${me.ltcAddress.slice(0, 12)}…\``);
  return interaction.editReply({ content: lines.join('\n') });
}

function showSettingsModal(interaction) {
  const me = services.store.getSeller(interaction.user.id) || {};
  const ign = new TextInputBuilder()
    .setCustomId('ign')
    .setLabel('Your Minecraft username')
    .setPlaceholder('for bedrock accounts use . at start of the username')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const ltc = new TextInputBuilder()
    .setCustomId('ltc')
    .setLabel('Your LTC payout address')
    .setPlaceholder('ltc1... / L... / M...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (me.ign) ign.setValue(me.ign);
  if (me.ltcAddress) ltc.setValue(me.ltcAddress);
  const modal = new ModalBuilder()
    .setCustomId(IDS.SETTINGS_MODAL)
    .setTitle('Your Settings')
    .addComponents(new ActionRowBuilder().addComponents(ign), new ActionRowBuilder().addComponents(ltc));
  return interaction.showModal(modal);
}

async function handleModal(interaction) {
  const id = interaction.customId;
  if (id.startsWith(IDS.SETTINGS_MODAL)) return submitSettings(interaction);
  if (id.startsWith(IDS.MONEY_MODAL)) return submitMoney(interaction);
  if (id.startsWith(IDS.SKELLY_MODAL)) return submitSkelly(interaction);
}

async function submitSettings(interaction) {
  const ign = interaction.fields.getTextInputValue('ign').trim();
  const ltc = interaction.fields.getTextInputValue('ltc').trim();
  if (!isIgn(ign)) {
    return interaction.reply({ content: '❌ Invalid username. 2–16 letters/numbers/underscore (Bedrock: a leading `.`).', flags: 64 });
  }
  if (!services.wallet.isValidAddress(ltc)) {
    return interaction.reply({ content: `❌ \`${ltc}\` doesn’t look like a valid LTC address.`, flags: 64 });
  }
  const before = services.store.getSeller(interaction.user.id);
  services.store.setSeller(interaction.user.id, { ign, ltcAddress: ltc });
  const relink = services.store.verifyEnabled() && before && before.verifiedIgn && before.verifiedIgn.toLowerCase() !== ign.toLowerCase();
  const msg = `✅ Saved! IGN \`${ign}\`, payouts to \`${ltc}\`.${relink ? '\n🔗 Your IGN changed — you’ll re-link once on your next sell.' : ''}\nNow click **Sell Money** or **Sell Skellys**.`;
                                                                                
  await interaction.reply({ content: msg, flags: 64 });
  dmCopy(interaction.user.id, { content: msg });
}

async function submitMoney(interaction) {
  const { store } = services;
  if (pausedNotice(interaction)) return;
  if (blockedIfPaused(interaction, 'money')) return;
  const seller = store.getSeller(interaction.user.id);
  if (!seller || !isIgn(seller.ign) || !seller.ltcAddress) {
    return interaction.reply({ content: '⚙️ Please set your IGN + LTC address first (click ⚙️ Settings).', flags: 64 });
  }
  if (store.verifyEnabled() && !store.isVerified(interaction.user.id, seller.ign)) {
    return interaction.reply({ content: '🔗 Please complete account linking first (click Sell again).', flags: 64 });
  }
  const amount = parseDonutAmount(interaction.fields.getTextInputValue('amount'));
  if (!Number.isFinite(amount)) {
    return interaction.reply({ content: '❌ Invalid amount. Try `100m`, `1b`, `500k`, or `1000000`.', flags: 64 });
  }
  require('./activity').track({ interaction, kind: 'money', action: 'requested', amount });                               
  const min = store.getMinMoney();
  if (min > 0 && amount < min) {
    return interaction.reply({ content: `❌ The minimum money sell is **${formatDonut(min)}** — you entered **${formatDonut(amount)}**.`, flags: 64 });
  }

                                                                                   
                                                                          
  const routedBot = buyBotForSeller(interaction.user.id);
  if (!routedBot) {
    return interaction.reply({ content: 'No intake account is configured. Please contact the owner before sending money.', flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });
  const armed = await exchange.armMoneySell(interaction.user.id, seller.ign, amount, interaction, routedBot.accountId);
  if (!armed.ready) return interaction.editReply({ content: 'Do not send money yet: ' + armed.error });
  const payIgn = armed.intakeIgn;
  const moneyEmbed = exchange.orangeEmbed(
    '💰 Send Your Money',
    `Pay your in-game money to our buy account:\n\n` +
      `\`\`\`/pay ${payIgn} ${Math.floor(amount)}\`\`\`\n` +
      `Send **${formatDonut(amount)}** to **${payIgn}**. After the receipt is checked, the store will attempt your Litecoin payout ` +
      `(rate **$${Number(store.getRate().toFixed(4))}/M ($${(store.getRate() * 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/B)**) straight to your address — you’ll get a DM.\n\n` +
      'After payout I’ll ask whether to show this sale as 🌐 **Public** or 🕵️ **Anonymous**.'
  );
  await interaction.editReply({ embeds: [moneyEmbed] });
  dmCopy(interaction.user.id, { embeds: [moneyEmbed] });
}

async function submitSkelly(interaction) {
  const { store, sellManager, config } = services;
  if (pausedNotice(interaction)) return;
  if (blockedIfPaused(interaction, 'skelly')) return;
  const seller = store.getSeller(interaction.user.id);
  if (!seller || !isIgn(seller.ign) || !seller.ltcAddress) {
    return interaction.reply({ content: '⚙️ Please set your IGN + LTC address first (click ⚙️ Settings).', flags: 64 });
  }
  if (store.verifyEnabled() && !store.isVerified(interaction.user.id, seller.ign)) {
    return interaction.reply({ content: '🔗 Please complete account linking first (click Sell again).', flags: 64 });
  }
  const rawCount = interaction.fields.getTextInputValue('amount').trim();
  const requested = /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return interaction.reply({ content: '❌ Enter a positive whole number of spawners.', flags: 64 });
  }
  require('./activity').track({ interaction, kind: 'skelly', action: 'requested', amount: requested });                               
  const min = store.getMinSkelly();
  if (min > 0 && requested < min) {
    return interaction.reply({ content: `❌ The minimum skelly sell is **${min.toLocaleString('en-US')}** spawner(s) — you entered **${requested}**.`, flags: 64 });
  }
  if (requested > config.buy.maxPerSell) {
    return interaction.reply({ content: `❌ Max per sell is **${config.buy.maxPerSell}**.`, flags: 64 });
  }
  if (sellManager.hasActiveFor(interaction.user.id)) {
    return interaction.reply({ content: '⏳ You already have a skelly sell in progress or queued. Wait for it to finish before starting another.', flags: 64 });
  }

  await interaction.reply({ content: '🧾 Creating your skelly sell…', flags: 64 });
  let queued;
  try { queued = await sellManager.createOrder({
    sellerDiscordId: interaction.user.id,
    sellerUsername: seller.ign,
    ltcAddress: seller.ltcAddress,
    requested,
    interaction,
  }); } catch (error) { return interaction.editReply('Do not drop spawners: ' + error.message); }
  const { order, position } = queued;
  const queueLine = position > 0 ? `⏳ You’re **#${position + 1}** in the queue.` : '➡️ Starting now — get online!';
  const createdMsg =
    `✅ **Skelly sell \`${order.id}\`** — up to **${requested}** spawners @ $${order.priceUsd.toFixed(2)} each, **paid instantly in LTC**.\n${queueLine}\n\n` +
    'Accept my teleport request and wait for the drop instruction. I’ll DM you the verified count and payout status. ' +
    'After payout I’ll ask whether to show this sale as 🌐 **Public** or 🕵️ **Anonymous**.';
  await interaction.editReply(createdMsg);
  dmCopy(interaction.user.id, { content: createdMsg });
  await services.logger.info('New skelly sell', `Order \`${order.id}\` — \`${seller.ign}\` up to ${requested} spawners (<@${interaction.user.id}>).`, undefined, 'sales');
  sellManager.start();
}

module.exports = { IDS, snapshot, buildPanel, postPanel, refresh, validatePanelRef, handleButton, handleModal };
