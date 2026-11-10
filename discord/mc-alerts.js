'use strict';

   
                                                                               
                                                                            
   

const { EmbedBuilder } = require('discord.js');
const services = require('../services');
const { formatMcReason } = require('../minecraft/connection-utils');

const RED = 0xff5d73;
const DEDUP_MS = 60_000;

                                                          
const lastAlert = new Map();

function accountLabel(account) {
  return /^(buyer|seller)\d+$/.test(String(account))?String(account):'Buyer account '+String(account);
}

function shouldAlert(account, reason) {
  const key = String(account);
  const now = Date.now();
  const text = formatMcReason(reason);
  const prev = lastAlert.get(key);
  if (prev && now - prev.at < DEDUP_MS && prev.reason === text) return false;
  lastAlert.set(key, { at: now, reason: text });
  return true;
}

   
                       
                              
                                                        
                           
                              
                                        
                                       
                                 
   
async function notifyOwnerMcDisconnect({
  account = 1,
  event = 'disconnected',
  reason,
  host = '',
  reconnectInSec = 0,
  reconnecting = true,
  fixNote = '',
}) {
  if (!shouldAlert(account, reason)) return;

  const label = accountLabel(account);
  const reasonText = formatMcReason(reason);
  const titles = {
    kicked: `⛔ ${label} kicked`,
    disconnected: `🔌 ${label} disconnected`,
    error: `❌ ${label} connection error`,
  };

  let desc = `**Reason:** ${reasonText}`;
  if (host) desc += `\n**Host:** \`${host}\``;
  if (reconnecting) {
    desc += reconnectInSec > 0
      ? `\n\n**Auto-reconnect** in approximately ${reconnectInSec}s.`
      : '\n\n**Auto-reconnect** is scheduled.';
  } else {
    desc += '\n\nAuto-reconnect is **off** (manual stop). Use `/mc-start` or the dashboard to reconnect.';
  }
  if (fixNote) desc += `\n\n${fixNote}`;

  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle(titles[event] || titles.disconnected)
    .setDescription(desc.slice(0, 4000))
    .addFields({name:'Next step:',value:reconnecting?'Wait for the automatic reconnect. If this repeats, check the account login and the server connection in the dashboard.':'Start this account from the dashboard when you want it online again.'})
    .setTimestamp();

  return require('./operator-notifications').postEmbed(embed,{route:reconnecting?'errors':'system'});
}

                                                                              
function clearAlertDedup(account) {
  lastAlert.delete(String(account));
}

module.exports = { notifyOwnerMcDisconnect, clearAlertDedup };
