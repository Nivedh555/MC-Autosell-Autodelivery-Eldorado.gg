'use strict';

   
                                                                             
                                                                                 
  
                    
                                                            
                                                                                     
                                                                           
                                                                              
                                                                          
                                                                            
                                                                    
                                                                      
                                                                   
                                                                     
                                                                                 
                                                                          
                                                                                    
                                                   
                                                               
                                              
                                                             
                                                         
                                                                          
                                                 
                                                
                                                                                   
                                                                           
                                                                                
                                                                              
                                                       
                                                          
                                                                              
                                                                                 
   

const express = require('express');
const services = require('../services');
const { verifyAuth, requireReauth, loginRateLimit, recordLoginFailure, clearLoginFailure, asyncHandler, errorHandler, csrfProtection, hashPassword, isFirstRun, SESSIONS, CONFIRM_TOKENS, generateTotpSecret, verifyTotp } = require('./middleware');
const crypto = require('crypto');

const router = express.Router();
const LITOSHI = 1e8;

                                                             
async function tagOf(id) {
  try {
    const u = await services.discordClient.users.fetch(String(id));
    return u.tag;
  } catch {
    return null;
  }
}

                                                          
function configPayload(store) {
  return {
    pricePerSpawnerUsd: store.getPrice(),
    ratePerMillion: store.getRate(),
    ltcSendEnabled: store.sendEnabled(),
    buyMoneyEnabled: store.buyMoneyEnabled(),
    buySkellyEnabled: store.buySkellyEnabled(),
    minMoneyDonut: store.getMinMoney(),
    minSkellyCount: store.getMinSkelly(),
    sweepAutoMoney: store.getSweepAutoMoney(),
    sweepDelaySeconds: store.getSweepDelayMs() / 1000,
    sweep: store.getSweepConfig(),                                               
                                                                        
    buyerAccounts: store.getBuyerAccounts(),
    trustThresholdSales: store.getTrustThreshold(),
    trustedSystemEnabled: store.trustedSystemEnabled(),                               
    singleAccountIndex: store.getSingleAccountIndex(),                                                  
    verifyEnabled: store.verifyEnabled(),                                         
    autosellPaused: store.autosellPaused() || services.settings?.getSync?.('general.bot.paused') === true,
    lowBalanceUsd: store.getLowBalanceUsd(),                         
    restockUsd: store.getRestockUsd(),                           
    server: {
      host: (services.settings && typeof services.settings.getSync === 'function' ? services.settings.getSync('mc.server.host') : null) || services.config?.mc?.host || 'donutsmp.net',
      port: (services.settings && typeof services.settings.getSync === 'function' ? services.settings.getSync('mc.server.port') : null) || services.config?.mc?.port || 25565,
      version: (services.settings && typeof services.settings.getSync === 'function' ? services.settings.getSync('mc.server.version') : null) || '1.21.1'
    },
    eldorado: {
      baseUrl: (services.settings && typeof services.settings.getSync === 'function' ? services.settings.getSync('eldorado.api.baseUrl') : null) || null,
      executionMode: 'live',
      hasKey: Boolean(services.config?.eldorado?.apiKey || process.env.ELDORADO_API_KEY)
    }
  };
}

router.get('/health', asyncHandler(async (req, res) => res.json(services.ops ? await services.ops.health() : { status: 'monitor-unavailable' })));


                                                              
router.use(csrfProtection);
                     
router.use(verifyAuth);

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const { mcBot, buyer2Bot, wallet, store } = services;
    const s = mcBot.getStatus();
    const walletRead = await wallet.getReadStatus();
    const usd = walletRead.balanceUsd;
    res.json({
      success: true,
      bot: { online: s.online, state: s.state, host: s.host },
      buyer2Online: Boolean(buyer2Bot && buyer2Bot.isOnline && buyer2Bot.isOnline()),
      wallet: { enabled: wallet.enabled, address: wallet.address, sendEnabled: store.sendEnabled(), ...walletRead },
      pricing: { pricePerSpawnerUsd: store.getPrice(), ratePerMillion: store.getRate() },
      capacity: {
        skellys: usd != null && store.getPrice() > 0 ? Math.floor(usd / store.getPrice()) : null,
        donut: usd != null && store.getRate() > 0 ? (usd / store.getRate()) * 1e6 : null,
      },
    });
  })
);

router.get('/config', (req, res) => {
  res.json({ success: true, ...configPayload(services.store) });
});

router.post(
  '/config',
  asyncHandler(async (req, res) => {
    const { store } = services;
    if (!store) return res.status(503).json({ success: false, error: 'Settings store unavailable' });
    const b = req.body || {};
    if (b.eldorado) return res.status(409).json({ error: 'Configure Eldorado in Eldorado Setup.' });
    if (b.pricePerSpawnerUsd !== undefined && Number(b.pricePerSpawnerUsd) > 0) store.setPrice(Number(b.pricePerSpawnerUsd));
    if (b.ratePerMillion !== undefined && Number(b.ratePerMillion) > 0) store.setRate(Number(b.ratePerMillion));
    if (b.ltcSendEnabled !== undefined) store.setSetting('ltcSendEnabled', Boolean(b.ltcSendEnabled));
    if (b.buyMoneyEnabled !== undefined) store.setBuyMoneyEnabled(Boolean(b.buyMoneyEnabled));
    if (b.buySkellyEnabled !== undefined) store.setBuySkellyEnabled(Boolean(b.buySkellyEnabled));
    if (b.minMoneyDonut !== undefined) store.setMinMoney(Number(b.minMoneyDonut) || 0);
    if (b.minSkellyCount !== undefined) store.setMinSkelly(Number(b.minSkellyCount) || 0);
    if (b.sweepAutoMoney !== undefined) store.setSweepAutoMoney(Boolean(b.sweepAutoMoney));
    if (b.sweepDelaySeconds !== undefined) store.setSweepDelayMs(Math.round(Number(b.sweepDelaySeconds) * 1000) || 0);
    if (b.sweep && (Array.isArray(b.sweep.owners) || b.sweep.owner)) store.setSweepConfig(b.sweep);
    if (Array.isArray(b.buyerAccounts)) {
      b.buyerAccounts.slice(0, 2).forEach((a, i) => {
        store.setBuyerAccount(i, { email: a && a.email, ign: a && a.ign });
        if (services.pairManager && services.pairManager.repo) {
          const pair = services.pairManager.repo.getPairByIndex(i + 1);
          if (pair) {
            services.pairManager.savePair({
              ...pair,
              buyerIgn: (a && a.ign) || pair.buyerIgn,
              buyerEmail: (a && a.email) || pair.buyerEmail
            });
          }
        }
        if (services.config && services.config.mc) {
          if (i === 0) {
            if (a && a.email) services.config.mc.email = a.email;
            if (a && a.ign) services.config.mc.ign = a.ign;
          } else {
            if (a && a.email) services.config.mc.buyer2Email = a.email;
            if (a && a.ign) services.config.mc.buyer2Ign = a.ign;
          }
        }
      });
    }
    if (b.server) {
      if (b.server.host && services.config?.mc) services.config.mc.host = b.server.host;
      if (b.server.port && services.config?.mc) services.config.mc.port = Number(b.server.port);
      if (services.settings && typeof services.settings.set === 'function') {
        if (b.server.host) await services.settings.set('mc.server.host', b.server.host, 'dashboard').catch(() => {});
        if (b.server.port) await services.settings.set('mc.server.port', Number(b.server.port), 'dashboard').catch(() => {});
        if (b.server.version) await services.settings.set('mc.server.version', b.server.version, 'dashboard').catch(() => {});
      }
    }
    if (b.trustThresholdSales !== undefined) store.setTrustThreshold(b.trustThresholdSales);
    if (b.trustedSystemEnabled !== undefined) store.setTrustedSystemEnabled(Boolean(b.trustedSystemEnabled));
    if (b.singleAccountIndex !== undefined) store.setSingleAccountIndex(Number(b.singleAccountIndex));
    if (b.verifyEnabled !== undefined) store.setVerifyEnabled(Boolean(b.verifyEnabled));
    if (b.autosellPaused !== undefined) {
      if (typeof b.autosellPaused !== 'boolean') return res.status(400).json({ error: 'Autosell pause must be boolean' });
      await services.settings.set('general.bot.paused', b.autosellPaused, 'dashboard');
      store.setAutosellPaused(Boolean(b.autosellPaused));
      if (b.autosellPaused) {
        try { await services.listingManager?.pauseAll(); }
        catch (error) { services.events?.emit('operator:alert', { component: 'listing', reason: 'Autosell stopped locally; remote pause failed: ' + error.message }); }
      }
      if (!b.autosellPaused) { store.setSetting('lowAlerted', false); services.treasury?.requestBalanceRefresh(); }
    }
    if (b.lowBalanceUsd !== undefined) store.setLowBalanceUsd(Number(b.lowBalanceUsd));
    if (b.restockUsd !== undefined) store.setRestockUsd(Number(b.restockUsd));
    await require('../discord/panel').refresh().catch(() => {});
    await require('../discord/stats-channels').sync().catch(() => {});
    res.json({ success: true, ...configPayload(store) });
  })
);

                                                                             
router.post('/sweep/owner', (req, res) => {
  const { name, igns } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (igns !== undefined) patch.igns = Array.isArray(igns) ? igns : String(igns).split(/[\s,]+/).filter(Boolean);
  res.json({ success: true, sweep: services.store.setSweepOwner(patch) });
});

router.get(
  '/wallet',
  asyncHandler(async (req, res) => {
    const { wallet, store } = services;
    const walletRead = await wallet.getReadStatus();
    res.json({
      success: true,
      enabled: wallet.enabled,
      address: wallet.address,
      uri: wallet.depositUri(),                           
      sendEnabled: store.sendEnabled(),
      ...walletRead,
    });
  })
);

                                                                                              
router.post('/wallet/send', requireReauth, require('./owner-withdrawal'));
router.get('/wallet/withdrawals', (_req, res) => res.json({ success: true, withdrawals: services.db.raw().prepare('SELECT id,address,state,amount_litoshi,fee_litoshi,txid,reason,created_ms,updated_ms FROM wallet_withdrawals ORDER BY created_ms DESC LIMIT 100').all() }));


router.get('/orders', (req, res) => {
  const orders = services.store.getOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, orders: orders.slice(0, Number(req.query.limit) || 100) });
});

router.get('/sellers', (req, res) => {
  res.json({ success: true, sellers: services.store.getSellers() });
});

                                                                          
router.get('/pending-cashouts', (req, res) => {
  const pending = services.store.pendingCashouts();
  res.json({ success: true, count: pending.length, totalUsd: +pending.reduce((a, s) => a + s.balanceUsd, 0).toFixed(4), pending });
});

router.post('/sellers/unlink', (req, res) => {
  if (!req.body.discordId) return res.status(400).json({ success: false, error: 'discordId required' });
  const old = services.store.unlink(req.body.discordId);
  res.json({ success: true, message: old ? `Unlinked (was ${old})` : 'Nothing to unlink' });
});

router.post(
  '/sellers/cashout',
  asyncHandler(async (req, res) => {
    if (!req.body.discordId) return res.status(400).json({ success: false, error: 'discordId required' });
                                                                            
    const anon = typeof req.body.anon === 'boolean' ? req.body.anon : services.store.isAnon(req.body.discordId);
    const result = await require('../sell/payout').cashout(req.body.discordId, { anon });
    if (result.ok && result.txid) {
      require('../discord/payments')
        .postPaymentLog({ discordId: req.body.discordId, anon, ltc: result.ltc, usd: result.usd, txid: result.txid, pending: result.pending })
        .catch(() => {});
    }
    res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
  })
);

router.get('/logs', (req, res) => {
                                                                                    
  const since = req.query.since !== undefined ? Number(req.query.since) : null;
  const logs = since != null && Number.isFinite(since) ? services.logger.since(since) : services.logger.recent(Number(req.query.limit) || 50);
  res.json({ success: true, logs, latestSeq: services.logger.latestSeq() });
});

router.post('/logs/clear', (req, res) => {
  if (services.logger && typeof services.logger.clear === 'function') {
    services.logger.clear();
  }
  if (services.mcBot && typeof services.mcBot.clearChatHistory === 'function') services.mcBot.clearChatHistory();
  if (services.buyer2Bot && typeof services.buyer2Bot.clearChatHistory === 'function') services.buyer2Bot.clearChatHistory();
  res.json({ success: true, message: 'Logs cleared successfully' });
});

router.delete('/logs', (req, res) => {
  if (services.logger && typeof services.logger.clear === 'function') {
    services.logger.clear();
  }
  if (services.mcBot && typeof services.mcBot.clearChatHistory === 'function') services.mcBot.clearChatHistory();
  if (services.buyer2Bot && typeof services.buyer2Bot.clearChatHistory === 'function') services.buyer2Bot.clearChatHistory();
  res.json({ success: true, message: 'Logs deleted successfully' });
});

router.post('/sellers/clearbalance', (req, res) => {
  if (!req.body.discordId) return res.status(400).json({ success: false, error: 'discordId required' });
  const had = services.store.getBalanceUsd(req.body.discordId);
  services.store.zeroBalance(req.body.discordId);
  services.store.resetPending(req.body.discordId);
  res.json({ success: true, cleared: had });
});

router.post('/sellers/clearsettings', (req, res) => {
  if (!req.body.discordId) return res.status(400).json({ success: false, error: 'discordId required' });
  const had = services.store.clearSeller(req.body.discordId);
  res.json({ success: true, cleared: Boolean(had), was: had || null });
});

router.get('/stats', (req, res) => {
  const id = req.query.discordId;
  if (!id) return res.status(400).json({ success: false, error: 'discordId query param required' });
  res.json({ success: true, stats: services.store.getStats(id), rank: services.store.rankOf(id) });
});

router.get('/server-stats', (req, res) => {
  res.json({ success: true, ...services.store.serverStats() });
});

router.get('/leaderboard', (req, res) => {
  res.json({ success: true, leaderboard: services.store.leaderboard(Number(req.query.limit) || 10) });
});

router.post('/control/sweep-money', asyncHandler(async (req, res) => {
  const actions = require('../treasury/owner-actions');
  const { account = 'all', requestId, igns: rawIgns } = req.body || {};
  const custom = Array.isArray(rawIgns) ? rawIgns : typeof rawIgns === 'string' && rawIgns.trim() ? rawIgns.split(/[\s,]+/).filter(Boolean) : null;
  const recipients = custom?.length ? custom : services.store.getSweepConfig()?.owners?.[0]?.igns || [];
  const roles = await services.settings.get('treasury.accountRoles');
  const configured = services.pairManager?.getPairs().filter(pair => String(pair.buyerEmail || '').trim()).map(pair => require('../treasury/trading-controls').canonical(pair.buyerId));
  const accounts = account === 'all' ? (configured || Object.keys(roles || {}).filter(id => roles[id].role === 'intake')) : [require('../treasury/trading-controls').canonical(account)];
  if (!accounts.length) return res.status(400).json({ error: 'No buyer accounts are configured for this sweep.' });
  const result = await actions.once(requestId, { kind: 'money-sweep-batch', accounts, recipients }, async () => {
    const details = [];
    for (const id of accounts) {
      try { details.push(await actions.money(id, recipients, null, requestId)); }
      catch (error) { details.push({ account: id, success: false, amount: 0, reason: error.message }); }
    }
    const amount = details.reduce((total, item) => total + BigInt(item.amount || 0), 0n);
    const failed = details.filter(item => !item.success);
    return { success: !failed.length, amount: String(amount), details,
      message: 'Verified sweep: ' + amount.toLocaleString('en-US') + ' coins sent.',
      reason: failed.length ? failed.map(item => item.account + ': ' + item.reason).join(' | ') + (amount ? ' Verified coins already sent: ' + amount + '. Do not repeat those payments.' : '') : null };
  });
  return res.status(result.success ? 200 : 409).json({ ...result, error: result.success ? undefined : result.reason });
}));

                                                                           
router.post(
  '/control/holdings',
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true' || Boolean(req.body && req.body.force);
    const h = await require('../minecraft/sweep').reportHoldings(force);
    if (!h) return res.status(400).json({ success: false, error: 'Could not read holdings (bot offline?)' });
    res.json({ success: true, ...h });
  })
);

                                                                     
router.get(
  '/channels',
  asyncHandler(async (req, res) => {
    if (!services.discordClient || !services.discordClient.isReady?.() || !services.config?.discord?.guildId) {
      return res.json({ success: true, channels: [] });
    }
    try {
      const guild = await services.discordClient.guilds.fetch(services.config.discord.guildId);
      const all = await guild.channels.fetch();
      const list = [...all.values()]
        .filter((c) => c && (c.type === 0 || c.type === 5))                            
        .map((c) => ({ id: c.id, name: c.name, parent: c.parent ? c.parent.name : '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ success: true, channels: list });
    } catch {
      res.json({ success: true, channels: [] });
    }
  })
);

                                                         
router.post(
  '/control/dm',
  asyncHandler(async (req, res) => {
    const { userId, message } = req.body || {};
    if (!userId || !message || !String(message).trim()) return res.status(400).json({ success: false, error: 'userId and message required' });
    const u = await services.discordClient.users.fetch(String(userId)).catch(() => null);
    if (!u) return res.status(400).json({ success: false, error: 'User not found (bad ID, or not a shared member)' });
    try {
      await u.send(String(message).slice(0, 2000));
    } catch {
      return res.status(400).json({ success: false, error: 'Could not DM this user (their DMs are closed).' });
    }
    services.logger.info('Website DM sent', `To <@${userId}>: ${String(message).slice(0, 100)}`, undefined, 'system');
    res.json({ success: true });
  })
);

                                            
router.post(
  '/control/say', requireReauth,
  asyncHandler(async (req, res) => {
    const { channelId, message } = req.body || {};
    if (!channelId || !message || !String(message).trim()) return res.status(400).json({ success: false, error: 'channelId and message required' });
    const ch = await services.discordClient.channels.fetch(String(channelId)).catch(() => null);
    if (!ch || !ch.isTextBased()) return res.status(400).json({ success: false, error: 'Channel not found or not a text channel' });
    await ch.send({ content: String(message).slice(0, 2000), allowedMentions: { parse: ['users', 'roles', 'everyone'] } });
    services.logger.info('Website message sent', `To #${ch.name}: ${String(message).slice(0, 100)}`, undefined, 'system');
    res.json({ success: true });
  })
);

                                                                                             
router.post('/control/mc-command', asyncHandler(async (req, res) => {
  const { command, account } = req.body || {};
  if (!command || !String(command).trim()) return res.status(400).json({ success: false, error: 'command required' });
  const { client: botClient, id } = settingsClient(account ?? 1);
  const ownerActions = require('../treasury/owner-actions');
  const payment = ownerActions.payCommand(command);
  if (payment) {
    const result = await ownerActions.consolePay(id, payment, req.body.requestId);
    return res.status(result.success ? 200 : 409).json({ ...result, ran: command, response: result.success ? `Verified payment: ${result.amount.toLocaleString('en-US')} coins to ${payment.recipient}.` : result.reason, error: result.success ? undefined : result.reason });
  }
  if (!botClient || typeof botClient.isOnline !== 'function' || !botClient.isOnline()) {
    return res.status(400).json({ success: false, error: `Account ${id} is offline. Start it before sending a command.` });
  }
  const balanceRequest=require('../minecraft/verified-payments').balanceCommand(command);
  if (balanceRequest) {
    const db = services.db.raw();
    if (db.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(id) || db.prepare("SELECT id FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','NEEDS_OPERATOR')").get(id)) return res.status(409).json({ error: 'This account has an active or unresolved trade. Finish or review it before reading /bal.' });
    const pack = await services.settings.get('delivery.patternPack');
    if (!balanceRequest.target && (pack?.calibrated || pack?.balanceCalibrated)) {
      const result = await services.treasury.reconcile(id);
      if (!result.ok) return res.status(409).json({ error: result.reason, ...result });
      return res.json({ success: true, ran: '/bal', account: id, response: `Captured balance: ${result.balance} coins`, balance: result.balance });
    }
    const captured = await require('../minecraft/verified-payments').observeBalanceRecord(botClient,1500,balanceRequest.command);
    const connection = require('../minecraft/connection-record').connectionRecord(botClient.bot || botClient,id,botClient);
    return res.json({ success: true, ran: balanceRequest.command, account: id, target:balanceRequest.target, response: captured.lines.map(line=>line.raw).join('\n') || 'No server reply captured. Check the connection.', captured, connection, verified: false, note: balanceRequest.target?'Captured recipient-command output only; its format remains unverified until reviewed. This does not update holder stock or prove a payment.':'Captured command output only; review its exact format before using it to authorize trades.' });
  }

                                                               
  if (typeof botClient._recordChat === 'function') {
    botClient._recordChat(`> ${String(command).trim()}`, 'command');
  }

                                                                        
  const immediateReplies = [];
  const rawBot = botClient.bot || botClient;
  const onReply = (msg) => {
    const clean = String(msg).replace(/§./g, '').trim();
    if (clean) {
      immediateReplies.push(clean);
    }
  };
  if (rawBot && typeof rawBot.on === 'function') {
    rawBot.on('messagestr', onReply);
  }

  botClient.chat(String(command));

                                                                                              
  const startTime = Date.now();
  while (Date.now() - startTime < 600) {
    await new Promise(r => setTimeout(r, 35));
    if (immediateReplies.length > 0 && Date.now() - startTime >= 100) {
      break;
    }
  }

  if (rawBot && typeof rawBot.removeListener === 'function') {
    rawBot.removeListener('messagestr', onReply);
  }

  const responseText = immediateReplies.join('\n');

  res.json({ 
    success: true, 
    ran: String(command), 
    account: id,
    response: responseText || null 
  });
}));

                                                                          
router.post(
  '/control/bot/sync-enderchest',
  asyncHandler(async (req, res) => {
    const { account = 1 } = req.body || req.query || {};
    const isTwo = account === 2 || account === '2' || account === 'buyer2';
    const isThree = account === 3 || account === '3' || account === 'buyer3';
    const client = isThree ? services.buyer3Bot : (isTwo ? services.buyer2Bot : services.mcBot);

    if (!client || !client.isOnline()) {
      return res.status(400).json({ success: false, error: `Buyer account ${account} is offline. Please start the bot first.` });
    }

    const r = await client.syncAndDepositEnderChest(true);
    if (!r.success) {
      return res.status(400).json({ success: false, error: r.error || 'Failed to sync Ender Chest' });
    }

    res.json({
      success: true,
      message: r.depositedCount > 0 
        ? `Ender Chest synchronized! Safely deposited ${r.depositedCount}× Skeleton Spawner into Ender Chest.`
        : `Ender Chest synchronized! ${r.enderChest?.length || 0} slot(s) cached.`,
      ...r
    });
  })
);

                                                
router.get('/control/terminal-logs', (req, res) => {
  const rawAcc = req.query.account || '1';
  const accountId = String(rawAcc).startsWith('buyer') ? String(rawAcc) : `buyer${rawAcc}`;
  const account = parseInt(String(rawAcc).replace(/\D/g, ''), 10) || 1;
  const client = services.sessionManager?.getClient(accountId) || (account === 2 ? services.buyer2Bot : (account === 1 ? services.mcBot : null));
  const chat = (client && Array.isArray(client.chatHistory)) ? client.chatHistory.slice(-80) : [];
  const systemLogs = (services.logger && typeof services.logger.recent === 'function')
    ? services.logger.recent(40).map(l => ({
        time: l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '—',
        text: l.title ? `[${l.title}] ${l.message || ''}` : (l.message || ''),
        level: l.level || 'info',
        account
      }))
    : [];

  res.json({
    success: true,
    account,
    online: Boolean(client && client.isOnline && client.isOnline()),
    state: (client && client.state) || 'OFFLINE',
    chat,
    systemLogs
  });
});

router.post('/control/terminal-logs/clear', (req, res) => {
  const rawAcc = req.body?.account || req.query?.account || '1';
  const accountId = String(rawAcc).startsWith('buyer') ? String(rawAcc) : `buyer${rawAcc}`;
  const account = parseInt(String(rawAcc).replace(/\D/g, ''), 10) || 1;
  const client = services.sessionManager?.getClient(accountId) || (account === 2 ? services.buyer2Bot : (account === 1 ? services.mcBot : null));
  if (client && typeof client.clearChatHistory === 'function') {
    client.clearChatHistory();
  } else if (client) {
    client.chatHistory = [];
  }
  if (req.body?.clearSystem || req.body?.clearAll) {
    if (services.logger && typeof services.logger.clear === 'function') {
      services.logger.clear();
    }
  }
  res.json({ success: true, message: 'Terminal logs cleared successfully' });
});

router.delete('/control/terminal-logs', (req, res) => {
  const rawAcc = req.query?.account || req.body?.account || '1';
  const accountId = String(rawAcc).startsWith('buyer') ? String(rawAcc) : `buyer${rawAcc}`;
  const account = parseInt(String(rawAcc).replace(/\D/g, ''), 10) || 1;
  const client = services.sessionManager?.getClient(accountId) || (account === 2 ? services.buyer2Bot : (account === 1 ? services.mcBot : null));
  if (client && typeof client.clearChatHistory === 'function') {
    client.clearChatHistory();
  } else if (client) {
    client.chatHistory = [];
  }
  res.json({ success: true, message: 'Terminal logs deleted successfully' });
});

                                                                 
router.get('/control/bot/inventory', (req, res) => {
  const isTwo = req.query.account === '2' || Number(req.query.account) === 2 || req.query.account === 'buyer2';
  const isThree = req.query.account === '3' || Number(req.query.account) === 3 || req.query.account === 'buyer3';
  const { client } = settingsClient(req.query.account);
  if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
  const snapshot = typeof client.getInventorySnapshot === 'function' ? client.getInventorySnapshot() : {
    account: isThree ? 'buyer3' : (isTwo ? 'buyer2' : 'buyer1'),
    ign: 'Unknown',
    balance: 0,
    online: false,
    inventory: [],
    enderChest: [],
    enderChestLastUpdated: null
  };
  res.json({ success: true, ...snapshot });
});

                                                                   
router.post(
  '/control/bot/inventory/move',
  asyncHandler(async (req, res) => {
    const { account = 1, fromType, fromSlot, toType, toSlot, mode } = req.body || {};
    const { client } = settingsClient(account);

    if (!client || !client.isOnline()) {
      return res.status(400).json({ success: false, error: `Buyer account ${account} is offline. Please start the bot first.` });
    }

    if (typeof client.moveSlotItem !== 'function') {
      return res.status(500).json({ success: false, error: 'moveSlotItem is not supported on this account' });
    }

    const r = await client.moveSlotItem({ fromType, fromSlot, toType, toSlot, mode });
    if (!r.success) {
      return res.status(400).json({ success: false, error: r.error || 'Failed to move item' });
    }

    res.json(r);
  })
);

                                                                 
router.post(
  '/control/send-tpa',
  asyncHandler(async (req, res) => {
    const { username, account = 1 } = req.body || {};
    if (!username || !String(username).trim()) {
      return res.status(400).json({ success: false, error: 'Target username is required' });
    }
    const cleanUser = String(username).trim();
    const { client } = settingsClient(account);
    if (!client || !client.isOnline()) {
      return res.status(400).json({ success: false, error: `Account ${account} is offline. Please start the bot first.` });
    }
    
    client.chat(`/tpa ${cleanUser}`);
    const tp = require('../minecraft/tp');
    if (services.config?.collect?.tpaUsesGui && client.bot) {
      await tp.confirmTpaGui(client.bot, services.config.collect.tpaConfirmSlot || 0, 800).catch(() => {});
    }
    client._recordChat(`Sent /tpa to ${cleanUser}`, 'info');
    res.json({ success: true, message: `Sent teleport request to ${cleanUser}` });
  })
);

                                                                 
function settingsClient(account) {
  const id = require('../treasury/trading-controls').canonical(account);
  const pair = require('../treasury/trading-controls').pairFor(id);
  const registered = (services.sessions || services.sessionManager)?.clients?.get(id);
  const legacy = { buyer1: services.mcBot, buyer2: services.buyer2Bot, buyer3: services.buyer3Bot }[id];
  return { id, pair, client: registered || legacy || (pair ? (services.sessions || services.sessionManager)?.getClient(id) : null) };
}
router.get('/control/bot/settings', asyncHandler(async (req, res) => {
  const { client, id, pair } = settingsClient(req.query.account);
  if (!client) return res.status(404).json({ success: false, error: 'Bot client not found' });
  const choice = await require('../treasury/trading-controls').forwarding(id);
  const snapshot = services.db?.raw().prepare('SELECT balance,observed_ms,reason FROM balance_observations WHERE account_id=?').get(id)
    || services.db?.raw().prepare('SELECT balance,observed_ms FROM account_snapshots WHERE account_id=?').get(id);
  res.json({
    success: true,
    account: id,
    online: Boolean(client.isOnline?.()),
    telemetry: client.getTelemetry?.() || null,
    balance: snapshot ? { coins: snapshot.balance, capturedAt: snapshot.observed_ms, source: 'Captured /bal reply', reviewReason: snapshot.reason || null } : null,
    sendToHolder: choice.enabled, holderAvailable: Boolean(choice.destination), holderAccount: choice.destination,
    forwardingEditable: Boolean(pair && require('../treasury/trading-controls').canonical(pair.buyerId) === id),
    ign: typeof client.getDetectedIgn === 'function' ? client.getDetectedIgn() : (client.ign || 'Unknown'),
    autoReconnect: client.autoReconnect ?? true,
    antiAfk: client.antiAfkEnabled ?? true,
    autoTpAccept: client.autoTpAccept ?? false,
    proxy: client.proxy || { enabled: false, type: 'socks5', host: '', port: 1080, user: '', pass: '' }
  });
}));

router.post('/control/bot/settings', asyncHandler(async (req, res) => {
  const { account = 1, settings } = req.body || {};
  const { client, id, pair } = settingsClient(account);
  if (!client) return res.status(404).json({ success: false, error: 'Bot client not found' });
  if (settings) {
    if (settings.sendToHolder !== undefined) {
      if (typeof settings.sendToHolder !== 'boolean') return res.status(400).json({ error: 'sendToHolder must be boolean' });
      const controls = require('../treasury/trading-controls');
      if (!pair || controls.canonical(pair.buyerId) !== id) return res.status(409).json({ error: 'Forwarding is a paired intake account setting' });
      if (settings.sendToHolder && !controls.hasHolder(pair)) return res.status(409).json({ error: 'Configure a holder/seller account in this pair first. Buyer-only pairs skip forwarding.' });
      const preferences = await services.settings.get('treasury.forwarding') || {};
      preferences[id] = settings.sendToHolder;
      await services.settings.set('treasury.forwarding', preferences, 'dashboard');
    }
    if (typeof settings.autoReconnect === 'boolean') client.autoReconnect = settings.autoReconnect;
    if (typeof settings.antiAfk === 'boolean') {
      client.antiAfkEnabled = settings.antiAfk;
      if (client.antiAfk) {
        if (settings.antiAfk && client.isOnline()) client.antiAfk.start();
        else client.antiAfk.stop();
      }
    }
    if (typeof settings.autoTpAccept === 'boolean') client.autoTpAccept = settings.autoTpAccept;
    if (settings.proxy && typeof settings.proxy === 'object') {
      client.proxy = { ...client.proxy, ...settings.proxy };
    }
  }
  res.json({
    success: true,
    account: id,
    sendToHolder: (await require('../treasury/trading-controls').forwarding(id)).enabled,
    autoReconnect: client.autoReconnect,
    antiAfk: client.antiAfkEnabled,
    autoTpAccept: client.autoTpAccept,
    proxy: client.proxy
  });
}));
router.post('/control/bot/balance', asyncHandler(async (req, res) => {
  const { client, id } = settingsClient(req.body.account);
  if (!client?.isOnline?.()) return res.status(409).json({ error: 'Start the bot before reading its balance' });
  if (!services.treasury) return res.status(503).json({ error: 'Balance verifier unavailable' });
  let result;
  try { result = await services.treasury.reconcile(id); }
  catch (error) { return res.status(409).json({ error: `Could not read a fresh balance for ${id}. ${error.message} If the account is online, check the reviewed balance pattern and packet position in Eldorado Setup; never use a rounded or player-written value to authorize a trade.` }); }
  if (!result.ok) return res.status(409).json({ error: result.reason || 'Balance drift detected; operator reconciliation required', ...result });
  res.json({ success: true, coins: result.balance, capturedAt: Date.now() });
}));

                           
router.get('/control/bot/transactions', (req, res) => {
  const { client, id } = settingsClient(req.query.account);
  if (!client) return res.status(404).json({ success: false, error: 'Bot client not found' });
  res.json({
    success: true,
    account: id,
    ign: typeof client.getDetectedIgn === 'function' ? client.getDetectedIgn() : (client.ign || 'Unknown'),
    transactions: client.transactions || []
  });
});

router.post('/control/bot/transactions/clear', (req, res) => {
  const { account = 1 } = req.body || {};
  const { client } = settingsClient(account);
  if (!client) return res.status(404).json({ success: false, error: 'Bot client not found' });
  client.transactions = [];
  res.json({ success: true, message: 'Transactions cleared' });
});

                                                                 
router.get('/sales', (req, res) => {
  const sinceTs = req.query.sinceTs !== undefined ? Number(req.query.sinceTs) : 0;
  const limit = Number(req.query.limit) || 500;
  res.json({ success: true, sales: services.store.getSales({ limit, sinceTs }) });
});

                                                                                
router.get('/activity', (req, res) => {
  res.json({ success: true, activity: services.store.getActivity(Number(req.query.limit) || 300) });
});

                                                                              
router.get(
  '/user-data',
  asyncHandler(async (req, res) => {
    const { store } = services;
    const q = String(req.query.q || req.query.query || '').trim();
    if (q) {
      const discordId = store.resolveUserId(q);
      if (!discordId) return res.json({ success: true, found: false });
      const profile = store.getUserData(discordId);
      if (!profile) return res.json({ success: true, found: false });
      profile.tag = await tagOf(discordId);
      return res.json({ success: true, found: true, profile });
    }
    const users = store.listUserDataSummaries({
      search: req.query.search || '',
      limit: Number(req.query.limit) || 250,
    });
    res.json({ success: true, users, total: users.length });
  })
);

router.get(
  '/seller',
  asyncHandler(async (req, res) => {
  const q = String(req.query.query || req.query.discordId || '').trim();
  if (!q) return res.status(400).json({ success: false, error: 'query (discordId or IGN) required' });
  const discordId = services.store.resolveUserId(q);
  if (!discordId || !services.store.getSeller(discordId)) return res.json({ success: true, found: false });
  const orders = services.store
    .getOrders()
    .filter((o) => o.sellerDiscordId === discordId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 25);
  const sales = services.store.getSales({ limit: 3000 }).filter((s) => s.discordId === discordId).slice(0, 50);
  res.json({
    success: true,
    found: true,
    discordId,
    tag: await tagOf(discordId),
    seller: services.store.getSeller(discordId),
    stats: services.store.getStats(discordId),
    rank: services.store.rankOf(discordId),
    orders,
    sales,
  });
  })
);

                                                                                  
router.post('/control/announce', requireReauth, (req, res) => {
  const message = (req.body || {}).message;
  if (!message || !String(message).trim()) return res.status(400).json({ success: false, error: 'message required' });
  require('../discord/dm-announce')
    .broadcast(message)
    .catch((e) => services.logger && services.logger.error('Web DM announcement failed', e));
  res.status(202).json({ success: true, message: 'Announcement queued — DMing members in the background.' });
});

router.post('/control/sweep-skelly', asyncHandler(async (req, res) => {
  const { username, amount = 'all', account = 'buyer1', requestId } = req.body || {};
  const cleanAmount = String(amount).toLowerCase() === 'all' ? 'all' : /^\d+$/.test(String(amount)) ? Number(amount) : NaN;
  const result = await require('../treasury/spawner-sweep').sweep(account, String(username || '').trim(), cleanAmount, requestId);
  res.status(result.success ? 200 : 409).json({ ...result, error: result.success ? undefined : result.reason });
}));

router.get('/control/bot/status', (req,res)=>{
  const pairs=services.pairManager?.getPairs()||[];
  const sessions=services.sessions||services.sessionManager;
  const accounts=pairs.flatMap(pair=>['buyer','seller'].map(role=>{
    const id=require('../treasury/trading-controls').canonical(pair[role+'Id']);
    const client=sessions?.getClient(id);
    const configured=Boolean(services.gameBridge?.tokens.has(id)||pair[role+'Email']?.trim());
    const online=Boolean(client?.isOnline?.());
    const ign=configured?(client?.getDetectedIgn?.()||pair[role+'Ign']||'Not set'):'Not set';
    return {id,role,name:`${role==='buyer'?'Buyer':'Seller'} ${pair.pairIndex} (Pair #${pair.pairIndex})`,
      configured,online,state:client?.state||(online?'ONLINE':'OFFLINE'),host:client?.host||services.config?.mc?.host||'donutsmp.net',
      ign,email:pair[role+'Email']||'',msaCode:configured?client?.msaCode||null:null,
      telemetry:client?.getTelemetry?.()||null,pairIndex:pair.pairIndex,pairId:pair.id,
      note:role==='seller'?'Delivers Eldorado orders; buyer account is optional':'Receives purchases; configure forwarding separately'};
  }));
  res.json({success:true,botPaused:Boolean(services.store?.autosellPaused?.())||services.settings?.getSync?.('general.bot.paused')===true,accounts});
});

router.post(
  '/control/bot',
  asyncHandler(async (req, res) => {
    const rawAction = String((req.body || {}).action || '').toLowerCase();
    const action = rawAction === 'start' ? 'on' : rawAction === 'stop' ? 'off' : rawAction;
    const rawAccount = String((req.body || {}).account || 'all').toLowerCase();
    if(!['on','off','restart'].includes(action))return res.status(400).json({success:false,error:"action must be 'start'/'on', 'stop'/'off', or 'restart'"});
    const clients=new Map(services.sessions?.clients || []);
    for(const [id,client] of [['buyer1',services.mcBot],['buyer2',services.buyer2Bot],['buyer3',services.buyer3Bot]])if(client&&!clients.has(id))clients.set(id,client);
    const selected={primary:'buyer1',secondary:'buyer2',1:'buyer1',2:'buyer2',3:'buyer3'}[rawAccount] || rawAccount;
    const pairs=services.pairManager?.getPairs();
    const configured=pairs?.flatMap(pair=>['buyer','seller'].filter(role=>pair[role+'Email']?.trim()).map(role=>require('../treasury/trading-controls').canonical(pair[role+'Id'])));
    for(const id of configured||[])if(!clients.has(id))clients.set(id,(services.sessions||services.sessionManager).getClient(id));
    const targets=selected==='all'?[...clients].filter(([id])=>!configured||configured.includes(id)):clients.has(selected)?[[selected,clients.get(selected)]]:[];
    if(!targets.length)return res.status(404).json({success:false,error:'Configured Minecraft account not found'});
    const results=[];
    for(const [id,client] of targets){
      try{
        if(services.accountUpdates?.has(id))throw Error('Credentials are being saved. Wait for the save to finish.');
        const sessions = services.sessions || services.sessionManager;
        sessions?.setManualStop(id, true);
        if(action!=='on')await client.disconnect('Owner requested '+action+' from dashboard');
        if(action!=='off') { sessions?.setManualStop(id, false); await client.connect(); }
        const connected=Boolean(client.isOnline?.());
        if(action!=='off' && !connected && String(client.state).toLowerCase()==='offline')throw Error('Account stayed offline; check its Microsoft account configuration and console');
        results.push({id,success:true,connected,state:connected?'ONLINE':action==='off'?'STOP_REQUESTED':'CONNECTING',message:connected?'Connected':action==='off'?'Stop requested':'Connection requested; wait for the account status to become online'});
      }catch(error){services.events?.emit('operator:alert',{component:'minecraft',accountId:id,reason:error.message});results.push({id,success:false,connected:Boolean(client.isOnline?.()),error:error.message});}
    }
    const success=results.every(result=>result.success);
    res.status(success?200:502).json({success,action,account:rawAccount,accounts:results,...(!success?{error:'Minecraft connection failed: '+results.filter(result=>!result.success).map(result=>result.id+': '+result.error).join('; ')}:{})});
  })
);

router.post('/control/lockdown', asyncHandler(async (_req, res) => {
  const job = await require('../minecraft/lockdown').start();
  res.status(202).json({ success: true, ...job });
}));
router.get('/control/lockdown/status', (_req, res) => res.json(require('../minecraft/lockdown').status()));
router.post('/control/shutdown', requireReauth, (_req, res) => {
  if (!services.shutdown) return res.status(503).json({ success: false, error: 'Shutdown handler unavailable' });
  res.json({ success: true, message: 'Graceful shutdown requested' });
  setTimeout(() => services.shutdown('Owner dashboard request'), 100).unref();
});
router.get('/discord/panel-display', asyncHandler(async (_req, res) => {
  const snapshot = await require('../discord/panel').snapshot();
  res.json(require('../discord/panel-designs').computeDisplay(snapshot, services.store.buyMoneyEnabled(), services.store.buySkellyEnabled(), services.store.autosellPaused()));
}));

router.post(
  '/discord/post-panel',
  asyncHandler(async (req, res) => {
    const { channelId } = req.body || {};
    if (!channelId) return res.status(400).json({ success: false, error: 'channelId required' });
    if (!services.discordClient || !services.discordClient.isReady()) {
      return res.status(400).json({ success: false, error: 'Discord bot client is offline (verify DISCORD_TOKEN in .env)' });
    }
    const ch = await services.discordClient.channels.fetch(String(channelId)).catch(() => null);
    if (!ch || !ch.isTextBased()) return res.status(400).json({ success: false, error: 'Channel not found or not text-based' });

    const panelHelper = require('../discord/panel');
    const panelPayload = await panelHelper.buildPanel();
    const msg = await ch.send(panelPayload);
    services.store.setPanel(ch.id, msg.id);
    res.json({ success: true, messageId: msg.id, channelId: ch.id, message: `Autosell panel posted to #${ch.name}` });
  })
);

router.post(
  '/discord/custom-embed',
  asyncHandler(async (req, res) => {
    const { channelId, author, title, description, fields, footer, color, buttonLayout, withButtons } = req.body || {};
    if (!channelId) return res.status(400).json({ success: false, error: 'channelId required' });
    if (!services.discordClient || !services.discordClient.isReady()) {
      return res.status(400).json({ success: false, error: 'Discord bot client is offline (verify DISCORD_TOKEN in .env)' });
    }
    const ch = await services.discordClient.channels.fetch(String(channelId)).catch(() => null);
    if (!ch || !ch.isTextBased()) return res.status(400).json({ success: false, error: 'Channel not found or not text-based' });

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const panelHelper = require('../discord/panel');
    const snapshot = await panelHelper.snapshot();
    const display = require('../discord/panel-designs').computeDisplay(snapshot, services.store.buyMoneyEnabled(), services.store.buySkellyEnabled(), services.store.autosellPaused());
    const template = { author, title, description, fields, footer, color, buttonLayout };
    const embed = require('../discord/live-panel-template').render(template, display);

    const components = [];
    if (withButtons !== false) {
      const panelHelper = require('../discord/panel');
      if (buttonLayout === 'moneyAutosell' || buttonLayout === 'money') {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(panelHelper.IDS.SELL_MONEY).setLabel('Sell').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(panelHelper.IDS.BALANCE).setLabel('Balance').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(panelHelper.IDS.SETTINGS).setLabel('Settings').setStyle(ButtonStyle.Primary)
          )
        );
      } else {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(panelHelper.IDS.SELL_MONEY).setLabel('Sell Money').setStyle(ButtonStyle.Success).setEmoji('💰'),
            new ButtonBuilder().setCustomId(panelHelper.IDS.SELL_SKELLY).setLabel('Sell Skellys').setStyle(ButtonStyle.Primary).setEmoji('💀'),
            new ButtonBuilder().setCustomId(panelHelper.IDS.SETTINGS).setLabel('Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️')
          )
        );
      }
    }

    const msg = await ch.send({ embeds: [embed], components });
    if (withButtons !== false) {
      require('../discord/live-panel-template').save(template);
      services.store.setPanel(ch.id, msg.id);
    }

    res.json({ success: true, messageId: msg.id, channelId: ch.id, message: `Custom embed sent to #${ch.name}` });
  })
);

router.post(
  '/control/refresh',
  asyncHandler(async (req, res) => {
    await require('../discord/panel').refresh().catch(() => {});
    res.json({ success: true });
  })
);

module.exports = router;
