'use strict';

   
                        
   

const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const services = require('../services');
const { formatDonut, formatUsd } = require('../sell/money-format');
const templates = require('./templates/command-responses');
const engine = require('./templates/engine');

                                                                
const PUBLIC_COMMANDS = new Set(['mystats', 'top-sellers']);

const definitions = [
  new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('See your selling stats, totals, and leaderboard rank.')
    .addUserOption((o) => o.setName('user').setDescription('View another member’s stats (admins only)').setRequired(false)),
  new SlashCommandBuilder().setName('top-sellers').setDescription('Show the top 10 sellers by volume.'),
  new SlashCommandBuilder().setName('sell-panel').setDescription('Post the public sell panel (money / skellys → LTC).'),
  new SlashCommandBuilder().setName('mc-start').setDescription('Connect the Minecraft buyer bot.'),
  new SlashCommandBuilder().setName('mc-stop').setDescription('Disconnect the Minecraft buyer bot.'),
  new SlashCommandBuilder().setName('mc-info').setDescription('Show Minecraft bot status + wallet balance.'),
  new SlashCommandBuilder()
    .setName('price-set')
    .setDescription('Set the price paid per skeleton spawner (USD).')
    .addNumberOption((o) => o.setName('usd').setDescription('Price per spawner in USD').setRequired(true)),
  new SlashCommandBuilder()
    .setName('rate-set')
    .setDescription('Set the money buy rate (USD per 1,000,000 in-game).')
    .addNumberOption((o) => o.setName('usd').setDescription('USD per 1m').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription("Unlink a user's verified account (forces re-verification).")
    .addUserOption((o) => o.setName('user').setDescription('The Discord user to unlink').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reset-user')
    .setDescription("Wipe a user's IGN + LTC address and unlink them (keeps balance).")
    .addUserOption((o) => o.setName('user').setDescription('The Discord user to reset').setRequired(true)),
  new SlashCommandBuilder()
    .setName('zero-balance')
    .setDescription("Clear a user's recoverable balance — sets it to $0 WITHOUT paying out.")
    .addUserOption((o) => o.setName('user').setDescription('The Discord user whose balance to clear').setRequired(true)),
  new SlashCommandBuilder().setName('control').setDescription('Open the admin control panel (sweeps, holdings, settings).'),
  new SlashCommandBuilder().setName('sell-pause').setDescription('Pause autosell — sellers are told it’s paused when they click Sell.'),
  new SlashCommandBuilder().setName('sell-resume').setDescription('Resume autosell after a pause.'),
  new SlashCommandBuilder().setName('cashouts').setDescription('List sellers with a parked balance needing a manual cashout.'),
  new SlashCommandBuilder().setName('deal-stats').setDescription('Server totals: volume, deals, average deal size.'),
  new SlashCommandBuilder().setName('dm-all').setDescription('DM a message to every member (opens a box to type it).'),
  new SlashCommandBuilder()
    .setName('sweepskelly')
    .setDescription('Bot /tpa’s you and hands over stored skeleton spawners.')
    .addStringOption((o) => o.setName('username').setDescription('Your Minecraft username').setRequired(true))
    .addStringOption((o) => o.setName('amount').setDescription('"all" or a number').setRequired(true)),
  new SlashCommandBuilder()
    .setName('sweepmoney')
    .setDescription('Sweep the bot’s in-game money to an IGN (add a 2nd IGN to split 50/50).')
    .addStringOption((o) => o.setName('ign').setDescription('IGN to send all the money to').setRequired(true))
    .addStringOption((o) => o.setName('ign2').setDescription('Optional 2nd IGN — splits 50/50').setRequired(false)),
  new SlashCommandBuilder().setName('buy-status').setDescription('Show whether money + skelly buying are on or off.'),
  new SlashCommandBuilder()
    .setName('toggle-money')
    .setDescription('Turn buying in-game MONEY on or off.')
    .addStringOption((o) =>
      o.setName('state').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
    ),
  new SlashCommandBuilder()
    .setName('toggle-skelly')
    .setDescription('Turn buying SKELETON SPAWNERS on or off.')
    .addStringOption((o) =>
      o.setName('state').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
    ),
  new SlashCommandBuilder()
    .setName('min-money')
    .setDescription('Set the minimum in-game MONEY a user can sell (0 to disable).')
    .addStringOption((o) => o.setName('amount').setDescription('e.g. 10m, 1b, or 0').setRequired(true)),
  new SlashCommandBuilder()
    .setName('min-skelly')
    .setDescription('Set the minimum number of SKELETON spawners a user can sell (0 to disable).')
    .addIntegerOption((o) => o.setName('count').setDescription('e.g. 16, or 0').setRequired(true)),
  new SlashCommandBuilder().setName('sweep-info').setDescription('Show the sweep owner, IGNs, and delay.'),
  new SlashCommandBuilder()
    .setName('sweep-name')
    .setDescription('Rename the sweep owner.')
    .addStringOption((o) => o.setName('name').setDescription('Display name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('sweep-add')
    .setDescription('Add an IGN to the sweep owner (max 5).')
    .addStringOption((o) => o.setName('ign').setDescription('Minecraft username').setRequired(true)),
  new SlashCommandBuilder()
    .setName('sweep-remove')
    .setDescription('Remove an IGN from the sweep owner.')
    .addStringOption((o) => o.setName('ign').setDescription('Minecraft username to remove').setRequired(true)),
  new SlashCommandBuilder().setName('sweep-clear').setDescription('Remove ALL sweep IGNs.'),
  new SlashCommandBuilder()
    .setName('sweep-delay')
    .setDescription('Set the delay (seconds) between each sweep /pay.')
    .addNumberOption((o) => o.setName('seconds').setDescription('e.g. 10').setRequired(true)),
].map((c) => c.toJSON());

function isAdmin(interaction) {
  const { config } = services;
  if (!interaction.inGuild()) return false;
  const member = interaction.member;
  if (!member) return false;
  const perms = member.permissions;
  if (perms instanceof PermissionsBitField && perms.has(PermissionsBitField.Flags.Administrator)) return true;
  const roles = member.roles?.cache;
  return Boolean(roles && roles.has(config.discord.adminRoleId));
}

function panelRefreshNote(result) {
  if (result?.ok) return '';
  return '\n\n⚠️ Public sell panel was **not** updated (no live panel saved). Run **`/sell-panel`** in your sell channel to post one, then prices will refresh automatically.';
}

async function syncSurfaces() {
  const panelResult = await require('./panel').refresh(true).catch(() => ({ ok: false }));
  await require('./stats-channels').sync({ force: true }).catch(() => {});
  return panelResult;
}

async function handleCommand(interaction) {
  const name = interaction.commandName;

                                                     
  if (PUBLIC_COMMANDS.has(name)) {
    if (name === 'mystats') return cmdStats(interaction);
    if (name === 'top-sellers') return cmdLeaderboard(interaction);
  }

  if (!isAdmin(interaction)) {
    return interaction.reply({ content: engine.render(templates.commands.noPerms, {}), flags: 64 });
  }
  const { logger } = services;
                                                                                  
  void logger.adminCommand(name, interaction.user.tag).catch(() => {});

  switch (name) {
    case 'sell-panel':
      return require('./panel').postPanel(interaction);
    case 'mc-start':
      return cmdBotOn(interaction);
    case 'mc-stop':
      return cmdBotOff(interaction);
    case 'mc-info':
      return cmdBotStatus(interaction);
    case 'price-set':
      return cmdSetPrice(interaction);
    case 'rate-set':
      return cmdSetRate(interaction);
    case 'unlink':
      return cmdUnlink(interaction);
    case 'reset-user':
      return cmdClearSettings(interaction);
    case 'zero-balance':
      return cmdClearBalance(interaction);
    case 'control':
      return require('./admin-panel').open(interaction);
    case 'sell-pause':
      return cmdAutosellPause(interaction);
    case 'sell-resume':
      return cmdAutosellStart(interaction);
    case 'cashouts':
      return cmdCashouts(interaction);
    case 'deal-stats':
      return cmdServerStats(interaction);
    case 'dm-all':
      return require('./dm-announce').showModal(interaction);
    case 'sweepskelly':
      return cmdSweepSkelly(interaction);
    case 'sweepmoney':
      return cmdSweepMoney(interaction);
    case 'buy-status':
      return cmdStatus(interaction);
    case 'toggle-money':
      return cmdToggleBuy(interaction, 'money');
    case 'toggle-skelly':
      return cmdToggleBuy(interaction, 'skelly');
    case 'min-money':
      return cmdSetMinMoney(interaction);
    case 'min-skelly':
      return cmdSetMinSkelly(interaction);
    case 'sweep-info':
      return cmdSweepConfig(interaction);
    case 'sweep-name':
      return cmdSweepOwner(interaction);
    case 'sweep-add':
      return cmdSweepIgnAdd(interaction);
    case 'sweep-remove':
      return cmdSweepIgnRemove(interaction);
    case 'sweep-clear':
      return cmdSweepIgnClear(interaction);
    case 'sweep-delay':
      return cmdSetSweepDelay(interaction);
    default:
      return interaction.reply({ content: 'Unknown command.', flags: 64 });
  }
}

async function cmdCashouts(interaction) {
  const list = services.store.pendingCashouts();
  if (!list.length) {
    return interaction.reply({ content: '✅ No pending cashouts — everyone has been paid.', flags: 64 });
  }
  const total = list.reduce((a, s) => a + s.balanceUsd, 0);
  const lines = list
    .slice(0, 25)
    .map((s, i) => `**${i + 1}.** <@${s.discordId}> \`${s.ign || '—'}\` — **${formatUsd(s.balanceUsd)}** → \`${s.ltcAddress || 'no address'}\``)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(0xdc143c)
    .setTitle(`💸 Pending Manual Cashouts (${list.length})`)
    .setDescription(`${lines}${list.length > 25 ? `\n…and ${list.length - 25} more` : ''}`)
    .setFooter({ text: `Total owed: ${formatUsd(total).replace('$', '$')} • release via the website Cashouts tab or /api/sellers/cashout` })
    .setTimestamp();
  return interaction.reply({ embeds: [embed], flags: 64 });
}

async function cmdAutosellPause(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  services.store.setAutosellPaused(true);
  await require('./panel').refresh().catch(() => {});
  await services.logger.warn('Autosell paused', `Paused by ${interaction.user.tag}. Sellers can’t start a sale until resumed.`, undefined, 'system');
  return interaction.editReply({ content: engine.render(templates.commands.pausePaused, {}) });
}

async function cmdAutosellStart(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  services.store.setAutosellPaused(false);
  services.store.setSetting('lowAlerted', false);                                    
  await require('./panel').refresh().catch(() => {});
  await services.logger.success('Autosell resumed', `Resumed by ${interaction.user.tag}.`, undefined, 'system');
  return interaction.editReply({ content: engine.render(templates.commands.pauseResumed, {}) });
}

async function cmdBotOn(interaction) {
  const { mcBot, buyer2Bot, store } = services;
  await interaction.reply({ content: '🔌 Connecting both buyer accounts…', flags: 64 });
  const lines = [];
  if (store.getBuyerEmail(0)) {
    try {
      services.sessions?.setManualStop('buyer1', false);
      await mcBot.connect();
      lines.push('🆕 Account 1: connect requested.');
    } catch (err) {
      lines.push(`🆕 Account 1: ❌ ${err.message}`);
    }
  } else {
    lines.push('🆕 Account 1: ⚠️ no login set (add it in `/control`).');
  }
  if (store.buyer2Needed()) {
    try {
      services.sessions?.setManualStop('buyer2', false);
      await buyer2Bot.connect();
      lines.push('⭐ Account 2: connect requested.');
    } catch (err) {
      lines.push(`⭐ Account 2: ❌ ${err.message}`);
    }
  } else {
    lines.push(`⭐ Account 2: 💤 not needed right now${store.getBuyerEmail(1) ? '' : ' (no login set)'}.`);
  }
  await interaction.editReply(`${lines.join('\n')}\nWatch the logs channel.`);
}

async function cmdBotOff(interaction) {
  const { mcBot, buyer2Bot } = services;
  await interaction.reply({ content: '🔌 Disconnecting both buyer accounts…', flags: 64 });
  services.sessions?.setManualStop('buyer1', true);
  services.sessions?.setManualStop('buyer2', true);
  await mcBot.disconnect('Admin requested disconnect');
  try {
    await buyer2Bot.disconnect('Admin requested disconnect');
  } catch {
                
  }
  await interaction.editReply('✅ Both accounts disconnected.');
}

async function cmdBotStatus(interaction) {
  await interaction.deferReply({ flags: 64 });
  const { mcBot, buyer2Bot, wallet, sellManager, store } = services;
  const status = mcBot.getStatus();
  let bal = '—';
  try {
    bal = `${((await wallet.getBalanceLitoshi()) / 1e8).toFixed(8)} LTC`;
  } catch {
                
  }
  const a1ign = (mcBot.bot && mcBot.bot.username) || store.getBuyerIgn(0) || '—';
  const b2on = Boolean(buyer2Bot && buyer2Bot.isOnline && buyer2Bot.isOnline());
  const a2ign = (buyer2Bot && buyer2Bot.username) || store.getBuyerIgn(1) || '—';
  const embed = new EmbedBuilder()
    .setTitle('🤖 Bot status')
    .setColor(status.online ? 0x57f287 : 0xed4245)
    .addFields(
      { name: '🆕 Account 1 (new sellers)', value: `${status.online ? '🟢 online' : '🔴 offline'} · \`${a1ign}\`\nstate: \`${status.state}\``, inline: true },
      { name: `⭐ Account 2 (trusted, ≥${store.getTrustThreshold()})`, value: `${b2on ? '🟢 online' : '🔴 offline'} · \`${a2ign}\``, inline: true },
      { name: 'Busy', value: sellManager.busy ? `yes (order ${sellManager.activeId})` : 'no', inline: true },
      { name: 'Wallet', value: wallet.enabled ? `\`${wallet.address}\`\n${bal}` : '_no key configured_' },
      { name: 'Price / spawner', value: `$${store.getPrice().toFixed(2)}`, inline: true },
      { name: 'Sending', value: store.sendEnabled() ? '🟢 Enabled' : '🔴 Disabled', inline: true }
    )
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

async function cmdSetPrice(interaction) {
  const usd = interaction.options.getNumber('usd', true);
  if (!(usd > 0)) return interaction.reply({ content: engine.render(templates.commands.priceSetZero, {}), flags: 64 });
  await interaction.deferReply({ flags: 64 });
  services.store.setPrice(usd);
  const panelResult = await syncSurfaces();
  return interaction.editReply({
    content: engine.render(templates.commands.priceSetSuccess, { usd: usd.toFixed(2), panelRefreshNote: panelRefreshNote(panelResult) })
  });
}

async function cmdSetRate(interaction) {
  const usd = interaction.options.getNumber('usd', true);
  if (!(usd > 0)) return interaction.reply({ content: engine.render(templates.commands.rateSetZero, {}), flags: 64 });
  await interaction.deferReply({ flags: 64 });
  services.store.setRate(usd);
  const panelResult = await syncSurfaces();
  const fakeB = services.store.getChannelRateOverridePerB();
  const fakeNote =
    fakeB > 0
      ? `\n\n_Voice channel still shows marketing rate **$${fakeB.toFixed(2)}/B** — clear **Fake channel rate** on the website to match real payouts._`
      : '';
  return interaction.editReply({
    content: engine.render(templates.commands.rateSetSuccess, { usd: usd.toFixed(4), perB: (usd * 1000).toFixed(2), panelRefreshNote: panelRefreshNote(panelResult), fakeNote })
  });
}

async function cmdUnlink(interaction) {
  const user = interaction.options.getUser('user', true);
  const old = services.store.unlink(user.id);
  await services.logger.warn('Account unlinked', `<@${user.id}> unlinked by ${interaction.user.tag}${old ? ` (was \`${old}\`)` : ''}.`, undefined, 'verify');
  return interaction.reply({
    content: old ? `✅ Unlinked <@${user.id}> (was \`${old}\`). They’ll re-verify on their next sell.` : `ℹ️ <@${user.id}> had no linked account.`,
    flags: 64,
  });
}

async function cmdClearSettings(interaction) {
  const user = interaction.options.getUser('user', true);
  const had = services.store.clearSeller(user.id);
  await services.logger.warn(
    'Settings cleared',
    `<@${user.id}> reset by ${interaction.user.tag}${had && had.ign ? ` (was IGN \`${had.ign}\`)` : ''}. They’ll set up + re-link on their next sell.`,
    undefined,
    'verify'
  );
  return interaction.reply({
    content: had
      ? `✅ Cleared <@${user.id}>'s settings — IGN, LTC address, and verification wiped (balance kept). They’ll re-enter everything on their next sell.`
      : `ℹ️ <@${user.id}> had no saved settings.`,
    flags: 64,
  });
}

async function cmdServerStats(interaction) {
  const st = services.store.serverStats();
  const billions = st.moneyDonut / 1e9;
  const embed = new EmbedBuilder()
    .setColor(0xdc143c)
    .setTitle('🌐 Server Stats — All Time')
    .addFields(
      { name: '💵 Total Dealt', value: `**${formatUsd(st.volumeUsd)}**`, inline: true },
      { name: '🧾 Total Deals', value: `**${st.sales.toLocaleString('en-US')}**`, inline: true },
      { name: '📊 Average Deal', value: `**${formatUsd(st.avgUsd)}**`, inline: true },
      {
        name: '💰 In-game Money Dealt',
        value: `**${billions.toLocaleString('en-US', { maximumFractionDigits: 2 })}B**\n${formatUsd(st.moneyUsd)} worth`,
        inline: true,
      },
      { name: '💀 Skellys Bought', value: `**${st.skellyCount.toLocaleString('en-US')}**\n${formatUsd(st.skellyUsd)} worth`, inline: true },
      { name: '👥 Sellers', value: `**${st.sellers.toLocaleString('en-US')}**`, inline: true }
    )
    .setFooter({ text: 'Totals across every recorded sale.' })
    .setTimestamp();
  return interaction.reply({ embeds: [embed], flags: 64 });
}

async function cmdClearBalance(interaction) {
  const user = interaction.options.getUser('user', true);
  const had = services.store.getBalanceUsd(user.id);
  if (!(had > 0)) {
    return interaction.reply({ content: `ℹ️ <@${user.id}> has no balance to clear (currently ${formatUsd(0)}).`, flags: 64 });
  }
  services.store.zeroBalance(user.id);
  services.store.resetPending(user.id);
  await services.logger.warn(
    'Balance cleared',
    `<@${user.id}>'s recoverable balance of **${formatUsd(had)}** was cleared by ${interaction.user.tag} (set to $0, not paid out).`,
    undefined,
    'cashouts'
  );
  return interaction.reply({ content: `✅ Cleared <@${user.id}>'s balance of **${formatUsd(had)}** → now ${formatUsd(0)}. (This did **not** pay them — it just zeroed the balance.)`, flags: 64 });
}

async function cmdSweepSkelly(interaction) {
  const username = interaction.options.getString('username', true).trim();
  const amount = interaction.options.getString('amount', true).trim();
  await interaction.reply({ content: `🧹 Sweeping ${amount === 'all' ? 'all' : amount} spawner(s) to \`${username}\` — accept the teleport…`, flags: 64 });
  const res = await require('../minecraft/sweep').sweepSkelly(username, amount);
  return interaction.editReply(res.success ? `✅ Handed over **${res.withdrawn}** skeleton spawner(s).` : `❌ ${res.reason}`);
}

async function cmdSweepMoney(interaction) {
  const ign = interaction.options.getString('ign', true).trim();
  const ign2 = (interaction.options.getString('ign2', false) || '').trim();
  const igns = ign2 ? [ign, ign2] : [ign];
  await interaction.reply({ content: `🧹 Sweeping in-game money to ${igns.map((i) => `\`${i}\``).join(' + ')}${ign2 ? ' (50/50)' : ''}…`, flags: 64 });
  const res = await require('../minecraft/sweep').sweepMoney(igns);
  return interaction.editReply(res.success ? `✅ Swept **$${res.amount.toLocaleString('en-US')}** — split shown in #sale-logs.` : `❌ ${res.reason}`);
}

async function cmdStatus(interaction) {
  const { store } = services;
  const moneyOn = store.buyMoneyEnabled();
  const skellyOn = store.buySkellyEnabled();
  const embed = new EmbedBuilder()
    .setColor(0xdc143c)
    .setTitle('🛒 Autosell Status')
    .addFields(
      { name: '💰 Money', value: moneyOn ? '🟢 **Buying**' : '🔴 **Off**', inline: true },
      { name: '💀 Skellys', value: skellyOn ? '🟢 **Buying**' : '🔴 **Off**', inline: true },
      {
        name: '📉 Minimums',
        value: `Money: ${store.getMinMoney() > 0 ? `**${formatDonut(store.getMinMoney())}**` : '_none_'}\nSkellys: ${
          store.getMinSkelly() > 0 ? `**${store.getMinSkelly().toLocaleString('en-US')}**` : '_none_'
        }`,
        inline: false,
      }
    )
    .setFooter({ text: 'Toggle: /toggle-money • /toggle-skelly • /min-money • /min-skelly' })
    .setTimestamp();
  return interaction.reply({ embeds: [embed], flags: 64 });
}

async function cmdSetMinMoney(interaction) {
  const raw = interaction.options.getString('amount', true).trim();
  const amount = raw === '0' ? 0 : require('../sell/money-format').parseDonutAmount(raw);
  if (!Number.isFinite(amount) || amount < 0) {
    return interaction.reply({ content: '❌ Invalid amount. Try `10m`, `1b`, or `0` to disable.', flags: 64 });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  services.store.setMinMoney(amount);
  await require('./panel').refresh().catch(() => {});
  return interaction.editReply({
    content: amount > 0 ? `✅ Minimum money sell set to **${formatDonut(amount)}**.` : '✅ Minimum money sell removed (no minimum).',
  });
}

async function cmdSetMinSkelly(interaction) {
  const count = interaction.options.getInteger('count', true);
  if (count < 0) return interaction.reply({ content: '❌ Count must be 0 or more.', flags: 64 });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  services.store.setMinSkelly(count);
  await require('./panel').refresh().catch(() => {});
  return interaction.editReply({
    content: count > 0 ? `✅ Minimum skelly sell set to **${count.toLocaleString('en-US')}** spawner(s).` : '✅ Minimum skelly sell removed (no minimum).',
  });
}

async function cmdToggleBuy(interaction, kind) {
  const { store } = services;
  const on = interaction.options.getString('state', true) === 'on';
  const label = kind === 'money' ? 'Money' : 'Skelly';
  await interaction.deferReply({ flags: 64 });
  if (kind === 'money') store.setBuyMoneyEnabled(on);
  else store.setBuySkellyEnabled(on);
  await syncSurfaces();
  await services.logger.info(
    `${label} autobuy ${on ? 'enabled' : 'disabled'}`,
    `${interaction.user.tag} turned ${label.toLowerCase()} buying **${on ? 'ON' : 'OFF'}**.`,
    undefined,
    'system'
  );
  const what = kind === 'money' ? 'in-game money' : 'skeleton spawners';
  return interaction.editReply({
    content: on
      ? `🟢 Now buying **${what}** again. Stat channels updated.`
      : `🔴 Stopped buying **${what}**. Skelly/money stat channels hidden if off. Sellers who try will be told we’re not buying ${kind === 'money' ? 'money' : 'skellys'} right now.`,
  });
}

                                                    
function sweepConfigEmbed() {
  const { store } = services;
  const o = store.getSweepConfig().owners[0];
  const igns = o.igns.length ? o.igns.map((g) => `\`${g}\``).join(', ') : '_none_';
  return new EmbedBuilder()
    .setColor(0xdc143c)
    .setTitle('🧹 Sweep Configuration')
    .addFields(
      { name: `👤 Owner: ${o.name}`, value: `IGNs (${o.igns.length}/5): ${igns}`, inline: false },
      { name: '⏱️ Delay', value: `${store.getSweepDelayMs() / 1000}s between pays`, inline: true },
      { name: '💸 Auto-sweep', value: store.getSweepAutoMoney() ? '🟢 on' : '🔴 off', inline: true }
    )
    .setFooter({ text: 'Money is split evenly across the owner’s IGNs. Set with /sweep-add, /sweep-name.' })
    .setTimestamp();
}

async function cmdSweepConfig(interaction) {
  return interaction.reply({ embeds: [sweepConfigEmbed()], flags: 64 });
}

async function cmdSweepOwner(interaction) {
  const name = interaction.options.getString('name', true).trim();
  services.store.setSweepOwner({ name });
  return interaction.reply({ content: `✅ Sweep owner renamed to **${name}**.`, embeds: [sweepConfigEmbed()], flags: 64 });
}

async function cmdSweepIgnAdd(interaction) {
  const ign = interaction.options.getString('ign', true).trim();
  const o = services.store.getSweepConfig().owners[0];
  if (o.igns.length >= 5) return interaction.reply({ content: `❌ **${o.name}** already has 5 IGNs (the max).`, flags: 64 });
  if (o.igns.some((g) => g.toLowerCase() === ign.toLowerCase())) return interaction.reply({ content: `ℹ️ \`${ign}\` is already added.`, flags: 64 });
  o.igns.push(ign);
  services.store.setSweepOwner({ igns: o.igns });
  return interaction.reply({ content: `✅ Added \`${ign}\` to **${o.name}**.`, embeds: [sweepConfigEmbed()], flags: 64 });
}

async function cmdSweepIgnRemove(interaction) {
  const ign = interaction.options.getString('ign', true).trim();
  const o = services.store.getSweepConfig().owners[0];
  const before = o.igns.length;
  o.igns = o.igns.filter((g) => g.toLowerCase() !== ign.toLowerCase());
  services.store.setSweepOwner({ igns: o.igns });
  return interaction.reply({
    content: before === o.igns.length ? `ℹ️ \`${ign}\` wasn’t in the sweep list.` : `✅ Removed \`${ign}\` from **${o.name}**.`,
    embeds: [sweepConfigEmbed()],
    flags: 64,
  });
}

async function cmdSweepIgnClear(interaction) {
  const o = services.store.getSweepConfig().owners[0];
  services.store.setSweepOwner({ igns: [] });
  return interaction.reply({ content: `✅ Cleared all sweep IGNs for **${o.name}**.`, embeds: [sweepConfigEmbed()], flags: 64 });
}

async function cmdSetSweepDelay(interaction) {
  const sec = interaction.options.getNumber('seconds', true);
  if (sec < 0) return interaction.reply({ content: '❌ Delay must be 0 or more.', flags: 64 });
  services.store.setSweepDelayMs(Math.round(sec * 1000));
  return interaction.reply({ content: `✅ Sweep delay set to **${sec}s** between each /pay.`, flags: 64 });
}

async function cmdStats(interaction) {
  const { store } = services;
  const requested = interaction.options.getUser('user', false);
                                                  
  const target = requested && requested.id !== interaction.user.id && isAdmin(interaction) ? requested : interaction.user;
  const self = target.id === interaction.user.id;

  const stats = store.getStats(target.id);
  if (!stats || stats.sales === 0) {
    return interaction.reply({
      content: self ? '📊 You haven’t sold anything yet — use the panel to make your first sale!' : `📊 <@${target.id}> hasn’t sold anything yet.`,
      flags: 64,
    });
  }

  const { rank, total } = store.rankOf(target.id);
  const rankLine = rank ? `**#${rank}** of ${total} seller${total === 1 ? '' : 's'}` : '_unranked_';
  const LTC_LOGO = require('./payments').LTC_LOGO;

  const embed = new EmbedBuilder()
    .setColor(0xdc143c)
    .setTitle(`📊 Seller Stats — ${target.username}`)
    .setThumbnail(target.displayAvatarURL ? target.displayAvatarURL() : LTC_LOGO)
    .addFields(
      { name: '💵 Total Volume', value: `**${formatUsd(stats.volumeUsd)}**`, inline: true },
      { name: '🧾 Total Sales', value: `**${stats.sales.toLocaleString('en-US')}**`, inline: true },
      { name: '🏆 Leaderboard Rank', value: rankLine, inline: true },
      { name: '💰 Money Sold', value: `**${formatDonut(stats.moneyDonut)}**\n${formatUsd(stats.moneyUsd)} worth`, inline: true },
      { name: '💀 Skellys Sold', value: `**${stats.skellyCount.toLocaleString('en-US')}**\n${formatUsd(stats.skellyUsd)} worth`, inline: true },
      { name: '🏦 Current Balance', value: `**${formatUsd(stats.balanceUsd)}**\ncashed out: ${formatUsd(stats.cashedOutUsd)}`, inline: true }
    )
    .setFooter({ text: stats.anon ? 'You appear as: 🕵️ Anonymous' : 'You appear as: 🌐 Public' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: 64 });
}

async function cmdLeaderboard(interaction) {
  const { store } = services;
  const top = store.leaderboard(10);
  const LTC_LOGO = require('./payments').LTC_LOGO;

  const embed = new EmbedBuilder()
    .setColor(0xdc143c)
    .setTitle('🏆 Top Sellers')
    .setThumbnail(LTC_LOGO)
    .setTimestamp();

  if (!top.length) {
    embed.setDescription('_No sales yet — be the first on the board!_');
    return interaction.reply({ embeds: [embed] });
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((e, i) => {
    const rank = i < 3 ? medals[i] : `**${i + 1}.**`;
    const who = e.anon ? '🕵️ Anonymous' : `<@${e.discordId}>`;
    const extra = [];
    if (e.moneyDonut > 0) extra.push(`${formatDonut(e.moneyDonut)} sold`);
    if (e.skellyCount > 0) extra.push(`${e.skellyCount.toLocaleString('en-US')} 💀`);
    const detail = extra.length ? ` · ${extra.join(' · ')}` : '';
    return `${rank} ${who}\n${formatUsd(e.volumeUsd)} volume${detail}`;
  });

  embed.setDescription('All-time leaderboard · Top 10\n\n' + lines.join('\n\n')).setFooter({ text: 'Sell on the panel to climb the board • /stats' });
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

module.exports = { definitions, handleCommand, isAdmin };
