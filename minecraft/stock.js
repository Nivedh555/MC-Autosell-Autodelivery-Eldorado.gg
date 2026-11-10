'use strict';

   
                                                                        
                                                                                       
                                                    
   

const services = require('../services');
const verifiedEnderChests = new WeakSet();
const trackedEnderChests = new WeakSet();
function isVerifiedEnderChest(window) { return Boolean(window && verifiedEnderChests.has(window)); }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

                                                                       
async function gotoWithTimeout(bot, goal, ms = 15000) {
  let timer;
  try { return await Promise.race([
    Promise.resolve().then(() => bot.pathfinder.goto(goal)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          bot.pathfinder.stop();
        } catch {
                      
        }
        reject(new Error('pathfinding timed out'));
      }, ms);
    }),
  ]); } finally { clearTimeout(timer); }
}

const { Vec3 } = require('vec3');

                                                                                      
async function tryOpenEnderChestViaCommand(bot, timeoutMs = 2000) {
  if (!bot || typeof bot.chat !== 'function') return null;
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.removeListener('windowOpen', onWin);
    };
    const onWin = (win) => {
      const title = typeof win?.title === 'string' ? win.title : JSON.stringify(win?.title || '');
      if (!/ender.?chest/i.test(title)) return;
      verifiedEnderChests.add(win);
      cleanup();
      resolve(win);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    bot.on('windowOpen', onWin);
    try {
      bot.chat('/ec');
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

                                                                                                          
function getVisibleFace(bot, block) {
  const eye = bot.entity && bot.entity.position ? bot.entity.position.offset(0, 1.6, 0) : block.position.offset(0, 2, 0);
  const pos = block.position;
  const dx = eye.x - (pos.x + 0.5);
  const dy = eye.y - (pos.y + 0.5);
  const dz = eye.z - (pos.z + 0.5);

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const absZ = Math.abs(dz);

                                                   
  if (dy > 0 && absY >= absX && absY >= absZ) {
    return {
      dir: new Vec3(0, 1, 0),
      target: pos.offset(0.5, 1.0, 0.5),
      cursor: new Vec3(0.5, 0.9, 0.5)
    };
  }
                                   
  if (absX >= absZ) {
    return dx > 0
      ? { dir: new Vec3(1, 0, 0), target: pos.offset(1.0, 0.5, 0.5), cursor: new Vec3(0.9, 0.5, 0.5) }
      : { dir: new Vec3(-1, 0, 0), target: pos.offset(0.0, 0.5, 0.5), cursor: new Vec3(0.1, 0.5, 0.5) };
  } else {
    return dz > 0
      ? { dir: new Vec3(0, 0, 1), target: pos.offset(0.5, 0.5, 1.0), cursor: new Vec3(0.5, 0.5, 0.9) }
      : { dir: new Vec3(0, 0, -1), target: pos.offset(0.5, 0.5, 0.0), cursor: new Vec3(0.5, 0.5, 0.1) };
  }
}

                                                                     
async function openContainerWithTimeout(bot, block, dir, cursor, timeoutMs = 6000) {
  let timer;
  try { return await Promise.race([
    bot.openContainer(block, dir, cursor),
    new Promise((_, reject) =>
      { timer = setTimeout(() => reject(new Error(`Server did not respond to opening container at (${block.position.x}, ${block.position.y}, ${block.position.z}) within ${timeoutMs / 1000}s`)), timeoutMs); }
    )
  ]); } finally { clearTimeout(timer); }
}

                                                               
async function openChest(bot, block) {
  const { goals } = require('mineflayer-pathfinder');
  const pos = block.position;

                                                                 
  const blockAbove = bot.blockAt(pos.offset(0, 1, 0));
  if (blockAbove && blockAbove.boundingBox === 'block') {
    throw new Error(`Ender Chest at (${pos.x}, ${pos.y}, ${pos.z}) has a solid block ("${blockAbove.name}") directly above it. Please remove the block above the chest.`);
  }

  const attempt = async (dist) => {
                                                                
    const distToChest = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(pos) : 99;
    if (distToChest > dist + 0.8) {
      try {
        if (goals && goals.GoalNear) {
          await gotoWithTimeout(bot, new goals.GoalNear(pos.x, pos.y, pos.z, dist), 6000);
        }
      } catch {
                                     
      }
      await sleep(150);
    }

                                                              
    try { bot.setControlState('sneak', false); } catch {}
    try {
                                                                   
      const emptySlot = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(s => !bot.inventory.slots[bot.inventory.hotbarStart + s]);
      if (emptySlot !== undefined) {
        bot.setQuickBarSlot(emptySlot);
        await sleep(50);
      } else if (bot.heldItem) {
        bot.setQuickBarSlot(0);
        await sleep(50);
      }
    } catch {}

    const face = getVisibleFace(bot, block);
    try {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
    } catch {}
    await sleep(100);

                                                          
    try {
      return await openContainerWithTimeout(bot, block, face.dir, face.cursor, 4000);
    } catch {
      return await openContainerWithTimeout(bot, block, undefined, undefined, 4000);
    }
  };

  try {
    return await attempt(2);
  } catch (err1) {
    try {
      return await attempt(1);
    } catch (err2) {
      throw err2.message ? err2 : err1;
    }
  }
}

                                                                                         
async function openNearbyEnderChest(bot) {
                                                                                          
  if (isVerifiedEnderChest(bot.currentWindow)) {
    _cacheEnderChest(bot, bot.currentWindow);
    return bot.currentWindow;
  }

                                                           
  if (bot.currentWindow) {
    try { bot.currentWindow.close(); } catch {}
    await sleep(150);
  }

  const enderChestId = bot.registry.blocksByName.ender_chest?.id;
  if (enderChestId === undefined) throw new Error('ender_chest block id not found for this version');

                                                                   
  let blockPositions = bot.findBlocks({ matching: enderChestId, maxDistance: 32, count: 12 });
  if (!blockPositions || blockPositions.length === 0) {
                                                                                                       
    await sleep(400);
    blockPositions = bot.findBlocks({ matching: enderChestId, maxDistance: 32, count: 12 });
  }

  if (blockPositions && blockPositions.length > 0) {
                              
    const botPos = bot.entity?.position;
    if (botPos) {
      blockPositions.sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos));
    }

                                               
    let chosenBlock = null;
    let obstructedBlock = null;
    for (const p of blockPositions) {
      const b = bot.blockAt(p);
      if (!b) continue;
      const above = bot.blockAt(p.offset(0, 1, 0));
      if (!above || above.boundingBox !== 'block') {
        chosenBlock = b;
        break;
      } else {
        obstructedBlock = b;
      }
    }

    if (!chosenBlock && obstructedBlock) {
      const above = bot.blockAt(obstructedBlock.position.offset(0, 1, 0));
      throw new Error(`Ender Chest at (${obstructedBlock.position.x}, ${obstructedBlock.position.y}, ${obstructedBlock.position.z}) has a solid block ("${above ? above.name : 'block'}") directly above it preventing it from opening.`);
    }

    const targetBlock = chosenBlock || bot.blockAt(blockPositions[0]);
    const chest = await openChest(bot, targetBlock);
    if (chest) { verifiedEnderChests.add(chest); _cacheEnderChest(bot, chest); }
    return chest;
  }

                                                                                        
  const cmdWin = await tryOpenEnderChestViaCommand(bot, 1500);
  if (cmdWin) {
    _cacheEnderChest(bot, cmdWin);
    return cmdWin;
  }

  throw new Error('No Ender Chest found nearby within 32 blocks at /home 1');
}

function _cacheEnderChest(bot, container) {
  try {
    if (isVerifiedEnderChest(container) && typeof container.containerItems === 'function') {
      if(!trackedEnderChests.has(container)&&typeof container.on==='function'&&typeof bot.on==='function'){
        trackedEnderChests.add(container);
        const update=()=>_cacheEnderChest(bot,container);
        const close=window=>{if(window===container)cleanup();};
        const cleanup=()=>{
          container.removeListener('updateSlot',update);container.removeListener('close',cleanup);
          bot.removeListener('windowClose',close);bot.removeListener('end',cleanup);
          trackedEnderChests.delete(container);
        };
        container.on('updateSlot',update);container.once('close',cleanup);
        bot.on('windowClose',close);bot.once('end',cleanup);
      }
      const items = container.containerItems().map(it => {
        const rawName = String(it.name || '').toLowerCase();
        const dispName = String(it.displayName || it.name || '').toLowerCase();
        const custName = String(it.customName || '').toLowerCase();
        const isSpawner = rawName.includes('spawner') || dispName.includes('spawner') || custName.includes('spawner');

        return {
          slot: it.slot,
          type: it.type,
          name: it.name,
          displayName: it.displayName || it.name,
          count: it.count,
          customName: it.customName || null,
          customLore: it.customLore || null,
          stackSize: it.stackSize || 64,
          isSpawner
        };
      });

      const now = new Date().toLocaleTimeString();
      bot.latestEnderChest = items;
      bot.enderChestLastUpdated = now;
      if (bot._clientRef) {
        bot._clientRef.latestEnderChest = items;
        bot._clientRef.enderChestLastUpdated = now;
      }
      services.events?.emit?.('mc:enderchest_cached', { 
        account: bot._clientRef?.accountId || 'buyer1', 
        items,
        timestamp: now 
      });
    }
  } catch {}
}

                                                                                     
async function depositInventory() {
  const { mcBot, logger } = services;
  const bot = mcBot.bot;
  if (!bot || !mcBot.isOnline()) return;
  const items = bot.inventory.items();
  if (items.length === 0) return;

  const byType = new Map();
  for (const it of items) {
    const e = byType.get(it.type);
    if (e) e.count += it.count;
    else byType.set(it.type, { type: it.type, name: it.displayName || it.name, count: it.count });
  }
  try {
    const container = await openNearbyEnderChest(bot);
    const deposited = [];
    for (const e of byType.values()) {
      try {
        await container.deposit(e.type, null, e.count);
        deposited.push(`${e.count}× ${e.name}`);
        await sleep(300);
      } catch {
                       
      }
    }
    container.close();
    if (deposited.length) await logger.minecraft('Leftover inventory stored', deposited.join(', '));
  } catch (err) {
    await logger.warn('Could not deposit leftover inventory', err.message);
  }
}

module.exports = { openNearbyEnderChest, openChest, gotoWithTimeout, depositInventory, sleep, _cacheEnderChest, isVerifiedEnderChest };
