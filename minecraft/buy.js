'use strict';

   
                               
  
                                                             
                                                                             
                                                                                  
                                                                      
  
                                                                                
   

const services = require('../services');
const tp = require('./tp');
const stock = require('./stock');
const spawner = require('./spawner');
const { goals } = require('mineflayer-pathfinder');

function post(order, msg) {
  return require('../discord/seller-status').live(order.id, msg);
}
function note(order, msg) {
  return require('../discord/seller-status').post(order.id, msg);
}

   
                                                               
                                                                       
   
async function collect(order) {
  if (services.mcBot?.bot?.transport === 'fabric') return require('../v3/collect').collect(order);
  const { mcBot, logger, config } = services;
  const MinecraftBot = require('./bot');
  const bot = mcBot.bot;
  if (!bot || !mcBot.isOnline()) return { success: false, reason: 'The buyer bot is offline right now — please try again shortly.' };

  const target = order.sellerUsername;
  mcBot.setState(MinecraftBot.STATE.RESTOCKING);

                                                                                
                                                               
  let aborted = null;                          
  let itemsMayHaveMoved = false;
  const onDeath = () => {
    aborted = aborted || 'death';
  };
  const onEnd = () => {
    aborted = aborted || 'disconnect';
  };
  mcBot.once('death', onDeath);
  mcBot.once('end', onEnd);
  const checkAbort = () => {
    if(mcBot.bot!==bot)aborted ||= 'disconnect';
    if (aborted) throw new Error('ABORT');
  };

  try {
    await logger.minecraft('Buy started', `Order \`${order.id}\` → buying up to **${order.requested}** spawners from ||${target}||.`, undefined, 'sales');

                                               
    await mcBot.goHome();
    await tp.sleep(1500);
    checkAbort();
                                                                           
    if (spawner.countWanted(bot).count > 0) {
      const secured = await mcBot.syncAndDepositEnderChest(false);
      if (!secured?.success || spawner.countWanted(bot).count > 0) return { success:false,reason:'Stored spawners remain in inventory. The owner must secure existing stock before this sale; do not drop anything.' };
    }
    if(bot.inventory.items().length)return {success:false,reason:'The buyer is carrying items from before this sale. The owner must store them before collection can start; do not drop anything.'};
    mcBot.setState(MinecraftBot.STATE.RESTOCKING);

    await post(order, `📨 Sending a teleport request to \`${target}\` — please **accept it**.`);
                                                                                 
                                                                                
    const homePos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    const teleportResult = tp
      .waitForTeleport(mcBot, bot, config.collect.tpaTimeoutMs, homePos)
      .then(() => null, (err) => err);                                     

    mcBot.chat(`/tpa ${target}`);
    if (config.collect.tpaUsesGui) {
      await tp.confirmTpaGui(bot, config.collect.tpaConfirmSlot, config.collect.tpaGuiDelayMs);
    }
    const tpErr = await teleportResult;
    if (tpErr) {
      checkAbort();
      await safeHome(mcBot);
      return { success: false, reason: tpErr.message === 'timeout' ? 'You didn’t accept the teleport in time. Click **Sell Skellys** to try again.' : 'The teleport was denied/failed. Click **Sell Skellys** to try again.' };
    }
    await tp.sleep(2500);
    checkAbort();

                                                   
    await post(order, '✅ Teleported! Please **place an ender chest within a few blocks** of me, in a clear open spot.');
    const chest = await tp.waitForEnderChestNearby(bot, config.collect.enderChestSearchRadius, config.collect.enderChestPlaceTimeoutMs);
    checkAbort();
    if (!chest) {
      await safeHome(mcBot);
      return { success: false, reason: 'No ender chest was placed in time. Place one near me next time and click **Sell Skellys** again.' };
    }

                                                                                 
                                     
    await post(order, '📦 Ender chest detected! **Drop your skeleton spawners on the ground** right next to me — I’ll grab them and finish the moment you’re done.');
    itemsMayHaveMoved = true;
    await collectGroundItems(bot, MinecraftBot, config.collect.collectMs, config.collect.collectRadius, () => aborted);
    checkAbort();

                                                                                  
                                                                        
    const { count, types } = spawner.countWanted(bot);

    if (count === 0) {
                                                                            
                                                            
      const seen = spawner.spawnerLikeDebug(bot);
      if (seen.length) {
        await logger.warn('Spawners not matched', `Order \`${order.id}\` — saw spawner items that didn't match "${config.buy.match}":\n${seen.join('\n').slice(0, 1500)}`, undefined, 'errors');
      }
      await returnOthers(bot);
      await safeHome(mcBot);
      return {
        success: false,
        reason: seen.length
          ? `I picked up spawners but none were **${config.buy.match}** spawners — I only buy ${config.buy.match} spawners. I dropped them back for you.`
          : 'I didn’t detect any skeleton spawners in what you dropped. Make sure you drop them right next to me, then try again.',
      };
    }

    const vsPlanned =
      count === order.requested ? '' : count > order.requested ? ` (more than the ~${order.requested} you said — paying for all ${count})` : ` (you said ~${order.requested})`;
    await post(order, `🔎 Counted **${count}** skeleton spawner(s)${vsPlanned}. Storing them…`);

                                                                                   
                                                                               
    try {
      const fresh = bot.blockAt(chest.position) || chest;
      const container = await stock.openChest(bot, fresh);
      for (const t of types) {
        try {
          await container.deposit(t.type, null, t.count);
          await tp.sleep(300);
        } catch {
                                                                
        }
      }
      container.close();
    } catch (err) {
      await logger.warn('Could not deposit at seller', err.message, undefined, 'errors');
                                                                              
    }

    checkAbort();
    await returnOthers(bot);
    await safeHome(mcBot);
    await tp.sleep(1000);
    checkAbort();
    try {
      await stock.depositInventory();
    } catch {
                       
    }

    checkAbort();
    if (spawner.countWanted(bot).count !== 0) throw Error('Spawner custody was not secured; payout stopped');
    await logger.success('Spawners collected', `Order \`${order.id}\`: bought **${count}** skeleton spawner(s) from ||${target}||.`, undefined, 'sales');
    checkAbort();
    return { success: true, count };
  } catch (err) {
    if (err.message === 'ABORT' || aborted) {
      await logger.warn('Buy interrupted', `Order \`${order.id}\` interrupted (${aborted}).`, undefined, 'errors');
      await safeHome(mcBot);
      return {
        success: false,
        needsReview: itemsMayHaveMoved,
        reason:
          itemsMayHaveMoved ? 'Collection was interrupted after the drop window opened. Do not drop more items or start another sale. The owner must check inventory, storage and any dropped items before settling this order.' : aborted === 'death'
            ? '💀 I **died** during your sale — your spawners are still on the ground where you dropped them. Please grab them back and start a new sell. Nothing was charged.'
            : '🔌 I **lost connection** during your sale — your spawners are safe on the ground. Please grab them and try again once I’m back online.',
      };
    }
    await logger.error('Buy flow error', err, { order: order.id });
    await safeHome(mcBot);
    return { success: false, needsReview:itemsMayHaveMoved, reason: itemsMayHaveMoved ? 'Collection was interrupted after items may have moved. Do not drop more; the owner must reconcile this order before another sale.' : `Collection could not start (${err.message}). Do not drop items.` };
  } finally {
    mcBot.off('death', onDeath);
    mcBot.off('end', onEnd);
    if (mcBot.state === MinecraftBot.STATE.RESTOCKING) mcBot.setState(MinecraftBot.STATE.IDLE);
  }
}

                                                                    
async function safeHome(mcBot) {
  try {
    await require('./sweep').goHomeRobust(mcBot);
  } catch {
                
  }
}

                                                                                       
async function returnOthers(bot) {
  const others = spawner.otherItems(bot);
  if (!others.length) return;
  try {
    const yaw = bot.entity ? bot.entity.yaw : 0;
    await bot.look(yaw, 0.2, true);
  } catch {
                     
  }
  for (const o of others) {
    try {
      await bot.toss(o.type, null, o.count);
      await tp.sleep(250);
    } catch {
                  
    }
  }
}

                                                                                         
function isItemEntity(e) {
  return Boolean(e) && (e.name === 'item' || e.displayName === 'Item');
}

                                                                     
function nearestDroppedItem(bot, radius) {
  if (!bot.entity || !bot.entity.position) return null;
  const me = bot.entity.position;
  let best = null;
  let bestDist = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || !e.position) continue;
    if (!isItemEntity(e)) continue;
    const d = e.position.distanceTo(me);
    if (d <= radius && d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

   
                                                                              
                                                                             
                                                                             
                                                                         
   
async function collectGroundItems(bot, MinecraftBot, windowMs, radius, isAborted) {
  const SETTLE_MS = 3500;                                                     
  const deadline = Date.now() + windowMs;

  let lastCount = spawner.countWanted(bot).count;
  let lastChange = Date.now();
  let everPicked = lastCount > 0;

  while (Date.now() < deadline) {
    if (isAborted && isAborted()) return;

    const item = nearestDroppedItem(bot, radius);
    if (item) {
      try {
        if (goals && goals.GoalNear) {
          await stock.gotoWithTimeout(bot, new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1), 8000);
        }
      } catch {
                                            
      }
      await tp.sleep(350);
    } else {
      await tp.sleep(600);
    }

    const count = spawner.countWanted(bot).count;
    if (count > lastCount) {
      lastCount = count;
      lastChange = Date.now();
      everPicked = true;
    }

                                                                                   
                                                  
    const nothingOnGround = !nearestDroppedItem(bot, radius);
    if (everPicked && nothingOnGround && Date.now() - lastChange >= SETTLE_MS) return;
  }
}

module.exports = { collect };
