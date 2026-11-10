'use strict';

   
                                                                            
                                                              
  
                                                                           
                                                                                
                                                                 
   

const services = require('../services');

                                                                          
async function grantSoldRole(discordId) {
  const { discordClient, config, logger, store } = services;
  const roleId = (store && typeof store.getSoldRoleId === 'function' && store.getSoldRoleId()) || config.discord.soldRoleId;
  if (!roleId || !discordClient || !discordId) return;

  try {
    const guild = await discordClient.guilds.fetch(config.discord.guildId);
    const member = await guild.members.fetch(discordId);
    if (member.roles.cache.has(roleId)) return;                                  
    await member.roles.add(roleId, 'Sold to Autosell');
    if (logger) await logger.info('Seller role granted', `Gave <@${discordId}> the seller role.`, undefined, 'system');
  } catch (err) {
    if (logger) {
      await logger.warn(
        'Could not grant seller role',
        `<@${discordId}>: ${err.message}\nCheck the bot has **Manage Roles** and that its role is **above** the seller role (id \`${roleId}\`).`,
        undefined,
        'errors'
      );
    }
  }
}

module.exports = { grantSoldRole };
