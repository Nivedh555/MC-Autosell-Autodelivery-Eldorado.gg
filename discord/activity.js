'use strict';

   
                                                                                  
                                                                               
                                                                                
  
                                                                               
                                                                                
                                                                      
   

const services = require('../services');
const { formatDonut } = require('../sell/money-format');

const pending = new Map();                            
const pkey = (id, kind) => id + '|' + kind;

function detailsOf(interaction, kind) {
  const seller = services.store.getSeller(interaction.user.id) || {};
  return {
    discordId: interaction.user.id,
    tag: interaction.user.tag,
    kind,
    ign: seller.ign || '',
    ltcAddress: seller.ltcAddress || '',
    verified: Boolean(seller.verifiedIgn),
    priorSales: seller.stats ? seller.stats.sales || 0 : 0,
    balanceUsd: Number(seller.balanceUsd || 0),
  };
}

function post(action, d, amount) {
  const kindLabel = d.kind === 'money' ? '💰 Money' : '💀 Skellys';
  const amountText = amount != null ? (d.kind === 'money' ? formatDonut(amount) : `${amount} spawner(s)`) : '';
  const title = action === 'click' ? '🖱️ Sell button clicked' : '📝 Sell amount entered';
  const desc =
    action === 'click'
      ? `<@${d.discordId}> clicked **Sell ${kindLabel}**.\n_Amount: (not entered yet)_`
      : `<@${d.discordId}> entered **${amountText}** to sell (${kindLabel}).`;
  const fields = [
    { name: 'User', value: `${d.tag}\n\`${d.discordId}\``, inline: true },
    { name: 'IGN', value: d.ign || '_not set_', inline: true },
    { name: 'Verified', value: d.verified ? '✅ yes' : '❌ no', inline: true },
    { name: 'Prompted amount', value: amountText ? `**${amountText}**` : '❌ nothing entered', inline: true },
    { name: 'Prior sales', value: String(d.priorSales), inline: true },
    { name: 'Parked balance', value: `$${d.balanceUsd.toFixed(2)}`, inline: true },
    { name: 'LTC address', value: d.ltcAddress ? `\`${d.ltcAddress}\`` : '_not set_', inline: false },
  ];
  services.logger.info(title, desc, fields, 'activity');
}

   
                                                                                                                                 
   
async function track({ interaction, kind, action, amount }) {
  try {
    const { store } = services;
    const now = Date.now();
    for (const [key,value] of pending) if (now-value.ts >= 15*60000) pending.delete(key);
    if (pending.size >= 2048) pending.delete(pending.keys().next().value);
    const d = detailsOf(interaction, kind);
    if (action === 'clicked') {
      const rec = store.logActivity({ ...d, prompted: false, amount: null });
      pending.set(pkey(d.discordId, kind), { rec, ts: Date.now() });
      post('click', d, null);
    } else {
                                                                        
      const p = pending.get(pkey(d.discordId, kind));
      if (p && Date.now() - p.ts < 15 * 60000) {
        p.rec.prompted = true;
        p.rec.amount = amount;
        store.saveActivity();
        pending.delete(pkey(d.discordId, kind));
      } else {
        store.logActivity({ ...d, prompted: true, amount });
      }
      post('amount', d, amount);
    }
  } catch (err) {
    if (services.logger) services.logger.error('Activity tracking failed', err);
  }
}

module.exports = { track };
