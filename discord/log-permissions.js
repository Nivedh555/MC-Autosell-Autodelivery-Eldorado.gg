'use strict';
const { OverwriteType, PermissionFlagsBits } = require('discord.js');
const { isSnowflake } = require('./ids');

async function buildLogPermissions(guild, client, configuredRole, warn = console.warn, ownerId) {
  const everyoneId = guild.roles.everyone.id;
  const botId = client.user?.id;
  if (!isSnowflake(everyoneId) || !isSnowflake(botId)) throw Error('Log channel setup requires valid guild and connected bot IDs');
  let adminRole;
  if (isSnowflake(configuredRole) && configuredRole !== everyoneId) {
    try { adminRole = await guild.roles.fetch(configuredRole); } catch {                                                 }
  }
  if (!adminRole || adminRole.id !== configuredRole || adminRole.id === everyoneId) {
    adminRole = null;
    warn('[log-channels] Admin role is missing or unavailable. Private logs remain restricted to the bot, configured owner and server administrators; configure a valid admin role in Discord settings.');
  }
  const bot = { id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] };
  const privateOverwrites = [
    { id: everyoneId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...(adminRole ? [{ id: adminRole.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
    ...(isSnowflake(ownerId)&&ownerId!==botId?[{id:ownerId,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]}]:[]),
    bot,
  ];
  const publicOverwrites = [
    { id: everyoneId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    bot,
  ];
  return { privateOverwrites, publicOverwrites };
}
module.exports = { buildLogPermissions };
