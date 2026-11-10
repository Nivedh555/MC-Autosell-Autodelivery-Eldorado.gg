'use strict';

   
                                                                                  
                                                                           
                                                                                
                           
   

const crypto = require('crypto');
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const services = require('../services');

const MODAL_ID = 'dmannounce_modal';
const PREFIX = 'dmannounce_';                                                                       
const ORANGE = 0xdc143c;
const MAX_LEN = 2000;                                 
const DM_DELAY_MS = 350;                        

const pending = new Map();                                           
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > 15 * 60 * 1000) pending.delete(k);
}, 5 * 60 * 1000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

                                                                                   
const OPTOUT_LINE = "\n\n-# Type 'stop' if you don't want these notifications anymore.";

                                                                                   
function withOptOut(message) {
  const room = MAX_LEN - OPTOUT_LINE.length;
  return `${String(message).slice(0, room)}${OPTOUT_LINE}`;
}

   
                                                                                   
                                                                                     
                                        
   
async function fetchAllMembers(guild) {
  if (guild.members.cache.size >= guild.memberCount) return guild.members.cache;
  try {
    return await guild.members.fetch();
  } catch (err) {
    const m = /retry after ([\d.]+)/i.exec(err.message || '');
    const waitMs = Math.min((m ? Math.ceil(parseFloat(m[1]) * 1000) : 10000) + 500, 30000);
    await sleep(waitMs);
    try {
      return await guild.members.fetch();
    } catch {
      return guild.members.cache;               
    }
  }
}

                                        
function showModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Message (line breaks & ## headers work)')
    .setPlaceholder('## Big news!\nSomething [Click here](https://...)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_LEN);
  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('DM Announcement').addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

                                                                             
async function handleModal(interaction) {
  const message = interaction.fields.getTextInputValue('message').trim();
  if (!message) return interaction.reply({ content: '❌ The message was empty.', flags: 64 });

  const ref = crypto.randomBytes(6).toString('hex');
  pending.set(ref, { message, authorId: interaction.user.id, createdAt: Date.now() });

                                                                                 
                                                           
  let count = '…';
  const guildCached = services.discordClient.guilds.cache.get(services.config.discord.guildId);
  if (guildCached) count = `~${guildCached.memberCount}`;

  const preview = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('📨 Confirm DM Announcement')
    .setDescription(
      `This will DM the message below to **${count}** member(s) (bots + closed DMs are skipped).\n\n` +
        '━━━━━━━━━━━━━━━━━━━━━━━\n' +
        message.slice(0, 1800)
    )
    .setFooter({ text: 'Sends are throttled — this can take a while on big servers.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}confirm_${ref}`).setLabel('Send to everyone').setEmoji('📨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}cancel_${ref}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  return interaction.reply({ embeds: [preview], components: [row], flags: 64 });
}

                             
async function handleButton(interaction) {
  const body = interaction.customId.slice(PREFIX.length);                                
  const isConfirm = body.startsWith('confirm_');
  const ref = body.slice(body.indexOf('_') + 1);
  const entry = pending.get(ref);

  if (!entry) {
    return interaction.update({ content: '⌛ This announcement expired — run `/senddmannounce` again.', embeds: [], components: [] }).catch(() => {});
  }
  if (interaction.user.id !== entry.authorId) {
    return interaction.reply({ content: '❌ This isn’t your announcement.', flags: 64 }).catch(() => {});
  }
  pending.delete(ref);

  if (!isConfirm) {
    return interaction.update({ content: '🚫 Cancelled — nothing was sent.', embeds: [], components: [] });
  }

  await interaction.update({ content: '📨 Sending… I’ll update this with the results.', embeds: [], components: [] });
  sendToEveryone(interaction, entry.message).catch((err) => services.logger && services.logger.error('DM announcement failed', err));
}

                                                                                
async function sendToEveryone(interaction, message) {
  const { logger } = services;
  let targets;
  try {
    const guild = services.discordClient.guilds.cache.get(services.config.discord.guildId) || (await services.discordClient.guilds.fetch(services.config.discord.guildId));
    const members = await fetchAllMembers(guild);
    targets = [...members.values()].filter((m) => !m.user.bot);
    if (!targets.length) {
      await interaction.editReply('❌ No members available to DM (member list could not be loaded — try again in a moment).').catch(() => {});
      return;
    }
  } catch (err) {
    await interaction.editReply(`❌ Could not fetch members: ${err.message}`).catch(() => {});
    return;
  }

  if (logger) await logger.info('DM announcement started', `${interaction.user.tag} is DMing **${targets.length}** member(s).`, undefined, 'system');

  const body = withOptOut(message);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    if (services.store.isDmOptedOut(targets[i].id)) {
      skipped++;
      continue;                       
    }
    try {
      await targets[i].send(body);
      sent++;
    } catch {
      failed++;                        
    }
    if (i > 0 && i % 20 === 0) {
      interaction.editReply(`📨 Sending… ${i}/${targets.length}  (✅ ${sent} · ⚠️ ${failed} unreachable · 🔕 ${skipped} opted out)`).catch(() => {});
    }
    await sleep(DM_DELAY_MS);
  }

  const summary = `✅ DM announcement complete — delivered to **${sent}**, **${failed}** couldn’t be reached, **${skipped}** opted out.`;
  interaction.editReply(summary).catch(() => {});
  if (logger) await logger.success('DM announcement done', summary, undefined, 'system');
}

   
                                                                             
                                                                       
   
async function broadcast(message) {
  const { logger } = services;
  const msg = String(message || '').trim().slice(0, MAX_LEN);
  if (!msg) return { sent: 0, failed: 0, total: 0, error: 'empty message' };

  const guild =
    services.discordClient.guilds.cache.get(services.config.discord.guildId) ||
    (await services.discordClient.guilds.fetch(services.config.discord.guildId));
  const members = await fetchAllMembers(guild);
  const targets = [...members.values()].filter((m) => !m.user.bot);

  if (logger) await logger.info('DM announcement started (web)', `DMing **${targets.length}** member(s) from the website panel.`, undefined, 'system');

  const body = withOptOut(msg);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    if (services.store.isDmOptedOut(targets[i].id)) {
      skipped++;
      continue;
    }
    try {
      await targets[i].send(body);
      sent++;
    } catch {
      failed++;
    }
    await sleep(DM_DELAY_MS);
  }
  const summary = `✅ DM announcement complete — delivered to **${sent}**, **${failed}** unreachable, **${skipped}** opted out.`;
  if (logger) await logger.success('DM announcement done (web)', summary, undefined, 'system');
  return { sent, failed, skipped, total: targets.length };
}

   
                                                                              
                                                       
   
async function handleDirectMessage(message) {
  try {
    if (message.author.bot) return;
    const content = (message.content || '').trim().toLowerCase();
    if (content === 'stop' || content === 'unsubscribe') {
      services.store.setDmOptOut(message.author.id, true);
      await message.reply('🔕 Notifications turned **off**. You won’t get announcement DMs anymore.\nType **start** to turn them back on.').catch(() => {});
    } else if (content === 'start' || content === 'subscribe') {
      services.store.setDmOptOut(message.author.id, false);
      await message.reply('🔔 Notifications turned **on**. Type **stop** anytime to opt out.').catch(() => {});
    }
  } catch (err) {
    if (services.logger) services.logger.error('DM opt-in/out handler crashed', err);
  }
}

module.exports = { showModal, handleModal, handleButton, broadcast, handleDirectMessage, MODAL_ID, PREFIX };
