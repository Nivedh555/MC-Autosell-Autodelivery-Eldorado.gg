'use strict';

   
                              
  
                                                                              
                                                                                
                                                   
                                                                          
                                                                              
  
                                                                                   
                                                                              
                                                                            
                                                                                 
                                                                                
                                                                  
   

const services = require('../services');

                                                                                    
                                                             
const NAME_KEYS = new Set(['name', 'custom_name', 'minecraft:custom_name']);

   
                                                                                 
                                                                                   
                                                                                    
                                                                   
   
function collectTrusted(node, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (typeof node !== 'object') return;                                   
  if (Array.isArray(node)) {
    for (const v of node) collectTrusted(v, out);
    return;
  }
                                                                                 
  if (typeof node.type === 'string' && NAME_KEYS.has(node.type.toLowerCase())) return;
  for (const [k, v] of Object.entries(node)) {
    if (NAME_KEYS.has(k.toLowerCase())) continue;                                
    collectTrusted(v, out);
  }
}

   
                                                                                  
                                                                                  
                                                 
   
function trustedText(item) {
  if (!item) return '';
  const parts = [item.name];
  try {
    const lore = item.customLore;                                               
    if (Array.isArray(lore)) parts.push(...lore);
    else if (lore) parts.push(String(lore));
  } catch {
                
  }
  try {
    if (item.nbt) collectTrusted(item.nbt, parts);
  } catch {
                
  }
  try {
    if (item.components) collectTrusted(item.components, parts);
  } catch {
                
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

   
                                                                                
                                                                                  
                
   
function itemText(item) {
  const parts = [item.name, item.displayName, item.customName];
  try {
    if (item.nbt) parts.push(JSON.stringify(item.nbt));
  } catch {
                
  }
  try {
    if (item.components) parts.push(JSON.stringify(item.components));
  } catch {
                
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

                                                                                          
function isSpawnerItem(item) {
  if (!item) return false;
  const targetName = services.config?.buy?.itemName || 'spawner';
  return item.name === targetName || item.name === 'spawner';
}

                                                                                             
function isWantedSpawner(item) {
  if (!item) return false;
  // Do not trust a precomputed flag or a player-editable display name.
  if (!isSpawnerItem(item)) return false;
  const matchKeyword = (services.config?.buy?.match || 'skeleton').toLowerCase();
  // Mineflayer flattens older NBT differently from protocol data components.
  const unbox = value => value && typeof value === 'object' && 'type' in value && 'value' in value ? value.value : value;
  const at = (node, keys) => keys.reduce((value,key)=>unbox(value)?.[key], node);
  const components = Array.isArray(item.components) ? item.components : [];
  const tags = [at(item.nbt,['BlockEntityTag']),item.nbt,...components.filter(c=>['block_entity_data','minecraft:block_entity_data'].includes(c.type)).map(c=>c.data?.nbt??c.data)];
  return tags.some(tag=>unbox(at(tag,['SpawnData','entity','id']))==='minecraft:'+matchKeyword);
}

   
                                                                              
                                                                                    
                                                                                   
                                                          
   
function spawnerLikeDebug(bot) {
  return bot.inventory
    .items()
    .filter((it) => it && (isSpawnerItem(it) || itemText(it).includes('spawner')))
    .map((it) => `${it.count}× ${it.name} | type-data: "${trustedText(it).slice(0, 120)}" | shown-as: "${itemText(it).slice(0, 80)}"`);
}

   
                                                              
                                                                
   
function countWanted(bot) {
  let count = 0;
  const byType = new Map();
  for (const it of bot.inventory.items()) {
    if (!isWantedSpawner(it)) continue;
    count += it.count;
    byType.set(it.type, (byType.get(it.type) || 0) + it.count);
  }
  return { count, types: [...byType.entries()].map(([type, c]) => ({ type, count: c })) };
}

                                                                                
function otherItems(bot) {
  const byType = new Map();
  for (const it of bot.inventory.items()) {
    if (isWantedSpawner(it)) continue;
    byType.set(it.type, (byType.get(it.type) || 0) + it.count);
  }
  return [...byType.entries()].map(([type, count]) => ({ type, count }));
}

module.exports = { isWantedSpawner, isSpawnerItem, countWanted, otherItems, itemText, trustedText, spawnerLikeDebug };
