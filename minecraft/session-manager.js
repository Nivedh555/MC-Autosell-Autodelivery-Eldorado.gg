'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const services = require('../services');
const AccountClient = require('../v3/account-factory');

class Lease {
  constructor(manager, accountId, reason, options = {}) {
    this.manager = manager;
    this.id = crypto.randomUUID();
    this.accountId = accountId;
    this.reason = reason;
    this.state = 'requested';                                                  
    this.createdAt = Date.now();
    this.priority = options.priority || 0;
    this.ttlMs = options.ttlMs || (services.settings && typeof services.settings.getSync === 'function' ? services.settings.getSync('session.lease.durationMs') : 60000) || 60000;
    this.expiresAt = this.createdAt + this.ttlMs;
    
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this._readyPromise.catch(() => {});                                                                                
  }

  async ready(timeoutMs = 25000) {
    this._assertActive();
    if (this.state === 'ready' || this.state === 'in_use') { this.getBot(); return; }
    let timer;
    try { await Promise.race([
      this._readyPromise,
      new Promise((_, reject) =>
        { timer = setTimeout(() => reject(new Error(`Timeout waiting for ${this.accountId} session to become ready (bot offline or connecting)`)), timeoutMs); }
      ),
    ]); this._assertActive(); this.getBot(); } finally { clearTimeout(timer); }
  }

  _assertActive() {
    if (this.failure) throw this.failure;
    if (!this.isValid()) throw new Error('Session lease expired or was released');
  }

  _invalidate(error) {
    this.failure ||= error;
    this.state = 'released';
    this.manager.leases.delete(this.id);
    this._readyReject?.(this.failure);
    this._readyReject = null;
    this._readyResolve = null;
  }

  release() {
    if (this.state === 'released') return;
    this._invalidate(new Error('Session lease was released'));
    this.manager._onLeaseReleased(this);
  }

  extend(additionalMs) {
    if (!this.isValid()) return false;
    if (!Number.isSafeInteger(additionalMs) || additionalMs <= 0) throw new Error('Lease extension must be a positive duration');
    this.expiresAt = Math.max(this.expiresAt, Date.now() + additionalMs);
    return true;
  }

  isValid() {
    return this.state !== 'released' && Date.now() < this.expiresAt;
  }

  getClient() {
    return this.manager.getClient(this.accountId);
  }

  getBot() {
    this._assertActive();
    if (this.state !== 'ready' && this.state !== 'in_use') {
      throw new Error('Lease is not ready');
    }
    const client = this.getClient();
    if (!client) throw new Error(`Account client missing for ${this.accountId}`);
    if (!client.bot) throw new Error(`Bot instance for ${this.accountId} is not connected to Minecraft server (offline)`);
    if (client.bot !== this.bot || !client.isOnline()) throw new Error('Session disconnected or changed; acquire a fresh lease');
    return client.bot;
  }
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.leases = new Map();               
    this.clients = new Map();                              
    this.states = new Map();                                                                                                      
    
                                             
    this.graceTimers = new Map();
    this.manualStops = new Set();
                       
    this.watchdogInterval = setInterval(() => this._checkExpirations(), 5000);
    this.watchdogInterval.unref?.();
    this.stopping = false;
  }

  getClient(accountId) {
    let client = this.clients.get(accountId);
    if (!client) {
      if (accountId === 'buyer1' && services.mcBot) {
        client = services.mcBot;
      } else if (accountId === 'buyer2' && services.buyer2Bot) {
        client = services.buyer2Bot;
      } else if (accountId === 'buyer3' && services.buyer3Bot) {
        client = services.buyer3Bot;
      } else if (accountId) {
        client = new AccountClient(accountId);
      }
      if (client) {
        this.clients.set(accountId, client);
        this._bindClientEvents(accountId, client);
      }
    }
    return client;
  }

  getMode(accountId) {
    return (services.settings && typeof services.settings.getSync === 'function' ? services.settings.getSync('session.mode') : 'on_demand') || 'on_demand';
  }

  setMode(accountId, mode) {
                           
  }

  getState(accountId) {
    const client = this.getClient(accountId);
    return this.states.get(accountId) || (client && client.isOnline && client.isOnline() ? 'READY' : 'DISCONNECTED');
  }

  _setState(accountId, state, details = {}) {
    const old = this.getState(accountId);
    if (old === state) return;
    this.states.set(accountId, state);
    if (services.events) services.events.emit('session:' + state.toLowerCase(), { accountId, ...details });
  }

  getLeases(accountId) {
    const arr = Array.from(this.leases.values()).filter(l => l.isValid());
    if (accountId) return arr.filter(l => l.accountId === accountId);
    return arr;
  }

  async acquire(accountId, reason, options = {}) {
    if (this.stopping) throw new Error('Session manager is shutting down');
    if (this.manualStops.has(accountId)) throw new Error('This account was manually logged out. Log it in before starting another job.');
    if (services.accountUpdates?.has(require('../treasury/trading-controls').canonical(accountId))) throw new Error('Account credentials are being updated. Retry after the save finishes.');
    const lease = new Lease(this, accountId, reason, options);
    this.leases.set(lease.id, lease);
    
    if (services.events) services.events.emit('session:requested', { leaseId: lease.id, accountId, reason });
    
    this._evaluateAccountConnection(accountId);
    if (this.getState(accountId) === 'READY') {
      this._resolvePendingLeases(accountId);
    }
    
    return lease;
  }

  _evaluateAccountConnection(accountId) {
    if (this.stopping) return;
    if (this.manualStops.has(accountId)) return;
    if (services.accountUpdates?.has(require('../treasury/trading-controls').canonical(accountId))) return;
    if (this.getState(accountId) === 'BANNED_SUSPECTED') {
      this._failPendingLeases(accountId, new Error('Account is suspected banned.'));
      return;
    }

    const activeLeases = this.getLeases(accountId);
    const mode = this.getMode(accountId);
    const shouldBeOnline = mode === 'always_on' || activeLeases.length > 0;
    
    let client = this.getClient(accountId);
    if (!client) {
      client = new AccountClient(accountId);
      this.clients.set(accountId, client);
      this._bindClientEvents(accountId, client);
    }
    
    const state = this.getState(accountId);

    if (shouldBeOnline) {
      this._clearGraceTimer(accountId);
      const login=String(client._getEmail?.() || '').trim().toLowerCase();
      if (!login && services.pairManager) return;
      if(login){
        const other=[...this.clients].find(([id,c])=>id!==accountId && (c.isOnline?.() || c._connectPromise || c._disconnectPromise || String(c.state).toLowerCase()==='connecting') && String(c._getEmail?.() || '').trim().toLowerCase()===login);
        if(other){this._failPendingLeases(accountId,new Error('This Minecraft login is already in use by '+other[0]+'. Configure a different login; no duplicate connection started.'));return;}
      }
      if (state === 'IDLE_GRACE' && client.isOnline()) {
        this._setState(accountId, 'READY');
        this._resolvePendingLeases(accountId);
      } else if (state === 'DISCONNECTED' || state === 'IDLE_GRACE' || state === 'BACKOFF') {
        if(client._disconnectPromise){this._setState(accountId,'DISCONNECTING');return;}
        if(client._reconnectTimer){this._setState(accountId,'BACKOFF');return;}
        this._setState(accountId, 'CONNECTING');
        Promise.resolve(client.connect()).catch(error => this._failPendingLeases(accountId, error));
      } else if (state === 'READY') {
        this._resolvePendingLeases(accountId);
      }
    } else {
      if (state === 'READY') {
                               
        const configured = services.settings?.getSync?.('session.lease.durationMs');
        const graceMs = Number.isFinite(configured) && configured > 0 ? configured : 60000;
        this._setState(accountId, 'IDLE_GRACE', { graceMs });
        this.graceTimers.set(accountId, setTimeout(() => {
          this.graceTimers.delete(accountId);
          if (this.getMode(accountId) === 'always_on' || this.getLeases(accountId).length) {
            this._evaluateAccountConnection(accountId);
            return;
          }
          this._setState(accountId, 'DISCONNECTING');
          Promise.resolve(client.disconnect('Idle grace period expired')).then(()=>{
            this._setState(accountId,'DISCONNECTED');
            this._evaluateAccountConnection(accountId);
          }).catch(error=>this._failPendingLeases(accountId,error));
        }, graceMs));
      } else if (state === 'CONNECTING') {
                                                                
      }
    }
  }

  _bindClientEvents(accountId, client) {
    let balanceStartedForBot = null;
    client.on('state',state=>{
      if(state==='stopping')this._setState(accountId,'DISCONNECTING');
      if(state==='backoff')this._setState(accountId,'BACKOFF');
      if(state==='offline' && !client._disconnectPromise && this.states.get(accountId)!=='BANNED_SUSPECTED')this._setState(accountId,'DISCONNECTED');
    });
    client.on('stopped',reason=>{
      this._clearGraceTimer(accountId);
      if(this.getState(accountId)!=='BANNED_SUSPECTED')this._setState(accountId,'DISCONNECTED');
      if(reason!=='Idle grace period expired')this._failPendingLeases(accountId,new Error('Account logged out'));
    });
    client.on('chat:payment', payment => {
      const roles = services.settings?.getSync?.('treasury.accountRoles') || {};
      if (roles[accountId]?.role !== 'intake') return;
      require('../sell/exchange').onPayment(payment, client).catch(error => services.events?.emit('operator:alert', { component: 'intake', reason: error.message }));
    });
    client.on('spawn', () => {
                                                                       
      if (this.states.get(accountId) === 'IDLE_GRACE' && !this.getLeases(accountId).length) return;
      this._setState(accountId, 'READY');
      this._resolvePendingLeases(accountId);
      this._evaluateAccountConnection(accountId);
      const treasury = services.treasury;
      if (services.settings?.getSync?.('delivery.patternPack')?.serverProfile === 'donutsmp-v1' &&
          client.bot && client.bot !== balanceStartedForBot && treasury?.reconcile && !treasury.stopping && !client._lockdownPromise) {
        balanceStartedForBot = client.bot;
        Promise.resolve().then(() => treasury.reconcile(accountId)).catch(error => {
          services.events?.emit('operator:alert', { component: 'treasury', accountId, reason: 'Automatic balance read failed: ' + error.message + ' Use manual capture only if the server reply has changed.' });
        });
      }
    });

    client.on('end', (reason) => {
      require('../sell/exchange').onAccountDisconnected(accountId);
      if (this.getState(accountId) !== 'BANNED_SUSPECTED') {
        this._setState(accountId, client._disconnectPromise ? 'DISCONNECTING' : client._reconnectTimer ? 'BACKOFF' : 'DISCONNECTED');
      }
      this._failPendingLeases(accountId, new Error('Session disconnected: ' + reason));
                                                                           
                                                                                  
      if(!client._disconnectPromise && !client._reconnectTimer)this._evaluateAccountConnection(accountId);
    });

    client.on('error', (err) => {
                                                               
      services.events?.emit('mc:error', { accountId, error: err });
    });
    
    client.on('banned_suspected', (evidence) => {
      this._setState(accountId, 'BANNED_SUSPECTED');
      services.events.emit('session:banned', { accountId, evidence });
      client.disconnect('Suspected ban');
    });
  }

  _onLeaseReleased(lease) {
    this.leases.delete(lease.id);
    this._evaluateAccountConnection(lease.accountId);
  }

  _checkExpirations() {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      if (lease.state !== 'released' && now >= lease.expiresAt) {
        lease.release();
      }
    }
    this.reconcileConfigured();
  }

  reconcileConfigured() {
    if (this.stopping) return;
    const canonical = require('../treasury/trading-controls').canonical;
    for (const pair of services.pairManager?.getPairs() || []) {
      for (const role of ['buyer', 'seller']) {
        if (pair[role + 'Email']?.trim()) this._evaluateAccountConnection(canonical(pair[role + 'Id']));
      }
    }
  }

  setManualStop(accountId, stopped = true) {
    if (stopped) { this.manualStops.add(accountId); this._clearGraceTimer(accountId); }
    else this.manualStops.delete(accountId);
  }

  _resolvePendingLeases(accountId) {
    const activeLeases = this.getLeases(accountId);
    for (const l of activeLeases) {
      if (l.state === 'requested' || l.state === 'connecting') {
        l.bot = this.getClient(accountId)?.bot;
        l.state = 'ready';                                                                  
                                    
        if (l._readyResolve) {
          l._readyResolve();
          l._readyResolve = null;
        }
      }
    }
  }

  _failPendingLeases(accountId, error) {
    const activeLeases = [...this.leases.values()].filter(l => l.accountId === accountId);
    for (const l of activeLeases) {
      l._invalidate(error);
    }
  }

  _clearGraceTimer(accountId) {
    const timer = this.graceTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(accountId);
    }
  }

  async forceDisconnect(accountId, reason) {
    this.setManualStop(accountId, true);
    this._clearGraceTimer(accountId);
    const client = this.clients.get(accountId);
    if (client) {
      this._setState(accountId, 'DISCONNECTING');
      await client.disconnect(reason);
    }
    this._setState(accountId, 'DISCONNECTED');
    this._failPendingLeases(accountId, new Error('Force disconnected: ' + reason));
  }

  reenableAccount(accountId) {
    if (this.getState(accountId) === 'BANNED_SUSPECTED') {
      this._setState(accountId, 'DISCONNECTED');
      this._evaluateAccountConnection(accountId);
    }
  }

  async shutdownAll() {
    this.stopping = true;
    clearInterval(this.watchdogInterval);
    for (const accountId of this.clients.keys()) this._failPendingLeases(accountId, new Error('Application shutdown'));
    this.leases.clear();
    await Promise.all([...this.clients.entries()].map(async ([accountId, client]) => {
      this._clearGraceTimer(accountId);
      await client.disconnect('Graceful shutdown');
    }));
    this.leases.clear();
  }
}

module.exports = new SessionManager();
module.exports.SessionManager = SessionManager;
