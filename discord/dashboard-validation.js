'use strict';
const { PermissionFlagsBits } = require('discord.js');
const { isSnowflake } = require('./ids');

async function postingChannel(services, channelId) {
  if (!isSnowflake(channelId)) throw Error('Select a valid Discord text channel.');
  if (!services.discordClient?.isReady?.()) throw Error('The Discord bot is offline. Check its saved token and server connection.');
  const channel = await services.discordClient.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || ![0, 5].includes(channel.type)) throw Error('Choose a server text or announcement channel.');
  if (channel.guildId !== services.config?.discord?.guildId) throw Error('The channel does not belong to the configured Discord server.');
  const permissions = channel.permissionsFor(services.discordClient.user);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw Error('Allow the bot to View Channel, Send Messages and Embed Links in this channel.');
  }
  return channel;
}

function validateTemplate(value) {
  const string = (name, max, optional = true) => {
    const v = value[name];
    if (v == null && optional) return;
    if (typeof v !== 'string' || v.length > max) throw Error(name + ' must be text of at most ' + max + ' characters.');
  };
  string('author', 256); string('title', 256); string('description', 4096); string('footer', 2048);
  if (value.color && !/^#?[a-f\d]{6}$/i.test(value.color)) throw Error('Choose a six-digit embed color.');
  if (value.fields != null && (!Array.isArray(value.fields) || value.fields.length > 25)) throw Error('An embed can have up to 25 fields.');
  let length = ['author', 'title', 'description', 'footer'].reduce((sum, name) => sum + (value[name]?.length || 0), 0);
  for (const field of value.fields || []) {
    if (!field || typeof field.name !== 'string' || field.name.length > 256 || typeof field.value !== 'string' || field.value.length > 1024) throw Error('Each embed field needs a name up to 256 characters and a value up to 1,024 characters.');
    length += field.name.length + field.value.length;
  }
  if (length > 6000) throw Error('The complete embed must be under 6,000 characters.');
  if (value.buttonLayout && !['money', 'moneyAutosell', 'default'].includes(value.buttonLayout)) throw Error('Unknown sell button layout.');
  return value;
}

module.exports = { postingChannel, validateTemplate };
