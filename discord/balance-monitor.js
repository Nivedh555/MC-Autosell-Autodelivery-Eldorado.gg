'use strict';

   
                                                              
                                                                                
                                                                               
                                                                                  
                                                      
  
                                                                                 
                                                            
   

const { EmbedBuilder } = require('discord.js');
const services = require('../services');
const { formatUsd } = require('../sell/money-format');
const templates = require('./templates/notification-text');
const engine = require('./templates/engine');

const ORANGE = 0xdc143c;

let checking = false;

async function notifyLogs(embed,route='errors') {
  return require('./operator-notifications').postEmbed(embed,{route});
}

                                                          
function capacityText(store, usd) {
  const price = store.getPrice();
  const ratePerM = store.getRate();
  const skellys = price > 0 ? Math.floor(usd / price) : 0;
  const donut = ratePerM > 0 ? (usd / ratePerM) * 1e6 : 0;
  return `Rate: **$${Number(ratePerM.toFixed(4))}/M ($${(ratePerM * 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/B)** · Price: **$${price.toFixed(2)}/skelly**\nCan still buy ~**${Math.floor(donut).toLocaleString('en-US')}** money / **${skellys.toLocaleString('en-US')}** skellys`;
}

async function check() {
  if (checking) return;
  checking = true;
  try {
    const { wallet, store } = services;
    if (!wallet || !wallet.enabled) return;

    let litoshi = 0;
    try {
      litoshi = await wallet.getBalanceLitoshi();
    } catch {
      return;                            
    }
    let price = null;
    try {
      price = await wallet.getRate();
    } catch {
      price = wallet.cachedRate ? wallet.cachedRate() : null;
    }
    if (!price) return;

    const usd = (litoshi / 1e8) * price;
    const last = Number(store.getSetting('lastBalanceUsd', usd));
    const LOW_USD = store.getLowBalanceUsd();
    const RESTOCK_USD = store.getRestockUsd();

                                                                
    if (usd - last >= RESTOCK_USD) {
      const addedUsd = formatUsd(usd - last);
      const totalUsd = formatUsd(usd);
      const capacity = capacityText(store, usd);
      const embed = new EmbedBuilder()
        .setColor(ORANGE)
        .setTitle(engine.render(templates.balance.restockTitle, {}))
        .setDescription(engine.render(templates.balance.restockDesc, { addedUsd, totalUsd, capacity }, 'description'))
        .setTimestamp();
      await notifyLogs(embed,'system');
    }

                                                          
    const lowAlerted = Boolean(store.getSetting('lowAlerted', false));
    if (usd < LOW_USD && !lowAlerted) {
      store.setAutosellPaused(true);
      store.setSetting('lowAlerted', true);
      const totalUsd = formatUsd(usd);
      const capacity = capacityText(store, usd);
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(engine.render(templates.balance.lowTitle, {}))
        .setDescription(engine.render(templates.balance.lowDesc, { totalUsd, capacity }, 'description'))
        .setTimestamp();
      await notifyLogs(embed);
      require('./panel').refresh().catch(() => {});
    } else if (usd >= LOW_USD && lowAlerted) {
      store.setSetting('lowAlerted', false);                                        
    }

    store.setSetting('lastBalanceUsd', +usd.toFixed(2));
  } finally {
    checking = false;
  }
}

module.exports = { check, notifyLogs };
