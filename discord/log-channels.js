'use strict';

   
                                                                          
                                                                      
                                                                              
                                                                              
   

const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');
const { buildLogPermissions } = require('./log-permissions');

const services = require('../services');

const STORE_FILE = require('../ops/runtime-paths').data('log-channels.json');
const CATEGORY_NAME = '🌸 AUTOBUY LOGS';

const CHANNELS = [
  { key: 'system', discordName: 'system-logs', topic: 'Startup, connections, and general system events.' },
  { key: 'sales', discordName: 'sale-logs', topic: 'Money + skelly sells credited to balances.' },
  { key: 'cashouts', discordName: 'cashout-logs', topic: 'LTC cashouts sent to sellers.' },
  { key: 'verify', discordName: 'verify-logs', topic: 'One-time account linking / verification.' },
  { key: 'errors', discordName: 'error-logs', topic: 'Errors, crashes, and failed payouts.' },
  { key: 'activity', discordName: 'sell-activity', topic: 'Every Sell-button click + amount prompt (even if they never complete).' },
                                                                          
  { key: 'payments', discordName: 'payments', topic: '💸 Live feed of completed Litecoin payouts.', public: true },
];
const pending = new WeakMap();

function loadSaved(file = STORE_FILE) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { categoryId: p.categoryId || null, channels: p.channels && typeof p.channels === 'object' ? p.channels : {} };
  } catch {
    return { categoryId: null, channels: {} };
  }
}
function save(state, file = STORE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
                                          
    console.error('[log-channels] persist failed:', err.message);
  }
}

async function ensure({ storeFile = STORE_FILE, services: local = services } = {}) {
  if(pending.has(local))return pending.get(local);
  const work=ensureChannels(local,storeFile);pending.set(local,work);
  try{return await work;}finally{if(pending.get(local)===work)pending.delete(local);}
}
async function ensureChannels(local,storeFile) {
  const { discordClient, config } = local;
  if (!discordClient || !config?.discord?.guildId) return {};

  let guild;
  try {
    guild = await discordClient.guilds.fetch(config.discord.guildId);
    await guild.channels.fetch();
  } catch (err) {
                                          
    console.error('[log-channels] could not fetch guild:', err.message);
    return;
  }

  const { privateOverwrites, publicOverwrites } = await buildLogPermissions(guild, discordClient, config.discord.adminRoleId, undefined, config.discord.ownerId);
  const state = loadSaved(storeFile);
  let category = state.categoryId ? guild.channels.cache.get(state.categoryId) : null;
  if(category?.type!==ChannelType.GuildCategory)category=null;
  if(!category)category=[...guild.channels.cache.values()].find(ch=>ch?.type===ChannelType.GuildCategory&&ch.name===CATEGORY_NAME);
  if (!category) {
    try {
      category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: privateOverwrites });
      state.categoryId = category.id;
    } catch (err) {
                                            
      console.error('[log-channels] category create failed:', err.message);
      category = null;
    }
  }
  if(category)state.categoryId=category.id;

  const resolved = {};
  for (const def of CHANNELS) {
    let ch = state.channels[def.key] ? guild.channels.cache.get(state.channels[def.key]) : null;
    if(ch?.type!==ChannelType.GuildText)ch=null;
    if(!ch){
      const named=[...guild.channels.cache.values()].filter(value=>value?.type===ChannelType.GuildText&&value.name===def.discordName);
      const inCategory=named.filter(value=>value.parentId===category?.id);
      if(inCategory.length===1)ch=inCategory[0];
      else if(named.length===1)ch=named[0];
      else if(named.length){console.error(`[log-channels] Multiple #${def.discordName} channels found; select the intended channel before logging there.`);continue;}
    }
    if(ch){
                                                                               
      try{await ch.permissionOverwrites.set(def.public?publicOverwrites:privateOverwrites);}
      catch{console.error(`[log-channels] Cannot secure #${def.discordName}. Grant Manage Channels to the bot; no operator alerts will be posted there.`);continue;}
    }
    if (!ch) {
      try {
        ch = await guild.channels.create({
          name: def.discordName,
          type: ChannelType.GuildText,
                                                                           
                                      
          parent: def.public ? undefined : category ? category.id : undefined,
          topic: def.topic,
          permissionOverwrites: def.public ? publicOverwrites : privateOverwrites,
        });
        state.channels[def.key] = ch.id;
      } catch (err) {
                                              
        console.error(`[log-channels] create #${def.discordName} failed:`, err.message);
        ch = null;
      }
    }
    if (ch) {state.channels[def.key]=ch.id;resolved[def.key] = ch.id;}
  }

  save(state, storeFile);
  local.logChannels = resolved;
  return resolved;
}

module.exports = { ensure, CHANNELS, CATEGORY_NAME };
