'use strict';

   
                                                                   
                                                                               
                                                                              
                                               
   

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const services = require('../services');

const ORANGE = 0xdc143c;
const IDS = {
  SWEEP_MONEY: 'admin_sweep_money',
  SWEEP_SKELLY: 'admin_sweep_skelly',
  HOLDINGS: 'admin_holdings',
  OWNER: 'admin_owner',
  DELAY: 'admin_delay',
  ACCOUNTS: 'admin_accounts',
  TOGGLE_MONEY: 'admin_toggle_money',
  TOGGLE_SKELLY: 'admin_toggle_skelly',
  TOGGLE_TRUSTED: 'admin_toggle_trusted',
  SET_SINGLE_ACCT: 'admin_set_single_acct',
  TOGGLE_VERIFY: 'admin_toggle_verify',
  TOGGLE_SEND: 'admin_toggle_send',
  REFRESH: 'admin_refresh',
  SKELLY_MODAL: 'admin_skelly_modal',
  OWNER_MODAL: 'admin_owner_modal',
  DELAY_MODAL: 'admin_delay_modal',
  ACCOUNTS_MODAL: 'admin_accounts_modal',
};

const { parseDonutAmount } = require('../sell/money-format');

                                                                                 
function buyerLine(store, idx, bot) {
  const acc = store.getBuyerAccount(idx);
  const live = bot && bot.bot && bot.bot.username;
  const online = bot && typeof bot.isOnline === 'function' && bot.isOnline();
  const ign = live || acc.ign || '_not set_';
  return `${online ? '🟢' : '🔴'} \`${ign}\`${acc.email ? `\n${acc.email}` : ' _(no login set)_'}`;
}

function isAdmin(interaction) {
  return require('./commands').isAdmin(interaction);
}

                                                                                   
function reconcileBuyer2() {
  const { store, buyer2Bot } = services;
  if (!buyer2Bot) return;
  try {
    if (store.buyer2Needed()) buyer2Bot.start();
    else buyer2Bot.stop();
  } catch {
                
  }
}

                                                                                               
async function syncSurfaces() {
  try {
    await require('./panel').refresh(true);
  } catch {
                     
  }
  try {
    await require('./stats-channels').sync({ force: true });
  } catch {
                     
  }
}

                                                                                  
function parseIgns(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function panelEmbed() {
  const { store, wallet } = services;
  let bal = '—';
  try {
    bal = wallet.enabled ? `${((await wallet.getBalanceLitoshi()) / 1e8).toFixed(8)} LTC` : 'no wallet';
  } catch {
                
  }
  const owner = store.getSweepConfig().owners[0];
  const igns = owner.igns.length ? owner.igns.map((g) => `\`${g}\``).join(', ') : '_none_';
  const ownerField = { name: `👤 Owner: ${owner.name}`, value: `IGNs (${owner.igns.length}/5): ${igns}`, inline: false };
  return new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🛠️ Control Panel')
    .setDescription('Sweep money is paid to the owner, split evenly across their IGNs.')
    .addFields(
      ownerField,
      { name: '🛒 Autosell', value: `Money: ${store.buyMoneyEnabled() ? '🟢 on' : '🔴 off'}\nSkellys: ${store.buySkellyEnabled() ? '🟢 on' : '🔴 off'}`, inline: true },
      {
        name: '🔀 Trusted system',
        value: store.trustedSystemEnabled()
          ? `🟢 on — trusted after **${store.getTrustThreshold()}** sales`
          : `🔴 off — all sells use **Account ${store.getSingleAccountIndex() + 1}**`,
        inline: true,
      },
      { name: '🔗 Verify linking', value: store.verifyEnabled() ? '🟢 on' : '🔴 off', inline: true },
      { name: `🆕 Buyer 1${store.trustedSystemEnabled() ? ` — new (<${store.getTrustThreshold()})` : ''}`, value: buyerLine(store, 0, services.mcBot), inline: true },
      { name: `⭐ Buyer 2${store.trustedSystemEnabled() ? ` — trusted (≥${store.getTrustThreshold()})` : ''}`, value: buyerLine(store, 1, services.buyer2Bot), inline: true },
      { name: '​', value: '​', inline: true },
      { name: '⏱️ Pay delay', value: `${store.getSweepDelayMs() / 1000}s`, inline: true },
      { name: '💸 Auto-sweep', value: store.getSweepAutoMoney() ? '🟢 on' : '🔴 off', inline: true },
      { name: '🔐 LTC sending', value: store.sendEnabled() ? '🟢 Enabled' : '🔴 Disabled', inline: true },
      { name: '💰 Money rate', value: `$${store.getRate().toFixed(4)}/M ($${(store.getRate() * 1000).toFixed(2)}/B)`, inline: true },
      { name: '💀 Skelly price', value: `$${store.getPrice().toFixed(2)}/ea`, inline: true },
      { name: '🏦 Wallet', value: `\`${bal}\``, inline: true },
      { name: '📦 Expected skellies', value: `${store.getExpectedSpawners()}`, inline: true }
    )
    .setTimestamp();
}

function rows() {
  const { store } = services;
  const owner = store.getSweepConfig().owners[0];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.SWEEP_MONEY).setLabel('Sweep Money').setEmoji('🧹').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(IDS.SWEEP_SKELLY).setLabel('Sweep Skellys').setEmoji('💀').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(IDS.HOLDINGS).setLabel('Holdings').setEmoji('📦').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.OWNER).setLabel((owner.name || 'Owner').slice(0, 40)).setEmoji('👤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.ACCOUNTS).setLabel('Buyer Accounts').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.DELAY).setLabel('Delay & Auto').setEmoji('⏱️').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.TOGGLE_MONEY)
        .setLabel(store.buyMoneyEnabled() ? 'Money: ON' : 'Money: OFF')
        .setEmoji('💰')
        .setStyle(store.buyMoneyEnabled() ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(IDS.TOGGLE_SKELLY)
        .setLabel(store.buySkellyEnabled() ? 'Skellys: ON' : 'Skellys: OFF')
        .setEmoji('💀')
        .setStyle(store.buySkellyEnabled() ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(IDS.TOGGLE_TRUSTED)
        .setLabel(store.trustedSystemEnabled() ? 'Trusted: ON' : 'Trusted: OFF')
        .setEmoji('🔀')
        .setStyle(store.trustedSystemEnabled() ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(IDS.SET_SINGLE_ACCT)
        .setLabel(`Autosell: Acct ${store.getSingleAccountIndex() + 1}`)
        .setEmoji('🎯')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(store.trustedSystemEnabled()),                                        
      new ButtonBuilder()
        .setCustomId(IDS.TOGGLE_VERIFY)
        .setLabel(store.verifyEnabled() ? 'Verify: ON' : 'Verify: OFF')
        .setEmoji('🔗')
        .setStyle(store.verifyEnabled() ? ButtonStyle.Success : ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.TOGGLE_SEND).setLabel('Toggle LTC Sending').setEmoji('🔐').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(IDS.REFRESH).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function ownerModal() {
  const o = services.store.getSweepConfig().owners[0];
  const name = new TextInputBuilder().setCustomId('name').setLabel('Owner name').setStyle(TextInputStyle.Short).setRequired(true).setValue(o.name);
  const igns = new TextInputBuilder()
    .setCustomId('igns')
    .setLabel('IGNs — up to 5 (space/comma/newline)')
    .setPlaceholder('name1 name2 name3')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  if (o.igns.length) igns.setValue(o.igns.join('\n'));
  return new ModalBuilder()
    .setCustomId(IDS.OWNER_MODAL)
    .setTitle('Sweep Owner Settings')
    .addComponents(new ActionRowBuilder().addComponents(name), new ActionRowBuilder().addComponents(igns));
}

function delayModal() {
  const { store } = services;
  const delay = new TextInputBuilder()
    .setCustomId('delay')
    .setLabel('Delay between /pay (seconds)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(String(store.getSweepDelayMs() / 1000));
  const auto = new TextInputBuilder()
    .setCustomId('auto')
    .setLabel('Auto-sweep money? (on/off)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(store.getSweepAutoMoney() ? 'on' : 'off');
  const low = new TextInputBuilder()
    .setCustomId('low')
    .setLabel('Low-balance auto-pause ($)')
    .setPlaceholder('e.g. 4')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(String(store.getLowBalanceUsd()));
  const restock = new TextInputBuilder()
    .setCustomId('restock')
    .setLabel('Restock alert threshold ($)')
    .setPlaceholder('e.g. 20')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(String(store.getRestockUsd()));
  return new ModalBuilder()
    .setCustomId(IDS.DELAY_MODAL)
    .setTitle('Sweep, Delay & Alerts')
    .addComponents(
      new ActionRowBuilder().addComponents(delay),
      new ActionRowBuilder().addComponents(auto),
      new ActionRowBuilder().addComponents(low),
      new ActionRowBuilder().addComponents(restock)
    );
}

function accountsModal() {
  const { store } = services;
  const a1 = store.getBuyerAccount(0);
  const a2 = store.getBuyerAccount(1);
  const field = (id, label, placeholder, value, required = false) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(required);
    if (value) t.setValue(value);
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder()
    .setCustomId(IDS.ACCOUNTS_MODAL)
    .setTitle('Buyer Accounts & Trust')
    .addComponents(
      field('a1email', 'Acct 1 login email (new sellers)', 'email@…', a1.email),
      field('a1ign', 'Acct 1 IGN (optional, auto from login)', 'in-game name', a1.ign),
      field('a2email', 'Acct 2 login email (trusted sellers)', 'email@…', a2.email),
      field('a2ign', 'Acct 2 IGN (optional, auto from login)', 'in-game name', a2.ign),
      field('trust', 'Trusted after how many sales?', 'e.g. 4', String(store.getTrustThreshold()), true)
    );
}

async function open(interaction) {
                                                              
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }
  return interaction.editReply({ embeds: [await panelEmbed()], components: rows() });
}

async function handleButton(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ Admin only.', flags: 64 });
  const sweep = require('../minecraft/sweep');

                                                                                  
                                                                                
                                                                                
  const editPanel = async () => {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    return interaction.editReply({ embeds: [await panelEmbed()], components: rows() });
  };

  switch (interaction.customId) {
    case IDS.REFRESH:
      if (services.wallet && typeof services.wallet.invalidateBalanceCache === 'function') services.wallet.invalidateBalanceCache();
      await editPanel();
      require('./panel').refresh(true).catch(() => {});                                 
      require('./stats-channels').sync().catch(() => {});                                             
      require('./stats-channels').refresh().catch(() => {});                                                
      return undefined;
    case IDS.TOGGLE_SEND: {
      services.store.setSetting('ltcSendEnabled', !services.store.sendEnabled());
      return editPanel();
    }
    case IDS.TOGGLE_MONEY: {
      services.store.setBuyMoneyEnabled(!services.store.buyMoneyEnabled());
      await editPanel();
      await syncSurfaces().catch(() => {});
      return undefined;
    }
    case IDS.TOGGLE_SKELLY: {
      services.store.setBuySkellyEnabled(!services.store.buySkellyEnabled());
      await editPanel();
      await syncSurfaces().catch(() => {});
      return undefined;
    }
    case IDS.TOGGLE_TRUSTED: {
      services.store.setTrustedSystemEnabled(!services.store.trustedSystemEnabled());
      reconcileBuyer2();                                   
      await editPanel();
      require('./panel').refresh().catch(() => {});
      return undefined;
    }
    case IDS.SET_SINGLE_ACCT: {
                                                                                    
      services.store.setSingleAccountIndex(services.store.getSingleAccountIndex() === 1 ? 0 : 1);
      reconcileBuyer2();                                                            
      await editPanel();
      require('./panel').refresh().catch(() => {});
      return undefined;
    }
    case IDS.TOGGLE_VERIFY: {
      services.store.setVerifyEnabled(!services.store.verifyEnabled());
      return editPanel();
    }
    case IDS.OWNER:
      return interaction.showModal(ownerModal());
    case IDS.ACCOUNTS:
      return interaction.showModal(accountsModal());
    case IDS.DELAY:
      return interaction.showModal(delayModal());
    case IDS.SWEEP_SKELLY: {
      const user = new TextInputBuilder().setCustomId('username').setLabel('Your Minecraft username').setStyle(TextInputStyle.Short).setRequired(true);
      const amt = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Amount ("all" or a number)')
        .setPlaceholder('all')
        .setValue('all')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(IDS.SKELLY_MODAL)
          .setTitle('Sweep Skeleton Spawners')
          .addComponents(new ActionRowBuilder().addComponents(user), new ActionRowBuilder().addComponents(amt))
      );
    }
    case IDS.HOLDINGS: {
      await interaction.reply({ content: '📦 Reading storage + balance…', flags: 64 });
      const h = await sweep.reportHoldings();
      return interaction.editReply(
        h ? `📦 **${h.spawners == null ? '?' : h.spawners}** skellies · 💵 **${h.money == null ? '?' : '$' + h.money.toLocaleString('en-US')}** in-game (also posted to logs).` : '⚠️ Could not read holdings (bot offline?).'
      );
    }
    case IDS.SWEEP_MONEY: {
      await interaction.reply({ content: '🧹 Sweeping in-game money…', flags: 64 });
      const r = await sweep.sweepMoney();
      return interaction.editReply(r.success ? `✅ Swept **$${r.amount.toLocaleString('en-US')}** to the owner — split shown in logs.` : `❌ ${r.reason}`);
    }
    default:
      return undefined;
  }
}

async function handleModal(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ Admin only.', flags: 64 });
  const { store } = services;

  if (interaction.customId === IDS.OWNER_MODAL) {
    const name = interaction.fields.getTextInputValue('name').trim();
    const igns = parseIgns(interaction.fields.getTextInputValue('igns'));
    store.setSweepOwner({ name, igns });
    const o = store.getSweepConfig().owners[0];
    return interaction.reply({
      content: `✅ **${o.name}** updated — IGNs (${o.igns.length}/5): ${o.igns.length ? o.igns.map((g) => `\`${g}\``).join(', ') : '_none_'}.`,
      flags: 64,
    });
  }

  if (interaction.customId === IDS.DELAY_MODAL) {
    const sec = parseFloat(interaction.fields.getTextInputValue('delay').trim());
    if (Number.isFinite(sec) && sec >= 0) store.setSweepDelayMs(Math.round(sec * 1000));
    const autoRaw = interaction.fields.getTextInputValue('auto').trim().toLowerCase();
    if (autoRaw) store.setSweepAutoMoney(/^(on|yes|true|1|enable|enabled)$/.test(autoRaw));
    const low = parseFloat(interaction.fields.getTextInputValue('low').trim());
    if (Number.isFinite(low) && low >= 0) store.setLowBalanceUsd(low);
    const restock = parseFloat(interaction.fields.getTextInputValue('restock').trim());
    if (Number.isFinite(restock) && restock > 0) store.setRestockUsd(restock);
    return interaction.reply({
      content: `✅ Delay **${store.getSweepDelayMs() / 1000}s**, auto-sweep **${store.getSweepAutoMoney() ? 'on' : 'off'}**, low-pause **$${store.getLowBalanceUsd()}**, restock **$${store.getRestockUsd()}**.`,
      flags: 64,
    });
  }

  if (interaction.customId === IDS.SKELLY_MODAL) {
    const username = interaction.fields.getTextInputValue('username').trim();
    const amount = interaction.fields.getTextInputValue('amount').trim();
    await interaction.reply({ content: `🧹 Sweeping ${amount} spawner(s) to \`${username}\` — accept the teleport…`, flags: 64 });
    const r = await require('../minecraft/sweep').sweepSkelly(username, amount);
    return interaction.editReply(r.success ? `✅ Handed over **${r.withdrawn}** skeleton spawner(s).` : `❌ ${r.reason}`);
  }

  if (interaction.customId === IDS.ACCOUNTS_MODAL) {
    const get = (id) => interaction.fields.getTextInputValue(id).trim();
    const a1emailBefore = store.getBuyerEmail(0);
    const a2emailBefore = store.getBuyerEmail(1);
    store.setBuyerAccount(0, { email: get('a1email'), ign: get('a1ign') });
    store.setBuyerAccount(1, { email: get('a2email'), ign: get('a2ign') });
    const trustRaw = parseDonutAmount(get('trust'));
    if (Number.isFinite(trustRaw) && trustRaw >= 0) store.setTrustThreshold(trustRaw);
    reconcileBuyer2();                                                                  

    const a1 = store.getBuyerAccount(0);
    const a2 = store.getBuyerAccount(1);
    const loginChanged = a1.email !== a1emailBefore || a2.email !== a2emailBefore;
    return interaction.reply({
      content:
        `✅ Saved buyer accounts.\n` +
        `🆕 **Acct 1** (new, <${store.getTrustThreshold()} sales): \`${a1.ign || '—'}\`${a1.email ? ` · ${a1.email}` : ' · _no login_'}\n` +
        `⭐ **Acct 2** (trusted, ≥${store.getTrustThreshold()} sales): \`${a2.ign || '—'}\`${a2.email ? ` · ${a2.email}` : ' · _no login_'}` +
        (loginChanged ? '\n♻️ A login email changed — run `/mc-stop` then `/mc-start` (or restart) to reconnect that account.' : ''),
      flags: 64,
    });
  }
}

module.exports = { IDS, open, handleButton, handleModal };
