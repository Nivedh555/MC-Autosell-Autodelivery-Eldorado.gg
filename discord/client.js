'use strict';

   
                                                                                   
                                                                              
   

const { Client, GatewayIntentBits, Partials, REST, Routes, Events, MessageFlags } = require('discord.js');

const services = require('../services');
const commands = require('./commands');
const panel = require('./panel');
const logChannels = require('./log-channels');
const statsChannels = require('./stats-channels');

async function start() {
  const { config } = services;
  if (!config.discord.token || config.discord.token.length < 25) {
    services.discordClient = null;
    throw new Error('No valid Discord token provided');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
  services.discordClient = client;

  try {
    client.once(Events.ClientReady, async (c) => {
                                            
      require('../services/console-logger').line('READY', 'DISCORD', 'Connected to Discord', { Account: c.user.tag });
      await registerCommands();
      try {
        await logChannels.ensure();
      } catch (err) {
                                              
        console.error('[discord] log channel setup failed:', err.message);
      }
      try {
        await statsChannels.ensure();
      } catch (err) {
                                              
        console.error('[discord] stat channel setup failed:', err.message);
      }
      try {
        await panel.validatePanelRef();
      } catch (err) {
                                              
        console.error('[discord] panel ref check failed:', err.message);
      }
      await services.logger.success('Sell bot online', `Logged in as **${c.user.tag}**.`, undefined, 'system');
      setInterval(() => panel.refresh().catch(() => {}), 60_000);
      setInterval(() => require('./balance-monitor').check().catch(() => {}), 60_000);
    });

    client.on(Events.InteractionCreate, routeInteraction);

    client.on(Events.MessageCreate, async (message) => {
      try {
        if (message.partial) await message.fetch().catch(() => {});
        if (!message.guild) return await require('./dm-announce').handleDirectMessage(message);
        if (message.guild.id !== services.config.discord.guildId) return undefined;
        if (await require('./tutorial').handleMessage(message)) return undefined;
        if (await require('./automod').handleMessage(message)) return undefined;
        return undefined;
      } catch {
                    
      }
    });

    await client.login(config.discord.token);
    await new Promise((resolve) => {
      if (client.isReady()) return resolve();
      client.once(Events.ClientReady, () => resolve());
    });
    services.discordClient = client;
    return client;
  } catch (err) {
    services.discordClient = null;
    try {
      client.destroy();
    } catch {}
    throw err;
  }
}

async function registerCommands() {
  const { config, discordClient } = services;
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  try {
    const rolePanel = require('./role-panel');
    const manualSale = require('./manual-sale');
    const demoPanel = require('./demo-panel');
    await rest.put(Routes.applicationGuildCommands(discordClient.user.id, config.discord.guildId), {
      body: [...commands.definitions, ...rolePanel.definitions, ...manualSale.slashDefinitions, ...demoPanel.slashDefinitions],
    });
                                          
    require('../services/console-logger').line('READY', 'DISCORD', 'Slash commands registered');
  } catch (err) {
                                          
    console.error('[discord] Failed to register commands:', err.message);
  }
}

async function routeInteraction(interaction) {
  try {
    if (interaction.guildId && interaction.guildId !== services.config.discord.guildId) {
      if (interaction.isRepliable && interaction.isRepliable()) await interaction.reply({ content: 'This bot is private.', flags: 64 }).catch(() => {});
      return undefined;
    }
    const rolePanel = require('./role-panel');
    const manualSale = require('./manual-sale');
    const demoPanel = require('./demo-panel');
    if (interaction.isChatInputCommand()) {
      if (rolePanel.isRoleCommand(interaction.commandName)) return await rolePanel.handleCommand(interaction);
      if (manualSale.isManualCommand(interaction.commandName)) return await manualSale.handleCommand(interaction);
      if (demoPanel.isDemoCommand(interaction.commandName)) return await demoPanel.handleCommand(interaction);
      return await commands.handleCommand(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('demopanel_')) return await demoPanel.handleButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('manualsale_')) return await manualSale.handleButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('selfrole_')) return await rolePanel.handleButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId === 'dmannounce_modal') return await require('./dm-announce').handleModal(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('dmannounce_')) return await require('./dm-announce').handleButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('idn_')) return await require('./identity').handleChoice(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('panel_')) return await panel.handleButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('panel_')) return await panel.handleModal(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('admin_')) return await require('./admin-panel').handleButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('admin_')) return await require('./admin-panel').handleModal(interaction);
  } catch (err) {
    try {
      if (![10062, 40060].includes(Number(err.code)) && interaction.isRepliable()) {
        const payload = { content: '❌ This action could not finish. Check the activity feed before retrying.' };
        if (interaction.replied || interaction.deferred) await interaction.editReply(payload);
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
    } catch {
                  
    }
    await services.logger.error('Interaction handler crashed', err, {
      custom: interaction.customId || interaction.commandName,
      code: err.code || err.name,
      ageMs: Number.isFinite(interaction.createdTimestamp) ? Math.max(0, Date.now() - interaction.createdTimestamp) : 'unknown',
      acknowledged: Boolean(interaction.replied || interaction.deferred),
    });
  }
}

module.exports = { start };
