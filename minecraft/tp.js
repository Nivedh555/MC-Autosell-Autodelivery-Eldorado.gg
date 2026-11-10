'use strict';

   
                                                                          
                                                                               
                                                           
   

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

                                                                      
function itemLabel(it) {
  if (!it) return '';
  let label = it.displayName || it.name || '';
  if (it.customName) {
    try {
      const o = JSON.parse(it.customName);
      label = o.text || (Array.isArray(o.extra) ? o.extra.map((e) => e.text || '').join('') : label) || label;
    } catch {
      label = it.customName;
    }
  }
  return String(label).replace(/§./g, '').trim();
}

   
                                                                                 
                                                                                   
   
async function confirmTpaGui(bot, configuredSlot, delayMs) {
  let opened = null;
  const onOpen = (win) => {
    opened = win;
  };
  bot.once('windowOpen', onOpen);
  await sleep(delayMs);
  bot.removeListener('windowOpen', onOpen);

  const win = bot.currentWindow || opened;
  if (!win) return { clicked: false };

  const containerEnd = win.inventoryStart != null ? win.inventoryStart : Math.max(0, (win.slots?.length || 0) - 36);
  let autoSlot = -1;
  for (let i = 0; i < containerEnd; i++) {
    const it = win.slots[i];
    if (!it) continue;
    if (autoSlot === -1 && /\b(confirm|accept|yes)\b/i.test(itemLabel(it))) autoSlot = i;
  }
  const slot = autoSlot !== -1 ? autoSlot : configuredSlot;
  let clicked = true;
  try {
    await bot.clickWindow(slot, 0, 0);
  } catch {
    try {
      await bot.simpleClick.leftMouse(slot);
    } catch {
      clicked = false;
    }
  }
  await sleep(400);
  try {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  } catch {
                
  }
  return { clicked, slot };
}

   
                                                                             
                                                                                 
                                                                                
                                   
   
function waitForTeleport(mcBot, bot, timeoutMs = 45000, baseline) {
  const safeTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 45000;
  return new Promise((resolve, reject) => {
    const start = baseline || (bot.entity && bot.entity.position ? bot.entity.position.clone() : null);
    let settled = false;

    const checkMoved = () => {
      if (settled) return;
      const p = bot.entity && bot.entity.position;
      if (start && p && p.distanceTo(start) > 12) {
        finish(resolve, 'teleported');
      }
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (mcBot && typeof mcBot.off === 'function') {
        mcBot.off('chat:tpa-accepted', onAccept);
        mcBot.off('chat:tpa-denied', onReject);
        mcBot.off('chat:tpa-failed', onReject);
      }
      if (bot && typeof bot.removeListener === 'function') {
        bot.removeListener('forcedMove', checkMoved);
        bot.removeListener('move', checkMoved);
      }
      fn(arg);
    };

    const onAccept = () => finish(resolve, 'accepted');
    const onReject = (p) => finish(reject, new Error(typeof p === 'string' ? p : 'rejected'));

    const timer = setTimeout(() => {
      finish(reject, new Error('timeout'));
    }, safeTimeout);

                                                                       
    const poll = setInterval(checkMoved, 80);

    if (bot && typeof bot.on === 'function') {
      bot.on('forcedMove', checkMoved);
      bot.on('move', checkMoved);
    }
    if (mcBot && typeof mcBot.once === 'function') {
      mcBot.once('chat:tpa-accepted', onAccept);
      mcBot.once('chat:tpa-denied', onReject);
      mcBot.once('chat:tpa-failed', onReject);
    }
  });
}

                                                                                     
async function waitForEnderChestNearby(bot, radius, timeoutMs) {
  const enderChestId = bot.registry.blocksByName.ender_chest?.id;
  if (enderChestId === undefined) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const block = bot.findBlock({ matching: enderChestId, maxDistance: radius });
    if (block) return block;
    await sleep(1500);
  }
  return null;
}

module.exports = { sleep, itemLabel, confirmTpaGui, waitForTeleport, waitForEnderChestNearby };
