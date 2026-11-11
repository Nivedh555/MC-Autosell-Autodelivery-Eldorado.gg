'use strict';

   
                                                                            
                                                                            
                                 
  
                                                                  
                                                                    
                                                              
                                                         
  
                                                                                 
                                 
  
                                                                                  
                                                                                  
                                    
   

const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const services = require('../services');
const panel = require('./panel');
const { formatDonut } = require('../sell/money-format');

const templates = require('./templates/stats-text');
const engine = require('./templates/engine');

const STORE_FILE = path.resolve(__dirname, '..', 'data', 'stats-channels.json');
let CATEGORY_NAME = '📊 SELL STATS';                                                                           

                                                                               
                                                              
const REFRESH_MS = 6 * 60 * 1000;
const MIN_EDIT_INTERVAL_MS = 5 * 60 * 1000;

                                                                                
const CHANNELS = [
  { key: 'balMoney', initialName: '💰 BAL: loading…' },
  { key: 'balSkelly', initialName: '💀 BAL: loading…' },
  { key: 'rateMoney', initialName: '🏷️ Rate: loading…' },
  { key: 'rateSkelly', initialName: '💲 Rate: loading…' },
  { key: 'status', initialName: '🤖 Status: loading…' },
];

const lastEditAt = new Map();                                                
let timer = null;

function loadSaved() {
  try {
    const p = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { categoryId: p.categoryId || null, channels: p.channels && typeof p.channels === 'object' ? p.channels : {} };
  } catch {
    return { categoryId: null, channels: {} };
  }
}
function save(state) {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
                                          
    console.error('[stats-channels] persist failed:', err.message);
  }
}

                                                                                       
function buildNames(s) {
  const usd = s.usd != null ? `$${s.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$—';
  const money = s.canDonut != null ? formatDonut(s.canDonut).toUpperCase() : '—';              
  const skellys = s.canSkellys != null ? formatDonut(s.canSkellys) : '—';             
  
                                         
  const ratePerB = s.ratePerM > 0 ? `$${(s.ratePerM * 1000).toFixed(2)}/B` : '$—/B';
  const ratePerSkelly = s.price > 0 ? `$${s.price.toFixed(2)}/Skelly` : '$—/Skelly';
  
                        
  let statusText = 'Offline';
  const isOnline = services.mcBot && typeof services.mcBot.isOnline === 'function' && services.mcBot.isOnline();
  if (isOnline) {
    if (services.sellManager && services.sellManager.isBusy && services.sellManager.isBusy()) {
      statusText = 'Busy';
    } else {
      const delay = services.config && services.config.buy ? services.config.buy.joinDelayMs : 0;
      statusText = delay > 0 ? `Available (joins in ~${Math.round(delay/1000)}s)` : 'Available';
    }
  }

  return {
    balMoney: engine.render(templates.channels.balMoney, { usd, money }, 'title'),
    balSkelly: engine.render(templates.channels.balSkelly, { usd, skellys }, 'title'),
    rateMoney: engine.render(templates.channels.rateMoney, { ratePerB }, 'title'),
    rateSkelly: engine.render(templates.channels.rateSkelly, { ratePerSkelly }, 'title'),
    status: engine.render(templates.channels.status, { statusText }, 'title'),
  };
}

   
                                                                                  
                                                                                
                                                                      
   
function wantedChannels() {
  const { store } = services;
  const moneyOn = store.buyMoneyEnabled();
  const skellyOn = store.buySkellyEnabled();
  return CHANNELS.filter((c) => {
    if (c.key === 'balMoney' || c.key === 'rateMoney') return moneyOn;
    if (c.key === 'balSkelly' || c.key === 'rateSkelly') return skellyOn;
    if (c.key === 'status') return moneyOn || skellyOn;
    return true;
  });
}

                                                                                        
async function reconcile() {
  const { discordClient, config } = services;
  if (!discordClient) return;

  let guild;
  try {
    guild = await discordClient.guilds.fetch(config.discord.guildId);
    await guild.channels.fetch();
  } catch (err) {
                                          
    console.error('[stats-channels] could not fetch guild:', err.message);
    return;
  }

  const state = loadSaved();
  const wanted = wantedChannels();
  const wantedKeys = new Set(wanted.map((c) => c.key));

  let category = state.categoryId ? guild.channels.cache.get(state.categoryId) : null;
  if (!category && wanted.length) {
    try {
      category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
      state.categoryId = category.id;
    } catch (err) {
                                            
      console.error('[stats-channels] category create failed:', err.message);
      category = null;
    }
  }

                                                                                 
  const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }];

  for (const def of wanted) {
    let ch = state.channels[def.key] ? guild.channels.cache.get(state.channels[def.key]) : null;
    if (!ch) {
      try {
        ch = await guild.channels.create({
          name: def.initialName,
          type: ChannelType.GuildVoice,
          parent: category ? category.id : undefined,
          permissionOverwrites: overwrites,
        });
        state.channels[def.key] = ch.id;
      } catch (err) {
                                              
        console.error(`[stats-channels] create ${def.key} failed:`, err.message);
      }
    }
  }

                                                                                  
  for (const key of Object.keys(state.channels)) {
    if (wantedKeys.has(key)) continue;
    const ch = guild.channels.cache.get(state.channels[key]);
    if (ch) {
      try {
        await ch.delete('stats layout changed');
      } catch (err) {
                                              
        console.error(`[stats-channels] delete ${key} failed:`, err.message);
      }
    }
    delete state.channels[key];
  }

  save(state);
  services.statsChannels = state.channels;
}

                                                                                                
async function ensure() {
  await reconcile();
  await refresh().catch(() => {});
  if (!timer) {
    timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
    timer.unref?.();
  }
}

                                                                                     
async function sync(opts = {}) {
  await reconcile();
  await refresh(opts).catch(() => {});
}

                                                                                        
async function refresh(opts = {}) {
  const force = Boolean(opts.force);
  const { discordClient, statsChannels } = services;
  if (!discordClient || !statsChannels) return;

  let s;
  try {
    s = await panel.snapshot();
  } catch {
    return;                                                               
  }
  const names = buildNames(s);
  const active = new Set(wantedChannels().map((c) => c.key));

  for (const def of CHANNELS) {
    if (!active.has(def.key)) continue;
    const id = statsChannels[def.key];
    if (!id) continue;
    const ch = discordClient.channels.cache.get(id);
    if (!ch) continue;
    const wanted = names[def.key];
    if (ch.name === wanted) continue;                                          
    if (!force && Date.now() - (lastEditAt.get(id) || 0) < MIN_EDIT_INTERVAL_MS) continue;                       
    try {
      await ch.setName(wanted);
      lastEditAt.set(id, Date.now());
    } catch (err) {
                                            
      console.error(`[stats-channels] rename ${def.key} failed:`, err.message);
    }
  }
}

module.exports = { ensure, refresh, sync, CATEGORY_NAME };
