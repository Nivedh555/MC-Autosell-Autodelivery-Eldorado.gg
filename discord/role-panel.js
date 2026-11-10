'use strict';

   
                                                                                   
                                                                                  
                                                           
   

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const services = require('../services');

const ORANGE = 0xdc143c;

                                                                        
const ROLES = [
  { id: 'restock', name: 'Restock Ping', emoji: '🔄', color: 0x2ecc71, desc: 'get pinged on restocks' },
  { id: 'rate', name: 'Rate Ping', emoji: '💲', color: 0x3498db, desc: 'get pinged on rate changes' },
];

const definitions = [new SlashCommandBuilder().setName('rolepanel').setDescription('Post the self-assignable ping roles panel.').toJSON()];
const COMMAND_NAMES = new Set(['rolepanel']);
function isRoleCommand(name) {
  return COMMAND_NAMES.has(name);
}

                                                                             
async function ensureRole(guild, def) {
  let role = guild.roles.cache.find((r) => r.name.toLowerCase() === def.name.toLowerCase());
  if (!role) role = await guild.roles.create({ name: def.name, color: def.color, mentionable: true, reason: 'Self-assignable ping role' });
  return role;
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('🔔 Ping Roles')
    .setDescription('Tap a button to toggle a role on or off.\n\n🔄 **Restock Ping** — restock alerts\n💲 **Rate Ping** — rate-change alerts');
  const row = new ActionRowBuilder().addComponents(
    ROLES.map((r) => new ButtonBuilder().setCustomId(`selfrole_${r.id}`).setLabel(r.name).setEmoji(r.emoji).setStyle(ButtonStyle.Primary))
  );
  return { embeds: [embed], components: [row] };
}

async function handleCommand(interaction) {
  if (interaction.commandName !== 'rolepanel') return undefined;
  if (!require('./commands').isAdmin(interaction)) return interaction.reply({ content: '⛔ Admin only.', flags: 64 });
                                                        
  try {
    for (const def of ROLES) await ensureRole(interaction.guild, def);
  } catch (err) {
    return interaction.reply({ content: `❌ Couldn't create the roles: ${err.message} (bot needs **Manage Roles**).`, flags: 64 });
  }
  await interaction.channel.send(panelPayload());
  return interaction.reply({ content: '✅ Role panel posted.', flags: 64 });
}

async function handleButton(interaction) {
  const def = ROLES.find((r) => r.id === interaction.customId.slice('selfrole_'.length));
  if (!def) return undefined;
  try {
    const role = await ensureRole(interaction.guild, def);
    const member = interaction.member;
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role.id, 'self-role toggle');
      return interaction.reply({ content: `➖ Removed **${def.name}**.`, flags: 64 });
    }
    await member.roles.add(role.id, 'self-role toggle');
    return interaction.reply({ content: `➕ You now have **${def.name}**.`, flags: 64 });
  } catch (err) {
    return interaction.reply({ content: `❌ ${err.message} — the bot needs **Manage Roles** and a role above this one.`, flags: 64 });
  }
}

module.exports = { definitions, isRoleCommand, handleCommand, handleButton, ROLES };
