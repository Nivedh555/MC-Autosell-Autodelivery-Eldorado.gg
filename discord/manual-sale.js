'use strict';

   
                                                                             
                                                                             
                                                                              
                                                                            
  
                                                                              
   

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const crypto = require('crypto');
const services = require('../services');
const { formatUsd } = require('../sell/money-format');

const ORANGE = 0xdc143c;
const COOLDOWN_MS = 5000;
const pending = new Map();                               
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > 10 * 60000) pending.delete(k);
}, 60000).unref?.();

const slashDefinitions = [
  new SlashCommandBuilder()
    .setName('manualsale')
    .setDescription('Manually pay a seller in LTC (owner only).')
    .addNumberOption((o) => o.setName('amount').setDescription('Amount to pay in USD').setRequired(true))
    .addStringOption((o) => o.setName('address').setDescription('Their LTC payout address').setRequired(true))
    .toJSON(),
];
const NAMES = new Set(['manualsale']);
const isManualCommand = (n) => NAMES.has(n);

function isOwner(interaction) {
  const owner = services.config.discord.ownerId;
  return owner && String(interaction.user.id) === String(owner);
}

async function handleCommand(interaction) {
  if (interaction.commandName !== 'manualsale') return undefined;
  if (!isOwner(interaction)) return interaction.reply({ content: '⛔ Only the bot owner can use this.', flags: 64 });

  const usd = interaction.options.getNumber('amount', true);
  const address = interaction.options.getString('address', true).trim();
  if (!(usd > 0)) return interaction.reply({ content: '❌ Amount must be greater than 0.', flags: 64 });
  if (!services.wallet.enabled) return interaction.reply({ content: '❌ Wallet not configured.', flags: 64 });
  if (!services.wallet.isValidAddress(address)) return interaction.reply({ content: `❌ \`${address}\` is not a valid LTC address.`, flags: 64 });

  let ltc = '?';
  try {
    ltc = ((await services.wallet.usdToLitoshi(usd)) / 1e8).toFixed(8);
  } catch {
                                                    
  }

  const ref = crypto.randomBytes(5).toString('hex');
  pending.set(ref, { usd, address, at: Date.now() });

  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🧾 Confirm Manual Payout')
    .setDescription('You’re about to send a **real** Litecoin payment.')
    .addFields(
      { name: 'Amount', value: `**${formatUsd(usd)}**  ≈  ${ltc} LTC`, inline: true },
      { name: 'Sending', value: services.store.sendEnabled() ? '🟢 Enabled' : '🔴 Disabled', inline: true },
      { name: 'To address', value: `\`${address}\``, inline: false }
    )
    .setFooter({ text: 'Confirm unlocks in 5 seconds…' });

  await interaction.reply({ embeds: [embed], components: [row(ref, true)], flags: 64 });
  setTimeout(() => {
    embed.setFooter({ text: 'Ready — click Confirm & Pay to send.' });
    interaction.editReply({ embeds: [embed], components: [row(ref, false)] }).catch(() => {});
  }, COOLDOWN_MS);
}

function row(ref, locked) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`manualsale_confirm_${ref}`)
      .setLabel(locked ? 'Confirm (wait 5s)' : 'Confirm & Pay')
      .setEmoji('💸')
      .setStyle(ButtonStyle.Success)
      .setDisabled(locked),
    new ButtonBuilder().setCustomId(`manualsale_cancel_${ref}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
}

async function handleButton(interaction) {
  if (!isOwner(interaction)) return interaction.reply({ content: '⛔ Only the bot owner can use this.', flags: 64 });
  const body = interaction.customId.slice('manualsale_'.length);
  const isConfirm = body.startsWith('confirm_');
  const ref = body.slice(body.indexOf('_') + 1);
  const p = pending.get(ref);
  if (!p) return interaction.update({ content: '⌛ This confirmation expired — run `/manualsale` again.', embeds: [], components: [] }).catch(() => {});
  if (!isConfirm) {
    pending.delete(ref);
    return interaction.update({ content: '🚫 Cancelled — nothing was sent.', embeds: [], components: [] });
  }
  pending.delete(ref);
  await interaction.update({ content: '💸 Sending…', embeds: [], components: [] });

  try {
    const litoshi = await services.wallet.usdToLitoshi(p.usd);
    const res = await services.wallet.send(p.address, litoshi);
    const ltc = (litoshi / 1e8).toFixed(8);

    await services.logger.success(
      '✅ Manual payout sent',
      `${formatUsd(p.usd)} = ${ltc} LTC → \`${p.address}\`${res.txid ? ` (tx \`${res.txid}\`)` : ''}`,
      undefined,
      'cashouts'
    );
    await interaction.editReply(`✅ **Paid ${ltc} LTC** (${formatUsd(p.usd)}) to \`${p.address}\`.${res.txid ? `\n🔗 https://litecoinspace.org/tx/${res.txid}` : ''}`);

                                                                    
    require('./payments')
      .postPaymentLog({ discordId: null, anon: true, ltc, usd: p.usd, txid: res.txid, pending: { moneyDonut: 0, moneyUsd: p.usd, skellyCount: 0, skellyUsd: 0 } })
      .catch(() => {});
  } catch (err) {
    await services.logger.error('Manual payout failed', err);
    await interaction.editReply(`❌ Payment failed: ${err.message}`);
  }
}

module.exports = { slashDefinitions, isManualCommand, handleCommand, handleButton };
