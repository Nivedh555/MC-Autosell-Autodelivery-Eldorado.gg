'use strict';

   
                                                                               
                                                                               
                                                                             
                                            
  
                                                                               
                                                                               
   

const { EmbedBuilder } = require('discord.js');
const services = require('../services');
const { formatDonut, formatUsd } = require('../sell/money-format');

                                                                            
const LTC_LOGO = 'https://cryptologos.cc/logos/litecoin-ltc-logo.png';
const ORANGE = 0xdc143c;

function paymentsChannel() {
  const id = services.logChannels && services.logChannels.payments;
  if (!id) return null;
  const ch = services.discordClient && services.discordClient.channels.cache.get(id);
  return ch && ch.isTextBased() ? ch : null;
}

                                                                           
function explorerTx(txid) {
  const base = services.config.wallet.apiBase.replace(/\/api\/?$/, '');
  return `${base}/tx/${txid}`;
}

                                                                                
function amountLines(pending = {}, fallbackUsd = 0) {
  const lines = [];
  if (pending.moneyDonut > 0) lines.push(`💰 **${formatDonut(pending.moneyDonut)}** money`);
  if (pending.skellyCount > 0) lines.push(`💀 **${pending.skellyCount.toLocaleString('en-US')}** skellys`);
                                                                             
  if (!lines.length) lines.push(`💵 **${formatUsd(fallbackUsd)}** balance`);
  return lines.join('\n');
}

                                                                                  
function buildPaymentMessage({ discordId, anon, ltc, usd, txid, pending }) {
  const fields = [
    { name: 'Amount', value: amountLines(pending, usd), inline: true },
    { name: 'Payout', value: `**${Number(ltc).toFixed(6)} LTC** (${formatUsd(usd)})`, inline: true },
  ];
                                                                     
  if (txid) fields.push({ name: 'Transaction', value: `[View on BlockExplorer](${explorerTx(txid)})`, inline: false });
  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle(anon ? '🕵️ Anonymous Payment Completed' : '✅ Payment Completed')
    .setThumbnail(LTC_LOGO)
    .addFields(...fields)
    .setFooter({ text: 'DonutSMP Autosell • paid in Litecoin' })
    .setTimestamp();
  const content = anon ? '' : `Payment for <@${discordId}>`;
  return { content, embeds: [embed], allowedMentions: { parse: [] } };
}

   
                                                                                  
                                                                    
                                                                                                             
   
async function postPaymentLog(opts) {
  const ch = paymentsChannel();
  if (!ch) return null;
  try {
    return await ch.send(buildPaymentMessage(opts));
  } catch (err) {
                                          
    console.error('[payments] failed to post:', err.message);
    return null;
  }
}

                                                                             
async function updatePaymentLog(message, opts) {
  if (!message) return;
  try {
    await message.edit(buildPaymentMessage(opts));
  } catch (err) {
                                          
    console.error('[payments] failed to edit:', err.message);
  }
}

module.exports = { postPaymentLog, updatePaymentLog, LTC_LOGO };
