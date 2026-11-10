'use strict';

const EventEmitter = require('events');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const services = require('../services');
const AntiAfk = require('./anti-afk');
const {
  neutralizeChatAck,
  enableSocketKeepAlive,
  isStaleSessionKick,
  isRecoverableNetworkError,
  safeQuit,
  quitAndWait,
  formatMcReason,
} = require('./connection-utils');
const { notifyOwnerMcDisconnect, clearAlertDedup } = require('../discord/mc-alerts');
const chatMonitor = require('./chat-monitor');

const STATE = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  STOPPING: 'stopping',
  BACKOFF: 'backoff',
  IDLE: 'idle',
  DELIVERING: 'delivering',
  STOCKING: 'stocking',
  RESTOCKING: 'restocking',
  DEAD: 'dead',
});

function syncWindowInventory(bot, window) {
  if (!bot || !window || window.inventoryStart === undefined) return;
  const invStart = bot.inventory?.inventoryStart !== undefined ? bot.inventory.inventoryStart : 9;
  const slotOffset = window.inventoryStart - invStart;
  for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
    const sourceItem = window.slots ? window.slots[i] : null;
    const item = sourceItem ? Object.assign(Object.create(Object.getPrototypeOf(sourceItem)), sourceItem) : null;
    const targetSlot = i - slotOffset;
    if (item) {
      item.slot = targetSlot;
    }
    if (bot.inventory && typeof bot.inventory.updateSlot === 'function') {
      bot.inventory.updateSlot(targetSlot, item);
    } else if (bot.inventory && bot.inventory.slots) {
      bot.inventory.slots[targetSlot] = item;
    }
  }
}

class AccountClient extends EventEmitter {
  constructor(accountId) {
    super();
    this.accountId = accountId;                           
    this.bot = null;
    this.state = STATE.OFFLINE;

    this._shouldRun = false;
    this._reconnectTimer = null;
    this._disconnectPromise = null;
    this._connectPromise = null;
    this._reconnectNotBefore = 0;
    
    this._hosts = [];
    this._hostIndex = 0;
    this._longReconnect = false;
    this._connectingSince = 0;
    this._watchdog = null;
    
                                   
    this._consecutiveFailures = 0;
    
                       
    this.antiAfk = new AntiAfk(this);
    
                         
    this.role = accountId === 'buyer1' ? 'primary' : 'secondary';
    this.chatHistory = [];
    this.ign = null;

                                    
    this.latestEnderChest = [];
    this.enderChestLastUpdated = null;
    this.transactions = [];
    this.autoReconnect = true;
    this.antiAfkEnabled = true;
    this.autoTpAccept = false;
    this.proxy = { enabled: false, type: 'socks5', host: '', port: 1080, user: '', pass: '' };
    this.balance = 0;
  }

  recordTransaction(tx) {
    const entry = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: tx.type || 'sent',                       
      user: tx.user || tx.recipient || tx.sender || 'Unknown',
      amount: tx.amount || 0,
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now(),
      status: 'SUCCESS'
    };
    if (!this.transactions) this.transactions = [];
    this.transactions.unshift(entry);
    if (this.transactions.length > 100) this.transactions.pop();
    return entry;
  }

  getInventorySnapshot() {
    if (this.bot && this.bot.currentWindow && this.bot.currentWindow.inventoryStart !== undefined) {
      syncWindowInventory(this.bot, this.bot.currentWindow);
    }
    const items = [];
    if (this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function') {
      for (const it of this.bot.inventory.items()) {
        items.push({
          slot: it.slot,
          type: it.type,
          name: it.name,
          displayName: it.displayName || it.name,
          count: it.count,
          customName: it.customName || null,
          stackSize: it.stackSize || 64
        });
      }
    }
    return {
      account: this.accountId,
      ign: this.ign || (this.bot && this.bot.username) || 'Unknown',
      balance: this.balance || this._lastKnownBalance || 0,
      online: Boolean(this.isOnline()),
      inventory: items,
      enderChest: this.latestEnderChest || [],
      enderChestLastUpdated: this.enderChestLastUpdated
    };
  }

  _getIndex() {
    const match = String(this.accountId).match(/\d+/);
    if (match) return Math.max(0, parseInt(match[0], 10) - 1);
    if (this.accountId === 'buyer2') return 1;
    return 0;
  }

  _onUsernameDetected(ign) {
    if (!ign || typeof ign !== 'string') return;
    const cleanIgn = ign.trim();
    if (!cleanIgn) return;
    
    this.ign = cleanIgn;
    if (/^seller\d+$/.test(this.accountId)) {
                                                                     
      const pair = require('../treasury/trading-controls').pairFor(this.accountId);
      if (pair) services.pairManager.repo.savePair({ ...pair, sellerIgn: cleanIgn });
      services.settings?.set?.('mc.' + this.accountId + '.ign', cleanIgn).catch(() => {});
      services.events?.emit?.('mc:ign_detected', { accountId: this.accountId, ign: cleanIgn });
      return;
    }
    const idx = this._getIndex();
    const acctNum = idx + 1;

                                        
    if (services.config?.mc) {
      try {
        if (idx === 0) services.config.mc.ign = cleanIgn;
        else if (idx === 1) services.config.mc.buyer2Ign = cleanIgn;
        else services.config.mc[`buyer${acctNum}Ign`] = cleanIgn;
      } catch {}
    }

                          
    if (services.store && typeof services.store.setBuyerAccount === 'function') {
      try {
        services.store.setBuyerAccount(idx, { ign: cleanIgn });
      } catch {}
    }

                             
    if (services.settings && typeof services.settings.set === 'function') {
      try {
        services.settings.set(`mc.${this.accountId}.ign`, cleanIgn).catch(() => {});
      } catch {}
    }

                                        
    if (services.pairManager && services.pairManager.repo) {
      try {
        const pairs = services.pairManager.getPairs();
        const pair = pairs[idx];
        if (pair && (!pair.buyerIgn || pair.buyerIgn.toLowerCase() === `buyer${idx + 1}` || pair.buyerIgn.toLowerCase() === `buyer_${pair.pairIndex}` || pair.buyerIgn !== cleanIgn)) {
          services.pairManager.repo.savePair({
            ...pair,
            buyerIgn: cleanIgn
          });
          services.logger?.info?.(
            'Auto-detected Minecraft IGN',
            `Auto-configured ${this.accountId} IGN to "${cleanIgn}" for Pair #${pair.pairIndex}.`
          );
        }
      } catch {}
    }

    try {
      services.events?.emit?.('mc:ign_detected', { accountId: this.accountId, ign: cleanIgn });
    } catch {}
  }

  getDetectedIgn() {
    if (this.ign && !this.ign.toLowerCase().startsWith('buyer')) return this.ign;
    if (this.bot && this.bot.username) {
      this._onUsernameDetected(this.bot.username);
      return this.bot.username;
    }
    
    const idx = this._getIndex();
    const email = this._getEmail();

                                                                                
    if (!email) {
      return null;
    }

    const seller = /^seller\d+$/.test(this.accountId);
    const fromStore = !seller && services.store && typeof services.store.getBuyerIgn === 'function' ? services.store.getBuyerIgn(idx) : '';
    if (fromStore && !fromStore.toLowerCase().startsWith('buyer')) {
      this.ign = fromStore;
      return fromStore;
    }

    if (services.pairManager && services.pairManager.repo) {
      try {
        const pair = services.pairManager.repo.getPairByIndex(idx+1);
        const configuredIgn = pair?.[seller ? 'sellerIgn' : 'buyerIgn'];
        if (configuredIgn && !/^(buyer|seller)_?\d+$/i.test(configuredIgn)) {
          this.ign = configuredIgn;
          return configuredIgn;
        }
      } catch {}
    }

                                                                        
    try {
      const fs = require('fs');
      const path = require('path');
      const crypto = require('crypto');
      const cacheDir = (services.settings && typeof services.settings.getSync === 'function' && services.settings.getSync('mc.auth.cacheDir')) || './auth-cache';
      const resolvedDir = path.resolve(cacheDir);
      if (fs.existsSync(resolvedDir)) {
        const hashPrefix = crypto.createHash('sha1').update(email.toLowerCase().trim()).digest('hex').slice(0, 6);
        const specificFile = path.join(resolvedDir, `${hashPrefix}_mca-cache.json`);
        
        let targetFiles = [];
        if (fs.existsSync(specificFile)) {
          targetFiles.push(specificFile);
        }

        for (const fullPath of targetFiles) {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const data = JSON.parse(raw);
          const token = data?.mca?.access_token;
          if (token) {
            const parts = token.split('.');
            if (parts[1]) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              const mc = payload?.pfd?.find(p => p.type === 'mc' && p.name);
              if (mc && mc.name) {
                this._onUsernameDetected(mc.name);
                return mc.name;
              }
            }
          }
        }
      }
    } catch {}

    return null;
  }

  _currentHost() {
    return this._hosts[this._hostIndex] || services.config.mc.host || 'donutsmp.net';
  }

  _rotateHost() {
    if (this._hosts.length <= 1) return false;
    this._hostIndex = (this._hostIndex + 1) % this._hosts.length;
    return true;
  }

  _getEmail() {
    if (/^seller\d+$/.test(this.accountId)) {
      const pair = require('../treasury/trading-controls').pairFor(this.accountId);
                                                                                  
      return String(pair ? pair.sellerEmail || '' : services.settings?.getSync?.('mc.' + this.accountId + '.email') || '').trim();
    }
    const idx = this._getIndex();
    const acctNum = idx + 1;
    const fromStore = services.store && typeof services.store.getBuyerEmail === 'function' ? services.store.getBuyerEmail(idx) : '';
    let fromPair = '';
    try {
      if (services.pairManager && typeof services.pairManager.getPairs === 'function') {
        const pair = services.pairManager.repo?.getPairByIndex(idx+1) || services.pairManager.getPairByIndex?.(idx+1);
        if(pair)return String(pair.buyerEmail || '').trim();
        fromPair=services.pairManager.getPairs?.()[idx]?.buyerEmail || '';
      }
    } catch {}
    let fromSettings = '';
    try {
      fromSettings = services.settings && typeof services.settings.getSync === 'function' ? (services.settings.getSync(`mc.${this.accountId}.email`) || services.settings.getSync(`mc.buyer${acctNum}.email`)) : '';
    } catch {}
    const fromConfig = idx === 0 ? services.config?.mc?.email : (idx === 1 ? services.config?.mc?.buyer2Email : services.config?.mc?.[`buyer${acctNum}Email`]);
    const envKey1 = `MC_BUYER${acctNum}_EMAIL`;
    const envKey2 = `BUYER${acctNum}_EMAIL`;
    const fromEnv = (idx === 0 ? (process.env.MC_EMAIL || process.env.BUYER1_EMAIL || process.env[envKey1]) : (process.env[envKey1] || process.env[envKey2])) || '';
    return String(fromStore || fromPair || fromSettings || fromConfig || fromEnv || '').trim();
  }

  start() {
    return this.connect();
  }

  stop(reason = 'manual') {
    return this.disconnect(reason);
  }

  isOnline() {
    return Boolean(this.bot) && ![STATE.OFFLINE,STATE.CONNECTING,STATE.STOPPING,STATE.BACKOFF].includes(this.state);
  }

  getStatus() {
    return {
      online: this.isOnline(),
      state: this.state,
      host: this._currentHost(),
      ign: this.getDetectedIgn(),
      msaCode: this.msaCode || null,
      position: null
    };
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  connect() {
    if(this._connectPromise)return this._connectPromise;
    this._shouldRun = true;
    const task=this._connect().finally(()=>{if(this._connectPromise===task)this._connectPromise=null;});
    this._connectPromise=task;
    return task;
  }

  _requireConfiguredEmail() {
    const email=String(this._getEmail()||'').trim();
    if(email)return email;
    this._shouldRun=false;
    this._clearReconnectTimer();this._stopWatchdog();
    this._reconnectNotBefore=0;this._connectingSince=0;this._consecutiveFailures=0;
    this.setState(STATE.OFFLINE);
    throw Object.assign(Error(this.accountId+' is not configured. Leave it stopped, or add its Microsoft email before starting it. No reconnect was scheduled.'),{code:'MC_EMAIL_MISSING'});
  }

  async _connect() {
    if(this._disconnectPromise)await this._disconnectPromise;
    if(!this._shouldRun)return;
    if (this.isOnline() || this.state === STATE.CONNECTING) return;
    this._requireConfiguredEmail();
    if(this._reconnectTimer && Date.now()<this._reconnectNotBefore){this.setState(STATE.BACKOFF);return;}
    const cooldown=this._reconnectNotBefore-Date.now();
    if(cooldown>0)await new Promise(resolve=>setTimeout(resolve,cooldown));
    if(!this._shouldRun || this.isOnline() || this.state===STATE.CONNECTING)return;
    
    this._hosts = [
      services.settings.getSync('mc.server.host') || 'donutsmp.net',
      ...(services.settings.getSync('mc.server.hostFallbacks') || [])
    ];
    
    this._shouldRun = true;
    this._clearReconnectTimer();
    this._startWatchdog();
    await this._createBot();
  }

  async _createBot() {
    if(!this._shouldRun || this._disconnectPromise || this.bot)return;
    const configuredEmail=this._requireConfiguredEmail();
                                                                               
    const peers = new Map((services.sessions || services.sessionManager)?.clients || []);
    for (const [id, peer] of [['buyer1', services.mcBot], ['buyer2', services.buyer2Bot], ['verify', services.verifyBot]]) if (peer && peer !== this) peers.set(id, peer);
    const email = String(this._getEmail() || '').trim().toLowerCase();
    const ign = String(this.ign || '').trim().toLowerCase();
    const duplicate = [...peers].find(([, peer]) => peer !== this &&
      (peer.bot || peer._connectPromise || peer._disconnectPromise || (peer._shouldRun && peer._reconnectTimer)) &&
      ((email && email === String(peer._getEmail?.() || '').trim().toLowerCase()) ||
       (ign && ign === String(peer.bot?.username || peer.ign || '').trim().toLowerCase())));
    if (duplicate) {
      this._shouldRun = false;
      this._clearReconnectTimer();
      this._stopWatchdog();
      this.setState(STATE.OFFLINE);
      throw Object.assign(new Error('This Minecraft account is already managed by ' + duplicate[0] + '. Use one role for this login; the duplicate session was not started.'), { code: 'DUPLICATE_MC_LOGIN' });
    }
    const { logger } = services;
    this.setState(STATE.CONNECTING);
    this._connectingSince = Date.now();

    const host = this._currentHost();
    const port = services.settings.getSync('mc.server.port') || 25565;
    const version = services.settings.getSync('mc.server.version') || '1.21.1';
    const cacheDir = services.settings.getSync('mc.auth.cacheDir') || './auth-cache';

    try {
      this._recordChat(`Connecting to ${host}:${port} as ${configuredEmail}...`, 'info');
      this.bot = mineflayer.createBot({
        host,
        port,
        username: configuredEmail,
        auth: 'microsoft',
        chat: services.settings.getSync('session.chat.commandsOnly') ? 'commandsOnly' : 'enabled',
        version: version === 'auto' ? false : version,
        profilesFolder: cacheDir,
        disableChatSigning: true,
        onMsaCode: (data) => {
          if(!this._shouldRun)return;
          this.msaCode = data;
          this._recordChat(`[Microsoft OAuth] Please visit ${data.verification_uri} and enter code: ${data.user_code}`, 'info');
          require('../services/console-logger').banner(`
\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════════════════════╗
║  🔑 MICROSOFT ACCOUNT LOGIN REQUIRED                                 ║
║                                                                      ║
║  Account:   \x1b[37m${this.accountId}\x1b[0m\x1b[1m\x1b[33m
║  1. Open:   \x1b[4m\x1b[36m${data.verification_uri}\x1b[0m\x1b[1m\x1b[33m
║  2. Code:   \x1b[1m\x1b[32m${data.user_code}\x1b[0m\x1b[1m\x1b[33m
║                                                                      ║
║  The bot will automatically resume once confirmed in your browser.   ║
╚══════════════════════════════════════════════════════════════════════╝\x1b[0m
`);
          logger.warn(
            `Microsoft sign-in required (${this.accountId})`,
            `Open **${data.verification_uri}** and enter code **\`${data.user_code}\`** to authorize ${this.accountId}.`
          );
        },
      });

      this.bot._clientRef = this;

      if (this.role === 'primary') {
        this.bot.loadPlugin(pathfinder);
      }

      this._registerHandlers();
    } catch (err) {
      this._recordChat(`Failed to create bot: ${err.message}`, 'error');
      logger.error(`Failed to create bot ${this.accountId}`, err);
      this.setState(STATE.OFFLINE);
      this._scheduleReconnect();
    }
  }

  _recordChat(text, level = 'chat') {
    if (!this.chatHistory) this.chatHistory = [];
    const clean = String(text).replace(/§./g, '').trim();
    if (!clean) return;
    const entry = {
      time: new Date().toLocaleTimeString(),
      text: clean,
      level,
      account: this.accountId
    };
    this.chatHistory.push(entry);
    if (this.chatHistory.length > 250) this.chatHistory.shift();
    if (services.logger && typeof services.logger.minecraft === 'function') {
      services.logger.minecraft(`[${this.accountId}] ${level === 'chat' ? 'Chat' : 'Event'}`, clean, undefined, 'minecraft');
    }
    this.emit('chatMessage', entry);

                                                                     
    if (level === 'pickup') {
      require('../services/console-logger').line('INFO', this.accountId, clean);
    } else if (level === 'error') {
      require('../services/console-logger').line('ERROR', this.accountId, require('../discord/log-text').readableReason(clean));
    } else if (clean.includes('Vault') || clean.includes('deposited')) {
      require('../services/console-logger').line('READY', this.accountId, clean);
    } else if (level === 'success' && (clean.includes('Spawned') || clean.includes('Logged in'))) {
      require('../services/console-logger').line('READY', this.accountId, clean);
    }
  }

  clearChatHistory() {
    this.chatHistory = [];
  }

  _registerHandlers() {
    const bot = this.bot;
    let initialized = false;
    let stableTimer;
    neutralizeChatAck(bot);

    bot.on('login', () => {
      if(this.bot!==bot || !this._shouldRun || this._disconnectPromise)return;
      neutralizeChatAck(bot);
      enableSocketKeepAlive(bot);
      if (bot.username) {
        this._onUsernameDetected(bot.username);
      }
      this._recordChat(`Logged in to ${this._currentHost()} as ${bot.username || this.accountId}`, 'success');
    });

    if (this.role === 'primary') {
      bot.once('spawn', () => {
        const movements = new Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
      });
    }

    bot.on('spawn', () => {
      if(this.bot!==bot || !this._shouldRun || this._disconnectPromise)return;
      neutralizeChatAck(bot);
      enableSocketKeepAlive(bot);
      if (initialized) return;
      initialized = true;
      this._connectingSince = 0;
      stableTimer = setTimeout(() => {
        if (this.bot === bot && this._shouldRun) this._consecutiveFailures = 0;
      }, 120000);
      stableTimer.unref?.();
      this.msaCode = null;
      if (bot.username) {
        this._onUsernameDetected(bot.username);
      }
      this.setState(STATE.IDLE);
      this._recordChat(`Spawned into world at ${bot.entity?.position ? `${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)}` : 'world spawn'}`, 'success');
      this.emit('spawn');
      
                                                 
      if (this.antiAfkEnabled) {
        this.antiAfk.start();
      }

      const spawnTimer=setTimeout(() => {if(this.bot===bot && this._shouldRun)this.runSpawnSequence().catch(() => {});},1200);spawnTimer.unref?.();

                                                                                     
                                                                       
      const balanceTimer=setTimeout(() => {if(this.bot===bot && this._shouldRun)this._balanceSafetyCheck();},3000);balanceTimer.unref?.();
    });

                                                  
    bot.inventory?.on('updateSlot', (slot, oldItem, newItem) => {
      if(this.bot!==bot||!this._shouldRun)return;
      const sameItem=oldItem&&newItem&&oldItem.type===newItem.type&&oldItem.name===newItem.name&&oldItem.metadata===newItem.metadata;
      if (newItem && (!sameItem || newItem.count > (oldItem.count || 0))) {
        const delta = newItem.count - (sameItem ? oldItem.count : 0);
        const name = newItem.displayName || newItem.name || 'item';
        this._recordChat(`📦 Picked up: ${delta}× ${name}`, 'pickup');
        this.emit('itemPickup', { slot, name, count: delta });

                                                                            
        const lower = String(name).toLowerCase();
        if (lower.includes('spawner') || lower.includes('skelly')) {
          this.scheduleAutoVault();
        }
      }
    });

                                                                                      
    bot.on('windowOpen', (win) => {
      try {
        if (require('./stock').isVerifiedEnderChest(win) && typeof win.containerItems === 'function') {
          const items = win.containerItems().map(it => ({
            slot: it.slot,
            type: it.type,
            name: it.name,
            displayName: it.displayName || it.name,
            count: it.count,
            customName: it.customName || null,
            stackSize: it.stackSize || 64
          }));
          const now = new Date().toLocaleTimeString();
          this.latestEnderChest = items;
          this.enderChestLastUpdated = now;
          if (this.bot) {
            this.bot.latestEnderChest = items;
            this.bot.enderChestLastUpdated = now;
          }
          this._recordChat(`📦 [Ender Chest] Container synchronized: ${items.length} slot(s) cached`, 'info');
        }
      } catch {}
    });

                                                                               
    bot.on('messagestr', (message) => {
      if(this.bot!==bot || !this._shouldRun)return;
      const raw = String(message).trim();
      const clean = raw.replace(/§./g, '').trim();
      this._recordChat(message, 'chat');

                       
      if (this.autoTpAccept && /(?:has requested to teleport|type \/tpaccept|\/tpaccept to accept|\/tpaccept)/i.test(clean)) {
        this._recordChat(`[Auto TP Accept] Teleport request detected. Sending /tpaccept...`, 'info');
        setTimeout(() => {
          if (this.bot) this.bot.chat('/tpaccept');
        }, 350);
      }

                                                                                                 
    });

    chatMonitor.attach(bot, this);

    bot.on('kicked', (reason) => {
      if(this.bot!==bot)return;
      const text = formatMcReason(reason);
      this._recordChat(`Disconnected / Kicked from server: ${text}`, 'error');
      if (isStaleSessionKick(text)) {
        this._longReconnect = true;
      }
                                           
      if (text.toLowerCase().includes('banned')) {
        this._shouldRun=false;
        this._clearReconnectTimer();
        this._stopWatchdog();
        this.emit('banned_suspected', text);
      }
      this.emit('kicked', reason);
    });

    bot.on('error', (err) => {
      if(this.bot!==bot)return;
      this._recordChat(`Connection error: ${err.message}`, 'error');
      this.emit('error', err);
      if (!isRecoverableNetworkError(err)) return;
      setTimeout(() => {
        if (this.bot === bot && this._shouldRun) safeQuit(bot, 'network error');
      }, 800);
    });

    bot.on('end', (reason) => {
      clearTimeout(stableTimer);
      if(this.bot!==bot)return;
      this._recordChat(`Connection ended: ${formatMcReason(reason)}`, 'warn');
      this.bot = null;
      this.setState(STATE.OFFLINE);
      this.antiAfk.stop();
      if(!this._disconnectPromise)this._scheduleReconnect();
      this.emit('end', formatMcReason(reason));
    });
  }

  async goHome() {
    if (!await require('./sweep').goHomeRobust(this)) throw Error('Home teleport was not confirmed; configure /home before collecting spawners');
    return true;
  }

  async runSpawnSequence() {
    const cmds = services.settings.getSync('session.spawn.commands') || [];
    for (const cmd of cmds) {
      this.chat(cmd);
      await new Promise(r => setTimeout(r, 800));
    }
    if (this.role === 'primary') {
      this._recordChat('Executing spawn sequence: Teleporting home and syncing Ender Chest...', 'info');
      await this.handleHomeTeleportAndSync().catch(() => {});
    }
  }

  chat(message) {
    if (typeof message !== 'string' || /[\r\n]/.test(message) || /^\s*\/?pay\b/i.test(message)) throw new Error('Payments require the persisted verifier; multiline commands are refused');
    if (this.bot) {
      this.bot.chat(message);
    }
  }

  _withStorageOperation(operation) {
    if (this._storageTask) return this._storageTask;
    const task = Promise.resolve().then(operation).finally(() => {
      if (this._storageTask === task) this._storageTask = null;
    });
    this._storageTask = task;
    return task;
  }

  handleHomeTeleportAndSync() {
    return this._withStorageOperation(() => this._handleHomeTeleportAndSync());
  }

  async _handleHomeTeleportAndSync() {
    if (!this.bot || !this.isOnline()) return;
    const bot = this.bot;
    const sweep = require('./sweep');
    if (services.sellManager && services.sellManager.activeId) return;                             

    this._recordChat('⏳ Teleporting home and synchronizing Ender Chest storage...', 'info');
    if (!await sweep.goHomeRobust(this, 2)) return { success: false, error: 'Home teleport was not confirmed; storage sync stopped' };
    await new Promise(r => setTimeout(r, 450));
    if (this.bot !== bot || !this._shouldRun) return { success: false, error: 'Connection changed while synchronizing storage' };
    return await this._syncAndDepositEnderChest(false);
  }

  _balanceSafetyCheck() {
                                                                                                 
                                                                               
  }

  scheduleAutoVault(delayMs = 2500) {
    if (this._vaultTimeout) clearTimeout(this._vaultTimeout);
    this._vaultTimeout = setTimeout(() => {
      if (!this.isOnline()) return;
      if (services.sellManager && services.sellManager.activeId) return;                             
      this.syncAndDepositEnderChest(true).catch(() => {});
    }, delayMs);
  }

  syncAndDepositEnderChest(teleportHomeFirst = false, options = {}) {
    return this._withStorageOperation(() => this._syncAndDepositEnderChest(teleportHomeFirst, options));
  }

  async _syncAndDepositEnderChest(teleportHomeFirst = false, { signal } = {}) {
    if (!this.bot || !this.isOnline()) return { success: false, error: 'Bot is offline' };
    const originalBot = this.bot;
    const ensureActive = () => { if (signal?.aborted || this.bot !== originalBot) throw Error('Inventory securing was stopped; inspect the inventory before retrying.'); };
    const stock = require('./stock');
    const spawner = require('./spawner');
    const sweep = require('./sweep');

    if (teleportHomeFirst) {
      ensureActive();
      this._recordChat('🛡️ Securing inventory: Teleporting home to deposit spawners into Ender Chest...', 'info');
      if (!await sweep.goHomeRobust(this, 2)) return { success: false, error: 'Home teleport was not confirmed' };
      await new Promise(r => setTimeout(r, 450));
    }

    let container = null;
    try {
      ensureActive();
      container = await stock.openNearbyEnderChest(this.bot);
    } catch (err) {
      ensureActive();
                                                                                          
      if (!teleportHomeFirst) {
        this._recordChat('Teleporting home to locate Ender Chest...', 'info');
        if (!await sweep.goHomeRobust(this, 2)) return { success: false, error: 'Home teleport was not confirmed' };
        await new Promise(r => setTimeout(r, 450));
        ensureActive();
        try {
          container = await stock.openNearbyEnderChest(this.bot);
        } catch (err2) {
          this._recordChat(`⚠️ Could not open Ender Chest at home: ${err2.message}`, 'error');
          return { success: false, error: err2.message };
        }
      } else {
        this._recordChat(`⚠️ Could not open Ender Chest: ${err.message}`, 'error');
        return { success: false, error: err.message };
      }
    }

    if (!container) return { success: false, error: 'Ender Chest could not be opened' };
    ensureActive();

                                     
    stock._cacheEnderChest(this.bot, container);

                                                                                          
    let depositedCount = 0;
    try {
      const invItems = (this.bot.inventory && typeof this.bot.inventory.items === 'function')
        ? this.bot.inventory.items()
        : [];
      
      const isAnySpawner = (it) => {
        if (!it) return false;
        if (spawner.isWantedSpawner(it)) return true;
        const n = String(it.name || '').toLowerCase();
        const d = String(it.displayName || '').toLowerCase();
        const c = String(it.customName || '').toLowerCase();
        return n.includes('spawner') || d.includes('spawner') || c.includes('spawner') || d.includes('skelly') || c.includes('skelly');
      };

      const spawnersInInv = invItems.filter(isAnySpawner).map(it => ({ ...it }));
      const countSpawners = items => items.filter(isAnySpawner).reduce((total, it) => total + (it.count || 0), 0);
      const inventoryBefore = countSpawners(invItems);
      const chestBefore = countSpawners(container.containerItems());
      const slotOffset = (container.inventoryStart !== undefined ? container.inventoryStart : 54) - 9;
      for (const it of spawnersInInv) {
        ensureActive();
        try {
          await container.deposit(it.type, null, it.count);
          await new Promise(r => setTimeout(r, 80));
        } catch {
          ensureActive();
                                                                        
          try {
            if (typeof this.bot.clickWindow === 'function') {
              const winSlot = it.slot + slotOffset;
              await this.bot.clickWindow(winSlot, 0, 1);
              await new Promise(r => setTimeout(r, 80));
            }
          } catch {}
        }
      }

                                                                      
      ensureActive();
      syncWindowInventory(this.bot, container);
      stock._cacheEnderChest(this.bot, container);
      const inventoryAfter = countSpawners(this.bot.inventory.items());
      const chestAfter = countSpawners(container.containerItems());
      depositedCount = Math.max(0, Math.min(inventoryBefore - inventoryAfter, chestAfter - chestBefore));
      try { container.close(); } catch {}

      if (depositedCount > 0) {
        this._recordChat(`🛡️ [Vault] Safely deposited ${depositedCount}× Skeleton Spawner into Ender Chest!`, 'success');
      } else {
        this._recordChat(`📦 [Ender Chest] Synchronized: ${this.latestEnderChest?.length || 0} slot(s) cached.`, 'info');
      }

      return {
        success: inventoryAfter === 0,
        error: inventoryAfter > 0 ? 'Some spawners remain in inventory; deposit was not fully confirmed' : undefined,
        depositedCount,
        enderChest: this.latestEnderChest || []
      };
    } catch (e) {
      try { container.close(); } catch {}
      return { success: false, error: e.message };
    }
  }

  moveSlotItem(options) {
    if (this._storageTask) return Promise.resolve({ success: false, error: 'Storage operation is in progress; wait before moving items' });
    return this._withStorageOperation(() => this._moveSlotItem(options));
  }

  async _moveSlotItem({ fromType, fromSlot, toType, toSlot, mode }) {
    if (!this.bot || !this.isOnline()) return { success: false, error: 'Bot is offline' };
    const stock = require('./stock');
    const fromS = Number(fromSlot);
    const toS = Number(toSlot);

    if (isNaN(fromS)) {
      return { success: false, error: 'Invalid source slot number' };
    }

    const getOrOpenContainer = async () => {
      if (stock.isVerifiedEnderChest(this.bot.currentWindow)) {
        return this.bot.currentWindow;
      }
      try {
        return await stock.openNearbyEnderChest(this.bot);
      } catch (err) {
        try {
          const sweep = require('./sweep');
          await sweep.goHomeRobust(this.bot, 2);
          await new Promise(r => setTimeout(r, 600));
          return await stock.openNearbyEnderChest(this.bot);
        } catch (err2) {
          throw new Error(`Could not access Ender Chest: ${err2.message || err.message}`);
        }
      }
    };

                                                                                      
    if (mode === 'shift') {
      let container = null;
      try {
        container = await getOrOpenContainer();
      } catch (err) {
        return { success: false, error: err.message };
      }

      if (!container) return { success: false, error: 'Ender Chest could not be opened' };

      try {
        const slotOffset = (container.inventoryStart !== undefined ? container.inventoryStart : 54) - 9;
        const sourceWinSlot = fromType === 'enderChest' ? fromS : (fromS + slotOffset);

        await this.bot.clickWindow(sourceWinSlot, 0, 1);                                              
        await new Promise(r => setTimeout(r, 120));

        syncWindowInventory(this.bot, container);
        stock._cacheEnderChest(this.bot, container);
        this._recordChat(`🔄 Shift-clicked item from ${fromType} #${fromS}`, 'info');
        return { success: true, ...this.getInventorySnapshot() };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    if (isNaN(toS)) {
      return { success: false, error: 'Invalid destination slot number' };
    }

                                                                         
    if (fromType === 'inventory' && toType === 'inventory') {
      try {
        if (this.bot.currentWindow && this.bot.currentWindow.inventoryStart !== undefined) {
          const slotOffset = this.bot.currentWindow.inventoryStart - 9;
          const sWinSlot = fromS + slotOffset;
          const dWinSlot = toS + slotOffset;

          await this.bot.clickWindow(sWinSlot, 0, 0);
          await new Promise(r => setTimeout(r, 100));

          await this.bot.clickWindow(dWinSlot, 0, 0);
          await new Promise(r => setTimeout(r, 100));

          if (this.bot.currentWindow.selectedItem) {
            await this.bot.clickWindow(sWinSlot, 0, 0);
            await new Promise(r => setTimeout(r, 60));
          }
          syncWindowInventory(this.bot, this.bot.currentWindow);
        } else {
          await this.bot.clickWindow(fromS, 0, 0);
          await new Promise(r => setTimeout(r, 100));

          await this.bot.clickWindow(toS, 0, 0);
          await new Promise(r => setTimeout(r, 100));

          if (this.bot.inventory?.selectedItem) {
            await this.bot.clickWindow(fromS, 0, 0);
            await new Promise(r => setTimeout(r, 60));
          }
        }

        this._recordChat(`🔄 Moved item within inventory: #${fromS} ➔ #${toS}`, 'info');
        return { success: true, ...this.getInventorySnapshot() };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

                                                                                     
    let container = null;
    try {
      container = await getOrOpenContainer();
    } catch (err) {
      return { success: false, error: err.message };
    }

    if (!container) return { success: false, error: 'Ender Chest could not be opened' };

    try {
                                         
                                                             
                                                                                                 
                                                      
      const slotOffset = (container.inventoryStart !== undefined ? container.inventoryStart : 54) - 9;
      const sourceWinSlot = fromType === 'enderChest' ? fromS : (fromS + slotOffset);
      const destWinSlot = toType === 'enderChest' ? toS : (toS + slotOffset);

                                      
      await this.bot.clickWindow(sourceWinSlot, 0, 0);
      await new Promise(r => setTimeout(r, 100));

                                       
      await this.bot.clickWindow(destWinSlot, 0, 0);
      await new Promise(r => setTimeout(r, 100));

                                                       
      const curWin = this.bot.currentWindow || container;
      if (curWin && curWin.selectedItem) {
        await this.bot.clickWindow(sourceWinSlot, 0, 0);
        await new Promise(r => setTimeout(r, 60));
      }

                                                           
      syncWindowInventory(this.bot, curWin);
      stock._cacheEnderChest(this.bot, curWin);

      this._recordChat(`🔄 Moved item from ${fromType} #${fromS} to ${toType} #${toS}`, 'info');
      return { success: true, ...this.getInventorySnapshot() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  disconnect(reason = 'manual') {
    this._shouldRun = false;
    this._clearReconnectTimer();
    this._stopWatchdog();
    this.antiAfk.stop();
    this.msaCode=null;
    if(this._vaultTimeout){clearTimeout(this._vaultTimeout);this._vaultTimeout=null;}
    if(this._disconnectPromise)return this._disconnectPromise;
    const bot=this.bot;
    this.setState(bot ? STATE.STOPPING : STATE.OFFLINE);
    if(bot)this._recordChat(`Logging out (${reason})`, 'info');
    const configured=services.settings?.getSync?.('mc.server.disconnectTimeoutMs');
    const timeoutMs=Number.isSafeInteger(configured)&&configured>0&&configured<=60000?configured:5000;
    const task=Promise.resolve().then(()=>quitAndWait(bot,reason,timeoutMs)).then(result=>{
      if(this.bot===bot)this.bot=null;
      if(bot){
        const configuredGrace=services.settings?.getSync?.('mc.server.disconnectGraceMs');
        const graceMs=Number.isSafeInteger(configuredGrace)&&configuredGrace>=0&&configuredGrace<=60000?configuredGrace:1500;
        this._reconnectNotBefore=Math.max(this._reconnectNotBefore,Date.now()+graceMs);
        this._recordChat(result.forced?'Connection closed after logout timeout; reconnect will wait.':`Logged out (${reason})`,result.forced?'warn':'info');
      }
      this.setState(STATE.OFFLINE);this.emit('stopped',reason);
    }).finally(()=>{if(this._disconnectPromise===task)this._disconnectPromise=null;});
    this._disconnectPromise=task;
    return task;
  }

  async reconnectNow() {
    await this.disconnect('Restarting');
    return this.connect();
  }

  _scheduleReconnect(overrideDelay) {
    if (!this._shouldRun || !this.autoReconnect || this._reconnectTimer) return;
    
    let delayMs;
    if (overrideDelay) {
      delayMs = overrideDelay;
    } else if (this._longReconnect) {
      delayMs = 60000;
      this._longReconnect = false;
    } else {
                                                                  
      const baseDelay = services.settings?.getSync?.('mc.server.reconnectDelayMs') || 30000;
      const maxDelay = 300000;             
      const expDelay = Math.min(baseDelay * Math.pow(2, this._consecutiveFailures), maxDelay);
      
                                                   
      const jitter = expDelay * 0.25 * (Math.random() * 2 - 1);                
      delayMs = Math.round(expDelay + jitter);
    }
    
    this._consecutiveFailures++;
    this._reconnectNotBefore=Math.max(this._reconnectNotBefore,Date.now()+delayMs);
    this.setState(STATE.BACKOFF);
    const delaySec = (delayMs / 1000).toFixed(1);
    services.logger?.info?.('Reconnect scheduled', `${this.accountId} reconnecting in ${delaySec}s (attempt ${this._consecutiveFailures})`);
    
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._shouldRun && this.autoReconnect && !this.isOnline()) this.connect().catch(error=>this.emit('error',error));
    }, delayMs);
    this._reconnectTimer.unref?.();
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(() => {
      if (!this._shouldRun || !this.autoReconnect || this.isOnline() || this._reconnectTimer) return;
      const stuckMs = this._connectingSince ? Date.now() - this._connectingSince : 0;
      if (this.state === STATE.CONNECTING && stuckMs >= 90_000 && this.bot) {
        safeQuit(this.bot, 'watchdog stuck connecting');
        return;
      }
      if (stuckMs >= 90_000) {
        this._scheduleReconnect();
      }
    }, 30000);
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  getTelemetry() {
    if (!this.bot || !this.bot.entity || !this.isOnline()) {
      return {
        online: false,
        position: null,
        yaw: 0,
        pitch: 0,
        heading: 'N',
        health: null,
        food: null,
        dimension: 'overworld',
        nearbyPlayers: []
      };
    }
    const pos = this.bot.entity.position;
    const yaw = this.bot.entity.yaw || 0;
    const pitch = this.bot.entity.pitch || 0;

    const deg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
    const headings = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
    const headingIndex = Math.round(deg / 45) % 8;
    const heading = headings[headingIndex];

    const nearbyPlayers = [];
    if (this.bot.entities) {
      for (const id in this.bot.entities) {
        const ent = this.bot.entities[id];
        if (ent && ent.type === 'player' && ent.username && ent.username !== this.bot.username && ent.position) {
          const dx = ent.position.x - pos.x;
          const dz = ent.position.z - pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist <= 48) {
            nearbyPlayers.push({
              username: ent.username,
              x: Math.round(ent.position.x),
              y: Math.round(ent.position.y),
              z: Math.round(ent.position.z),
              distance: Math.round(dist * 10) / 10,
              angle: Math.atan2(dz, dx)
            });
          }
        }
      }
    }
    nearbyPlayers.sort((a, b) => a.distance - b.distance);

    return {
      online: true,
      position: {
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
        z: Math.round(pos.z * 10) / 10
      },
      yaw: Math.round(yaw * 100) / 100,
      pitch: Math.round(pitch * 100) / 100,
      heading,
      health: Number.isFinite(this.bot.health) ? this.bot.health : null,
      food: Number.isFinite(this.bot.food) ? this.bot.food : null,
      dimension: this.bot.game?.dimension || 'overworld',
      nearbyPlayers: nearbyPlayers.slice(0, 10)
    };
  }

  async emergencyLockdown() {
    if (this._lockdownPromise) return this._lockdownPromise;
    const execute = async () => {
      this._shouldRun = false;
      this._clearReconnectTimer();
      this._stopWatchdog?.();
      this.antiAfk?.stop();
      if (this._vaultTimeout) { clearTimeout(this._vaultTimeout); this._vaultTimeout = null; }
      if (!this.bot) return { success: true, secured: true, disconnected: true, message: 'Already offline.' };
      const bot = this.bot, abort = new AbortController();
      const spawners = () => typeof bot.inventory?.items === 'function' ? bot.inventory.items().filter(item => require('./spawner').isWantedSpawner(item) || /spawner/i.test(item.name || '')).reduce((n, item) => n + item.count, 0) : null;
      const inventoryCount = spawners();
      const paymentBusy = require('./verified-payments').isChannelBusy(bot);
      let secured = inventoryCount === 0, error = null, timer;
      const configured = services.settings?.getSync?.('mc.server.lockdownTimeoutMs');
      const timeoutMs = Number.isSafeInteger(configured) && configured > 0 && configured <= 30000 ? configured : 20000;
      try {
        if (inventoryCount === null) error = 'Inventory was not available before logout. Check this account in-game before restarting.';
        else if (!secured && paymentBusy) error = 'A payment was in progress. Inventory commands were skipped; check its payment record and inventory before restarting.';
        else if (!secured) {
          const result = await Promise.race([
            this.syncAndDepositEnderChest(true, { signal: abort.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error('Ender Chest securing timed out. Items may remain in inventory.')); }, timeoutMs); }),
          ]);
          secured = result?.success === true && spawners() === 0;
          if (!secured) error = result?.error || 'Some spawners may remain in inventory. Check them in-game before restarting.';
        }
      } catch (cause) { error = cause.message; }
      finally { clearTimeout(timer); abort.abort(); await this.disconnect('Emergency lockdown'); }
      return { success: true, secured, disconnected: !this.bot, message: secured ? 'Account logged out; no spawners remain in its inventory.' : 'Account logged out. Inventory securing needs review.', ...(error ? { error } : {}) };
    };
    const task = execute().finally(() => { if (this._lockdownPromise === task) this._lockdownPromise = null; });
    this._lockdownPromise = task;
    return task;
  }
}

AccountClient.STATE = STATE;
AccountClient.goals = goals;
module.exports = AccountClient;
