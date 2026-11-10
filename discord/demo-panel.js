'use strict';

   
                                                                           
                                                                 
                                                                       
  
                                                                                     
                                                         
   

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const services = require('../services');
const designs = require('./panel-designs');

const MAIN_COUNT = designs.count;
const TEST_COUNT = designs.testCount;

                                                      
async function displayData() {
  const s = await require('./panel').snapshot();
  const store = services.store;
  return designs.computeDisplay(s, store.buyMoneyEnabled(), store.buySkellyEnabled(), store.autosellPaused());
}

                                                          
let _bid = 0;
function previewComponents(idx, d, source, { pickable = false } = {}) {
  const layout = designs.buttonLayoutFor(idx, source);
  const rows = [];

  if (layout === 'moneyAutosell') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`demopanel_${_bid++}`).setLabel('Sell').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`demopanel_${_bid++}`).setLabel('Balance').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`demopanel_${_bid++}`).setLabel('Settings').setStyle(ButtonStyle.Primary)
      )
    );
  } else {
    const style = designs.sellStyleFor(idx, source);
    const b = [];
    if (d.moneyOn) b.push(new ButtonBuilder().setCustomId(`demopanel_${_bid++}`).setLabel('Sell Money').setEmoji('💰').setStyle(style));
    if (d.skellyOn) b.push(new ButtonBuilder().setCustomId(`demopanel_${_bid++}`).setLabel('Sell Skellys').setEmoji('💀').setStyle(style));
    b.push(new ButtonBuilder().setCustomId(`demopanel_${_bid++}`).setLabel('Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary));
    rows.push(new ActionRowBuilder().addComponents(...b));
    const links = designs.linksFor(idx, source);
    if (links.length) {
      rows.push(
        new ActionRowBuilder().addComponents(
          ...links.map((l) => {
            const lb = new ButtonBuilder().setLabel(l.label).setStyle(ButtonStyle.Link).setURL(l.url);
            if (l.emoji) lb.setEmoji(l.emoji);
            return lb;
          })
        )
      );
    }
  }

  if (pickable) {
    const live = designs.isActive('test', idx);
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`demopanel_pick_test_${idx}`)
          .setLabel(live ? '✓ Live panel' : 'Use This Design')
          .setEmoji(live ? '✅' : '🎨')
          .setStyle(live ? ButtonStyle.Success : ButtonStyle.Primary)
          .setDisabled(live)
      )
    );
  }
  return rows;
}

function isAdmin(interaction) {
  const cfg = services.config.discord;
  if (String(interaction.user.id) === String(cfg.ownerId)) return true;
  const perms = interaction.memberPermissions;
  if (perms && perms.has(PermissionFlagsBits.Administrator)) return true;
  return Boolean(cfg.adminRoleId && interaction.member && interaction.member.roles && interaction.member.roles.cache && interaction.member.roles.cache.has(cfg.adminRoleId));
}

const slashDefinitions = [
  new SlashCommandBuilder()
    .setName('demopanel')
    .setDescription('Post new test panel designs in this channel to compare (admin)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('demopanels')
    .setDescription(`Preview an original panel design (1-${MAIN_COUNT}) — does not change live`)
    .addIntegerOption((o) => o.setName('design').setDescription(`Original design (1-${MAIN_COUNT})`).setRequired(true).setMinValue(1).setMaxValue(MAIN_COUNT))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('choosepanel')
    .setDescription(`Set live /panel to an original design (1-${MAIN_COUNT})`)
    .addIntegerOption((o) => o.setName('design').setDescription(`Original design (1-${MAIN_COUNT})`).setRequired(true).setMinValue(1).setMaxValue(MAIN_COUNT))
    .toJSON(),
];
const isDemoCommand = (n) => n === 'demopanel' || n === 'demopanels' || n === 'choosepanel';

async function handleCommand(interaction) {
  if (interaction.commandName === 'demopanel') return handleGallery(interaction);
  if (interaction.commandName === 'choosepanel') return handleChoose(interaction);
  return handlePreview(interaction);
}

                                                              
async function handleGallery(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ Only an admin/owner can post test panels.', flags: 64 });
  await interaction.deferReply({ flags: 64 });
  try {
    const d = await displayData();
    _bid = 0;
    for (let idx = 0; idx < TEST_COUNT; idx++) {
      const live = designs.isActive('test', idx);
      await interaction.channel.send({
        content: `🎨 **New Test Design ${idx + 1}/${TEST_COUNT}: ${designs.labelFor(idx, 'test')}**${live ? '  ✅ _(your live panel)_' : ''}`,
        embeds: [designs.renderEmbed(idx, d, 'test')],
        components: previewComponents(idx, d, 'test', { pickable: true }),
      });
    }
    await interaction.editReply({
      content:
        `✅ Posted **${TEST_COUNT}** new test designs above (not the original 8).\n` +
        'Click **Use This Design** on whichever you like, then run `/panel` if you haven\'t posted the live panel yet.\n' +
        `_To go back to an original design: \`/choosepanel 1\`–\`${MAIN_COUNT}\`._`,
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Couldn't post test panels: ${err.message}` });
  }
}

async function handlePreview(interaction) {
  const n = interaction.options.getInteger('design');
  if (n < 1 || n > MAIN_COUNT) return interaction.reply({ content: `Pick an original design from 1 to ${MAIN_COUNT}.`, flags: 64 });
  await interaction.deferReply({ flags: 64 });
  try {
    const d = await displayData();
    _bid = 0;
    const idx = n - 1;
    const live = designs.isActive('main', idx);
    await interaction.editReply({
      content:
        `🔍 **Original Design ${n}/${MAIN_COUNT}: ${designs.labelFor(idx, 'main')}**` +
        (live ? '  ✅ _(live panel)_' : `\n_Use \`/choosepanel ${n}\` to make this live._`) +
        `\n_For new designs, run \`/demopanel\`._`,
      embeds: [designs.renderEmbed(idx, d, 'main')],
      components: previewComponents(idx, d, 'main'),
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Couldn't render preview: ${err.message}` });
  }
}

async function applyTest(idx, interaction) {
  designs.setChosenTest(idx);
  const posted = services.store.getPanel && services.store.getPanel();
  try {
    await require('./panel').refresh(true);
  } catch {
                     
  }
  const msg = `✅ **Live panel set to "${designs.labelFor(idx, 'test')}"** (test design ${idx + 1}).${posted ? ' Updated in place.' : ' Run `/panel` to post it.'}`;
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
  else await interaction.reply({ content: msg, flags: 64 });
}

async function applyMain(idx, interaction) {
  designs.setChosenMain(idx);
  const posted = services.store.getPanel && services.store.getPanel();
  try {
    await require('./panel').refresh(true);
  } catch {
                     
  }
  const msg = `✅ **Live panel set to original design ${idx + 1}: ${designs.labelFor(idx, 'main')}.**${posted ? ' Updated in place.' : ' Run `/panel` to post it.'}`;
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
  else await interaction.reply({ content: msg, flags: 64 });
}

async function handleChoose(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ Only an admin/owner can change the live panel.', flags: 64 });
  const n = interaction.options.getInteger('design');
  if (n < 1 || n > MAIN_COUNT) return interaction.reply({ content: `Pick an original design from 1 to ${MAIN_COUNT}.`, flags: 64 });
  await interaction.deferReply({ flags: 64 });
  await applyMain(n - 1, interaction);
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (id.startsWith('demopanel_pick_test_')) {
    if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ Only an admin/owner can change the live panel.', flags: 64 });
    const idx = parseInt(id.slice('demopanel_pick_test_'.length), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= TEST_COUNT) {
      return interaction.reply({ content: 'Invalid design.', flags: 64 });
    }
    await interaction.deferReply({ flags: 64 });
    return applyTest(idx, interaction);
  }
  return interaction.reply({ content: '🔍 Preview only — use **Use This Design** to apply a test panel.', flags: 64 });
}

module.exports = { slashDefinitions, isDemoCommand, handleCommand, handleButton, count: MAIN_COUNT };
