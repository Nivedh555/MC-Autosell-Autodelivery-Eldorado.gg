'use strict';

   
                                                                                  
                                                                             
                                                                                 
                                                                              
                          
   

const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const services = require('../services');

const PREFIX = 'idn_';                                            
const ORANGE = 0xdc143c;
const TTL_MS = 60 * 60 * 1000;                                          

const pending = new Map();                                                              

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > TTL_MS) pending.delete(k);
}, 5 * 60 * 1000).unref?.();

function buildPrompt(ref, what) {
  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🪪 Public or Anonymous?')
    .setDescription(
      `Choose how this **${what}** sale appears in the public **#payments** feed and on the **leaderboard**:\n\n` +
        '🌐 **Public** — shown with your name\n' +
        '🕵️ **Anonymous** — shown as “Anonymous”'
    )
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}${ref}_public`).setLabel('Public').setEmoji('🌐').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}${ref}_anon`).setLabel('Anonymous').setEmoji('🕵️').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

   
                                                                             
                                                                              
                                         
                                                                                                                                                        
   
async function promptAfterSale({ discordId, what, interaction, feed = null }) {
  const ref = crypto.randomBytes(6).toString('hex');

                                                                              
                                                                          
  let feedMsg = null;
  const postedAnon = services.store.isAnon(discordId);
  if (feed) {
    feedMsg = await require('./payments')
      .postPaymentLog({ discordId, anon: postedAnon, ...feed })
      .catch(() => null);
  }
  pending.set(ref, { discordId, feed, feedMsg, postedAnon, createdAt: Date.now() });

  const payload = buildPrompt(ref, what);
  try {
    const u = await services.discordClient.users.fetch(discordId);
    await u.send(payload);
  } catch {
                    
  }
  if (interaction) {
    try {
      await interaction.followUp({ ...payload, flags: 64 });
    } catch {
                                                                             
    }
  }
}

                                                                            
async function handleChoice(interaction) {
  const body = interaction.customId.slice(PREFIX.length);                       
  const cut = body.lastIndexOf('_');
  const ref = body.slice(0, cut);
  const anon = body.slice(cut + 1) === 'anon';
  const entry = pending.get(ref);

  if (!entry) {
    return interaction.reply({ content: '⌛ This choice expired — your payout already posted and stays as last set.', flags: 64 }).catch(() => {});
  }
  if (interaction.user.id !== entry.discordId) {
    return interaction.reply({ content: '❌ This isn’t your sale to choose.', flags: 64 }).catch(() => {});
  }

  try {
    await interaction.deferUpdate();
  } catch {
    await interaction.deferReply({ flags: 64 }).catch(() => {});
  }

  pending.delete(ref);

  services.store.setAnon(entry.discordId, anon);
  if (entry.feed) {
    const payments = require('./payments');
    if (entry.feedMsg && anon !== entry.postedAnon) {
                                                                    
      await payments.updatePaymentLog(entry.feedMsg, { discordId: entry.discordId, anon, ...entry.feed }).catch(() => {});
    } else if (!entry.feedMsg) {
                                                                           
      await payments.postPaymentLog({ discordId: entry.discordId, anon, ...entry.feed }).catch(() => {});
    }
  }

  const confirm = anon
    ? '🕵️ Done — this sale is now **Anonymous** (feed + leaderboard).'
    : '🌐 Done — this sale is now **Public** (shown with your name).';
  try {
    await interaction.editReply({ content: confirm, embeds: [], components: [] });
  } catch {
    await interaction.followUp({ content: confirm, flags: 64 }).catch(() => {});
  }
}

module.exports = { promptAfterSale, handleChoice, PREFIX };
