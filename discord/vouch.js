'use strict';

   
                                                                    
                                                  
   

const services = require('../services');

                                                                                     
function vouchLine() {
  const { guildId, vouchChannelId } = services.config.discord;
  if (!vouchChannelId) return '';
  const url = `https://discord.com/channels/${guildId}/${vouchChannelId}`;
  return `\n\n💚 **Happy with your payout?** Please leave us a vouch here: ${url}`;
}

module.exports = { vouchLine };
