'use strict';

   
                                                                                
                                                                                  
                                                                                  
                                                                                  
                                                                              
   

const { EmbedBuilder } = require('discord.js');
const services = require('../services');
const templates = require('./templates/sale-messages');
const engine = require('./templates/engine');

function ctx(orderId) {
  const order = services.store.getOrder(orderId);
  const interaction = services.sellManager && services.sellManager.interactions.get(orderId);
  return { order, interaction };
}

async function dm(order, payload) {
  if (!order) return;
  try {
    const u = await services.discordClient.users.fetch(order.sellerDiscordId);
    await u.send(payload);
  } catch {
                                                               
  }
}

                                                                           
function explorerTx(txid) {
  const base = services.config.wallet.apiBase.replace(/\/api\/?$/, '');
  return `${base}/tx/${txid}`;
}

                                                                                 
                                                                                     
async function live(orderId, content) {
  const { order, interaction } = ctx(orderId);
  const body = engine.render(templates.skelly.stepPrefix, { content });
  await dm(order, { content: body });                              
  if (interaction) {
    try {
      await interaction.followUp({ content: body, flags: 64 });
    } catch {
                                                        
    }
  }
}

                                                 
async function post(orderId, content) {
  const { order, interaction } = ctx(orderId);
  await dm(order, typeof content === 'string' ? { content } : content);
  if (interaction) {
    try {
      await interaction.followUp({ content, flags: 64 });
    } catch {
                         
    }
  }
}

                                                                     
async function complete(order, { success, reason, collected }) {
  const interaction = services.sellManager && services.sellManager.interactions.get(order.id);

  const embed = new EmbedBuilder()
    .setTimestamp()
    .setColor(success ? 0xdc143c : 0xed4245)
    .setTitle(engine.render(success ? templates.skelly.successTitle : templates.skelly.failedTitle))
    .addFields({ name: 'Order', value: '`' + order.id + '`', inline: true });

  if (success) {
    const p = order.payout || {};
    const usd = Number(order.payoutUsd || 0).toFixed(4);
    
    let paidLine = '';
    if (p.txid) {
        paidLine = engine.render(templates.skelly.paidLine, { ltc: p.ltc, usd, txLink: explorerTx(p.txid) });
    } else {
        paidLine = engine.render(templates.skelly.paidLineNoTx, { ltc: p.ltc, usd });
    }
    
    const vouchLine = require('./vouch').vouchLine();
    embed.setDescription(engine.render(templates.skelly.successDesc, { count: order.count, paidLine, vouchLine }, 'description'));
  } else {
    const safeReason = reason || 'Unknown reason';
    if (collected) {
        embed.setDescription(engine.render(templates.skelly.failedDesc, { reason: safeReason, collected }, 'description'));
    } else {
        embed.setDescription(engine.render(templates.skelly.failedDescNoCollected, { reason: safeReason }, 'description'));
    }
  }

  await dm(order, { embeds: [embed] });                
  if (interaction) {
    try {
      await interaction.followUp({ embeds: [embed], flags: 64 });
    } catch {
                         
    }
  }
}

module.exports = { post, live, complete, dm, explorerTx };
