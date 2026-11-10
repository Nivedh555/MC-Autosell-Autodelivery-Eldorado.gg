'use strict';

   
                                                                    
                                         
                                          
                                                        
                                                                           
   

const services = require('../services');
const tp = require('./tp');
const stock = require('./stock');
const spawner = require('./spawner');
const { parseDonutAmount } = require('../sell/money-format');
const treasuryRouter = require('../treasury/treasury-router');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function botLabel(bot) {
  return (bot && bot.username) || 'account';
}

async function goHomeRobust(mcBot, attempts = 3) {
  const bot = mcBot.bot || mcBot;
  if (!bot) return false;
  let rawCmd = '/home 1';
  try {
    if (services.settings && typeof services.settings.getSync === 'function') {
      const v = services.settings.getSync('mc.home.command');
      if (v) rawCmd = v;
    }
  } catch {}
  if (!rawCmd && services.config?.mc?.homeCommand) rawCmd = services.config.mc.homeCommand;
  if (!rawCmd || !String(rawCmd).trim()) rawCmd = '/home 1';
  const homeCmd = String(rawCmd).trim().startsWith('/') ? String(rawCmd).trim() : `/home ${String(rawCmd).trim()}`;

                                                                         
  const enderChestId = bot.registry?.blocksByName?.ender_chest?.id;
  if (enderChestId !== undefined) {
    const nearbyEc = bot.findBlocks({ matching: enderChestId, maxDistance: 16, count: 1 });
    if (nearbyEc && nearbyEc.length > 0) {
      return true;                           
    }
  }

  for (let i = 0; i < attempts; i++) {
    let failed = false;
    let teleportLanded = false;
    const onMsg = (m) => {
      const t = String(m).toLowerCase();
      if (/combat|can.?t teleport|cannot teleport|please wait|cooldown|you moved|teleport.*cancel|home.*(?:does not|doesn't|not).*exist|home.*not found/.test(t)) failed = true;
      if (/welcome home|teleported (?:to|home)/.test(t)) teleportLanded = true;
    };
    bot.on('messagestr', onMsg);
    const startPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    try {
      if (mcBot.chat) mcBot.chat(homeCmd);
      else bot.chat(homeCmd);
    } catch {
                  
    }

                                                                
    const startT = Date.now();
    while (Date.now() - startT < 3800) {
      await sleep(100);
      if (failed || (mcBot.bot && mcBot.bot !== bot)) { failed = true; break; }
      const curr = bot.entity && bot.entity.position;
      if (startPos && curr && curr.distanceTo(startPos) > 4) {
        teleportLanded = true;
        break;
      }
      if (enderChestId !== undefined) {
        const found = bot.findBlocks({ matching: enderChestId, maxDistance: 16, count: 1 });
        if (found && found.length > 0) {
          teleportLanded = true;
          break;
        }
      }
    }

    bot.removeListener('messagestr', onMsg);
    if (!failed && teleportLanded) {
                                                                   
      await sleep(350);
      return true;
    }
    if (services.logger) await services.logger.warn('Home blocked — retrying', `\`${homeCmd}\` was blocked (attempt ${i + 1}/${attempts}); waiting then retrying.`, undefined, 'system');
    if (i + 1 < attempts) await sleep(2000);
  }
  return false;
}

function readBalance(mcBot, timeoutMs = 6000) {
  const bot = mcBot.bot || mcBot;
  if (!bot) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bot.removeListener('messagestr', onMsg);
    };
    const onMsg = (m) => {
      const text = String(m);
      const mm = text.match(/you\s+have[^$\d-]*\$?\s*([\d,.]+\s*[kmbt]?)/i) || text.match(/\$\s*([\d,.]+\s*[kmbt]?)/i);
      if (!mm) return;
      const amt = parseDonutAmount(mm[1].replace(/\s+/g, '').replace(/[.,]+$/, ''));
      if (!Number.isNaN(amt)) {
        cleanup();
        resolve(amt);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    bot.on('messagestr', onMsg);
    if (mcBot.chat) mcBot.chat('/bal');
    else bot.chat('/bal');
  });
}

function normalizeAccountId(acc) {
  if (!acc) return 'buyer1';
  const s = String(acc).trim().toLowerCase();
  if (s === '3' || s === 'buyer3' || s === 'account3' || s === 'account 3' || s === 'buyer_3') return 'buyer3';
  if (s === '2' || s === 'buyer2' || s === 'secondary' || s === 'account2' || s === 'account 2' || s === 'buyer_2') return 'buyer2';
  const canonical = require('../treasury/trading-controls').canonical(s);
  if (/^(buyer|seller)[1-9]\d*$/.test(canonical)) return canonical;
  throw Error('Choose a configured account; the sweep was not started.');
}

function getAccountLabel(acc) {
  const norm = normalizeAccountId(acc);
  if (norm === 'buyer3') return 'Buyer 3 (Pair #3)';
  if (norm === 'buyer2') return 'Buyer 2 (Pair #2)';
  return 'Buyer 1 (Pair #1)';
}

function getSessionManager() {
  return services.sessionManager || services.sessions || require('./session-manager');
}

async function countStoredSpawners(bot, clientRef = null) {
  let invCount = 0;
  if (bot && bot.inventory && typeof bot.inventory.items === 'function') {
    for (const it of bot.inventory.items()) {
      const isSkelly = it.isSpawner || spawner.isWantedSpawner(it) || 
        (it.name && it.name.includes('spawner')) || 
        (it.displayName && String(it.displayName).toLowerCase().includes('spawner'));
      if (isSkelly) invCount += (it.count || 0);
    }
  }

  let ecCount = 0;
                                                                
  const cachedEc = (clientRef && clientRef.latestEnderChest) || (bot && bot.latestEnderChest) || (bot && bot._clientRef && bot._clientRef.latestEnderChest);
  if (Array.isArray(cachedEc) && cachedEc.length > 0) {
    for (const it of cachedEc) {
      const isSkelly = it.isSpawner || spawner.isWantedSpawner(it) || 
        (it.name && it.name.includes('spawner')) || 
        (it.displayName && String(it.displayName).toLowerCase().includes('spawner')) ||
        (it.customName && String(it.customName).toLowerCase().includes('spawner'));
      if (isSkelly) ecCount += (it.count || 0);
    }
    return { total: invCount + ecCount, inv: invCount, ec: ecCount, cached: true };
  }

                                                                                  
  if (bot && typeof bot.openBlock === 'function') {
    try {
      const c = await stock.openNearbyEnderChest(bot);
      if (c) {
        if (typeof c.containerItems === 'function') {
          for (const it of c.containerItems()) {
            if (spawner.isWantedSpawner(it)) ecCount += (it.count || 0);
          }
        }
        try { c.close(); } catch {}
      }
    } catch {
                                                                           
    }
  }
  return { total: invCount + ecCount, inv: invCount, ec: ecCount, cached: false };
}

let holdingsCache = {
  spawners: 0,
  money: 0,
  buyer1Money: 0,
  buyer2Money: 0,
  buyer3Money: 0,
  buyer1Skellys: 0,
  buyer1Inv: 0,
  buyer1Ec: 0,
  buyer2Skellys: 0,
  buyer2Inv: 0,
  buyer2Ec: 0,
  buyer3Skellys: 0,
  buyer3Inv: 0,
  buyer3Ec: 0,
  skellys: 0,
  totalMoney: 0,
  totalSkellys: 0,
  buyer1: { money: 0, skellys: 0, skellysInv: 0, skellysEc: 0, online: false },
  buyer2: { money: 0, skellys: 0, skellysInv: 0, skellysEc: 0, online: false },
  buyer3: { money: 0, skellys: 0, skellysInv: 0, skellysEc: 0, online: false },
  lastScanned: 0
};

async function scanAccount(accountId, sessionManager) {
  let money = 0;
  let skellyInfo = { total: 0, inv: 0, ec: 0 };
  let online = false;

                                                             
  let directClient = null;
  if (accountId === 'buyer1') directClient = services.mcBot;
  else if (accountId === 'buyer2') directClient = services.buyer2Bot;
  else if (accountId === 'buyer3') directClient = services.buyer3Bot || (sessionManager && sessionManager.clients && sessionManager.clients.get('buyer3'));

  if (directClient && directClient.isOnline && directClient.isOnline()) {
    online = true;
    money = directClient.balance || 0;
    const bot = directClient.bot || directClient;
    skellyInfo = await countStoredSpawners(bot, directClient);
    return { accountId, money, skellyInfo, online };
  }

                                                                      
  if (sessionManager) {
    try {
      const lease = await sessionManager.acquire(accountId, 'report_holdings');
      try {
        await lease.ready(1200);                       
        const mcBot = lease.getBot();
        const bot = mcBot.bot || mcBot;
        online = true;
        skellyInfo = await countStoredSpawners(bot, mcBot);
        const m = await readBalance(mcBot, 1200);
        if (m != null) money = m;
      } finally {
        lease.release();
      }
    } catch {
                                 
    }
  }

  return { accountId, money, skellyInfo, online };
}

async function reportHoldings(force = false) {
  const { logger, store } = services;
  const sessionManager = getSessionManager();

                                                              
  if (!force && holdingsCache.lastScanned > 0 && (Date.now() - holdingsCache.lastScanned < 30000)) {
    if (store) {
      const exp = store.getExpectedSpawners();
      if (exp > 0 && holdingsCache.totalSkellys === 0) {
        holdingsCache.spawners = exp;
        holdingsCache.skellys = exp;
        holdingsCache.totalSkellys = exp;
      }
    }
    return { ...holdingsCache };
  }

                                                                    
  const results = await Promise.allSettled([
    scanAccount('buyer1', sessionManager),
    scanAccount('buyer2', sessionManager),
    scanAccount('buyer3', sessionManager)
  ]);

  const b1 = results[0].status === 'fulfilled' ? results[0].value : { money: holdingsCache.buyer1Money, skellyInfo: { total: holdingsCache.buyer1Skellys, inv: holdingsCache.buyer1Inv, ec: holdingsCache.buyer1Ec }, online: false };
  const b2 = results[1].status === 'fulfilled' ? results[1].value : { money: holdingsCache.buyer2Money, skellyInfo: { total: holdingsCache.buyer2Skellys, inv: holdingsCache.buyer2Inv, ec: holdingsCache.buyer2Ec }, online: false };
  const b3 = results[2].status === 'fulfilled' ? results[2].value : { money: holdingsCache.buyer3Money, skellyInfo: { total: holdingsCache.buyer3Skellys, inv: holdingsCache.buyer3Inv, ec: holdingsCache.buyer3Ec }, online: false };

  const totalMoney = (b1.money || 0) + (b2.money || 0) + (b3.money || 0);
  let totalSkellys = (b1.skellyInfo.total || 0) + (b2.skellyInfo.total || 0) + (b3.skellyInfo.total || 0);

  const expected = store ? store.getExpectedSpawners() : 0;
  if (totalSkellys === 0 && expected > 0) totalSkellys = expected;

  holdingsCache = {
    spawners: totalSkellys,
    money: totalMoney,
    buyer1Money: b1.money || 0,
    buyer2Money: b2.money || 0,
    buyer3Money: b3.money || 0,
    buyer1Skellys: b1.skellyInfo.total || 0,
    buyer1Inv: b1.skellyInfo.inv || 0,
    buyer1Ec: b1.skellyInfo.ec || 0,
    buyer2Skellys: b2.skellyInfo.total || 0,
    buyer2Inv: b2.skellyInfo.inv || 0,
    buyer2Ec: b2.skellyInfo.ec || 0,
    buyer3Skellys: b3.skellyInfo.total || 0,
    buyer3Inv: b3.skellyInfo.inv || 0,
    buyer3Ec: b3.skellyInfo.ec || 0,
    skellys: totalSkellys,
    totalMoney,
    totalSkellys,
    buyer1: {
      money: b1.money || 0,
      skellys: b1.skellyInfo.total || 0,
      skellysInv: b1.skellyInfo.inv || 0,
      skellysEc: b1.skellyInfo.ec || 0,
      online: b1.online
    },
    buyer2: {
      money: b2.money || 0,
      skellys: b2.skellyInfo.total || 0,
      skellysInv: b2.skellyInfo.inv || 0,
      skellysEc: b2.skellyInfo.ec || 0,
      online: b2.online
    },
    buyer3: {
      money: b3.money || 0,
      skellys: b3.skellyInfo.total || 0,
      skellysInv: b3.skellyInfo.inv || 0,
      skellysEc: b3.skellyInfo.ec || 0,
      online: b3.online
    },
    lastScanned: Date.now()
  };

  if (logger && force) {
    await logger.info(
      '📦 Holdings update',
      `**Skellies stored:** ${totalSkellys}\n**In-game money:** $${totalMoney.toLocaleString('en-US')} (A1: $${(b1.money||0).toLocaleString()}, A2: $${(b2.money||0).toLocaleString()}, A3: $${(b3.money||0).toLocaleString()})`,
      undefined,
      'sales'
    );
  }
  return { ...holdingsCache };
}

async function sweepSkelly(adminUsername, amountOrAll, accountId = 'buyer1', journal = {}) {
  const { logger, store, config, sellManager } = services;
  const sessionManager = getSessionManager();
  const targetAccount = normalizeAccountId(accountId);
  const accountLabel = getAccountLabel(targetAccount);
  
  if (sellManager && sellManager.activeId) return { success: false, reason: 'Bot is mid-sale — try again in a moment' };
  const wantAll = String(amountOrAll).toLowerCase() === 'all';
  const amount = wantAll ? Infinity : parseInt(amountOrAll, 10);
  if (!wantAll && (!Number.isInteger(amount) || amount <= 0)) return { success: false, reason: 'Amount must be a positive number or "all"' };
  let intakeTicket;
  try { intakeTicket = require('../sell/intake-admission').acquire('owner-spawner-sweep'); }
  catch (error) { return {success:false,reason:error.message}; }

  const wasPaused = sellManager?.paused;
  if (sellManager) sellManager.pause(); 
  
  let lease;
  try {
    lease = await sessionManager.acquire(targetAccount, 'sweep_skelly', { ttlMs: 300000 });
    await lease.ready(15000);
    const mcBot = lease.getBot();
    const bot = mcBot.bot || mcBot;

                                                                                  
    const getInvSpawners = () => {
      const items = (bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : [];
      return items.filter((it) => it && spawner.isWantedSpawner(it));
    };

    let currentInvCount = getInvSpawners().reduce((sum, it) => sum + (it.count || 0), 0);
    const picks = [];                                                                       

                                                                   
    const neededFromChest = wantAll ? Infinity : Math.max(0, amount - currentInvCount);

    if (neededFromChest > 0) {
                                                                 
      await goHomeRobust(mcBot, 2);
      await sleep(300);

      let c = null;
      let chestErr = null;
      try {
        c = await stock.openNearbyEnderChest(bot);
      } catch (err) {
        chestErr = err;
      }

      if (c) {
        let remainingToTake = neededFromChest;
        const containerItems = typeof c.containerItems === 'function' ? c.containerItems() : [];
        for (const it of containerItems) {
          if (!spawner.isWantedSpawner(it)) continue;
          const take = remainingToTake === Infinity ? it.count : Math.min(it.count, remainingToTake);
          if (take > 0) {
            picks.push({ type: it.type, count: take });
            if (remainingToTake !== Infinity) remainingToTake -= take;
          }
          if (remainingToTake <= 0) break;
        }

        for (const p of picks) {
          try {
            await c.withdraw(p.type, null, p.count);
            await sleep(90);                           
          } catch {            }
        }
        try { c.close(); } catch {}
      } else if (currentInvCount === 0) {
                                                                       
        await goHomeRobust(mcBot, 2);
        return { 
          success: false, 
          reason: `Could not open Ender Chest for ${accountLabel}: ${chestErr ? chestErr.message : 'no chest nearby'}` 
        };
      } else {
                                                                                                
        if (logger) {
          await logger.warn(
            'Ender chest unavailable',
            `Could not open Ender Chest for ${accountLabel} (${chestErr ? chestErr.message : 'no chest nearby'}), proceeding with ${currentInvCount} skeleton spawner(s) already in player inventory.`,
            undefined,
            'sales'
          );
        }
      }
    }

    const availableSpawners = getInvSpawners();
    const totalAvailable = availableSpawners.reduce((sum, it) => sum + (it.count || 0), 0);
    const totalToDeliver = wantAll ? totalAvailable : Math.min(totalAvailable, amount);

    if (totalToDeliver === 0) {
      await goHomeRobust(mcBot, 2);
      return { 
        success: false, 
        reason: `No skeleton spawners found in Ender Chest of ${accountLabel}` 
      };
    }

    const homePos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    const tpRes = tp.waitForTeleport(mcBot, bot, config.collect.tpaTimeoutMs || 45000, homePos).then(() => null, (e) => e);
    bot.chat(`/tpa ${adminUsername}`);
    if (config.collect.tpaUsesGui) await tp.confirmTpaGui(bot, config.collect.tpaConfirmSlot, 800);
    
    const err = await tpRes;
    if (err) {
                                                      
      await goHomeRobust(mcBot, 2);
      await sleep(250);

                                                                             
      try {
        const c2 = await stock.openNearbyEnderChest(bot);
        if (c2) {
          const invSpawners = getInvSpawners();
          for (const it of invSpawners) {
            try { 
              await c2.deposit(it.type, it.metadata || null, it.count); 
              await sleep(60);
            } catch {              }
          }
          try { c2.close(); } catch {}
        }
      } catch (depErr) {
        if (logger) await logger.warn('Sweep abort: failed to deposit to Ender Chest', depErr.message, undefined, 'sales');
      }

                                               
      await goHomeRobust(mcBot, 2);

      return { 
        success: false, 
        reason: 'The admin did not accept the teleport, or it failed. No spawners were dropped. Check this bot’s inventory and Ender Chest before starting another sweep.'
      };
    }
    
                                                                              
    await sleep(350);
    try {
      const yaw = bot.entity ? bot.entity.yaw : 0;
      await bot.look(yaw, 0.2, true);
    } catch {              }
    
    let tossed = 0;
    let remainingToToss = totalToDeliver;
    for (const it of getInvSpawners()) {
      if (remainingToToss <= 0) break;
      const count = Math.min(it.count || 0, remainingToToss);
      if (count > 0) {
        try {
          journal.beforeToss?.(count);
          await bot.toss(it.type, it.metadata || null, count);
          journal.afterToss?.(count);
          tossed += count;
          remainingToToss -= count;
          await sleep(80);                               
        } catch (error) { throw Error('Spawner drop interrupted; inspect the captured inventory/drop record before retrying. ' + error.message); }
      }
    }

    if (store && tossed > 0) store.addExpectedSpawners(-tossed);
    holdingsCache.spawners = Math.max(0, holdingsCache.spawners - tossed);
    holdingsCache.skellys = holdingsCache.spawners;
    holdingsCache.lastScanned = Date.now();

    await goHomeRobust(mcBot, 2);
    if (logger) {
      try { await logger.success('DonutFlip · Spawner sweep', `Dropped **${tossed}** skeleton spawner(s) from **${accountLabel}** for \`${adminUsername}\`. Check the pickup in-game.`, undefined, 'sales'); } catch {}
    }
                                                                                
    return { success: tossed > 0, withdrawn: tossed, partial: !wantAll && tossed < amount, account: targetAccount };
  } catch (e) {
    const isConnErr = /offline|timeout|connect|missing/i.test(e.message);
    const msg = isConnErr 
      ? `${accountLabel} is offline or could not connect to Minecraft server. Please start the bot first.`
      : (e.message || 'Sweep execution error');
    return { success: false, reason: msg };
  } finally {
    if (lease) lease.release();
    intakeTicket.release();
    if (sellManager && !wasPaused) sellManager.resume();
  }
}

function splitAmount(total, n) {
  const base = Math.floor(total / n);
  const shares = new Array(n).fill(base);
  shares[n - 1] = total - base * (n - 1);
  return shares;
}

function buildSweepPlan(total) {
  if (!services.store) return [];
  const owner = services.store.getSweepConfig().owners[0];
  if (!owner || !owner.igns.length) return [];
  const shares = splitAmount(total, owner.igns.length);
  const plan = [];
  owner.igns.forEach((ign, j) => {
    if (shares[j] >= 1) plan.push({ ign, amount: shares[j], owner: owner.name });
  });
  return plan;
}

async function payOne() { throw new Error('Legacy payments disabled: use the persisted verified transfer engine'); }
async function sweepMoney(account, igns, requestId) { return require('../treasury/owner-actions').sweepMoney(account, igns, requestId); }
async function autoSweepMoney() { return { success: false, reason: 'Legacy sweeps disabled; treasury uses verified transfers' }; }
module.exports = { goHomeRobust, readBalance, reportHoldings, sweepSkelly, sweepMoney, autoSweepMoney, payOne };
