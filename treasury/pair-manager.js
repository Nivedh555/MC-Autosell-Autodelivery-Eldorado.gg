'use strict';

const EventEmitter = require('events');
const services = require('../services');

class PairManager extends EventEmitter {
     
                                                          
                              
     
  constructor(pairsRepo, options = {}) {
    super();
    this.repo = pairsRepo;
    this.defaultThreshold = options.defaultThreshold || 3000000000;
    this.defaultPairCount = options.defaultPairCount || 2;
    this.orderQueue = [];
    this._staleCheckInterval = null;
  }

     
                                             
     
  async init() {
    let count = this.defaultPairCount;
    let threshold = this.defaultThreshold;

    if (services.settings) {
      try {
        const savedCount = await services.settings.get('autosell.pair_count');
        if (savedCount != null && Number(savedCount) > 0) {
          count = Number(savedCount);
        }
      } catch {
                          
      }
    }

                                                          
    const existingPairs = this.repo.getAllPairs();
    if (existingPairs.length < count) {
      this.repo.setPairCount(count, threshold);
    }

                                                                      
    const pairs = this.repo.getAllPairs();
    if (services.settings?.definitions) {
      const controls = require('./trading-controls');
      const roles = await services.settings.get('treasury.accountRoles') || {};
      for (const pair of pairs) {
        const buyer = controls.canonical(pair.buyerId), seller = controls.canonical(pair.sellerId);
        if (pair.buyerEmail?.trim() || services.gameBridge?.tokens.has(buyer)) roles[buyer] = { ...roles[buyer], role: 'intake', ign: pair.buyerIgn, holderAccount: controls.deliveryAccount(pair) };
        else delete roles[buyer];
        if (pair.sellerEmail?.trim() || services.gameBridge?.tokens.has(seller)) roles[seller] = { ...roles[seller], role: 'holder', ign: pair.sellerIgn };
        else delete roles[seller];
      }
      await services.settings.set('treasury.accountRoles', roles, 'pair-manager');
    }
    pairs.forEach((pair, idx) => {
      if (!pair.buyerIgn || pair.buyerIgn.toLowerCase() === `buyer${idx + 1}` || pair.buyerIgn.toLowerCase() === `buyer_${pair.pairIndex}`) {
        const client = idx === 0 ? services.mcBot : idx === 1 ? services.buyer2Bot : null;
        const detected = client && typeof client.getDetectedIgn === 'function' ? client.getDetectedIgn() : null;
        if (detected) {
          try { this.repo.savePair({ ...pair, buyerIgn: detected }); } catch {}
        }
      }
    });

                                                                       
    this.recoverStaleLocks(0);                                                            

                                                                                 
    this._staleCheckInterval = setInterval(() => {
      this.recoverStaleLocks(10 * 60 * 1000);
    }, 120000);
    if (this._staleCheckInterval.unref) {
      this._staleCheckInterval.unref();
    }

    return this.getPairs();
  }

  stop() {
    if (this._staleCheckInterval) {
      clearInterval(this._staleCheckInterval);
      this._staleCheckInterval = null;
    }
  }

  getPairs() {
    const pairs = this.repo.getAllPairs();
    return pairs.map((pair, idx) => {
      if (pair.buyerEmail && (!pair.buyerIgn || pair.buyerIgn.toLowerCase() === `buyer${idx + 1}` || pair.buyerIgn.toLowerCase() === `buyer_${pair.pairIndex}`)) {
        const client = services.sessionManager ? services.sessionManager.getClient(`buyer${pair.pairIndex}`) : (idx === 0 ? services.mcBot : null);
        const detected = client && typeof client.getDetectedIgn === 'function' ? client.getDetectedIgn() : null;
        const b1Ign = pairs[0]?.buyerIgn;
        if (detected && (idx === 0 || !b1Ign || detected.toLowerCase() !== b1Ign.toLowerCase())) {
          pair.buyerIgn = detected;
          try { this.repo.savePair({ ...pair, buyerIgn: detected }); } catch {}
        }
      }
      return pair;
    });
  }

  getPair(pairId) {
    return this.repo.getPairById(pairId);
  }

  getPairByIndex(index) {
    return this.repo.getPairByIndex(index);
  }

  getPairByBuyerIgn(ign) {
    if (!ign) return null;
    const lower = ign.toLowerCase();
    return this.getPairs().find(p => (p.buyerIgn || '').toLowerCase() === lower) || null;
  }

  getPairBySellerIgn(ign) {
    if (!ign) return null;
    const lower = ign.toLowerCase();
    return this.getPairs().find(p => (p.sellerIgn || '').toLowerCase() === lower) || null;
  }

     
                                        
     
  async setPairCount(count) {
    if (count < 1) throw new Error('Pair count must be at least 1');
    const threshold = this.defaultThreshold;
                                                                           
                                                                               
    for (const pair of this.repo.getAllPairs().filter(pair => pair.pairIndex > count)) {
      require('./trading-controls').assertEditable(pair);
      const clients = services.sessions?.clients;
      if ([pair.buyerId, pair.sellerId].some(id => clients?.get(require('./trading-controls').canonical(id))?.isOnline())) throw new Error('Stop the pair accounts before removing them');
    }
    
    const updated = this.repo.setPairCount(count, threshold);
    if (services.settings) {
      await services.settings.set('autosell.pair_count', count, 'pair-manager');
    }
    this.emit('pairsUpdated', updated);
    return updated;
  }

     
                                          
     
  savePair(pairData) {
    const previous = this.repo.getPairById(pairData.id);
    const replacements = previous ? ['buyer','seller'].filter(role => pairData[role+'Email'] !== undefined &&
      String(pairData[role+'Email']).trim().toLowerCase() !== String(previous[role+'Email'] || '').trim().toLowerCase()) : [];
    if (replacements.length) {
      require('./trading-controls').assertEditable(previous);
      for (const role of replacements) {
        const id=require('./trading-controls').canonical(previous[role+'Id']);
        const client=(services.sessions || services.sessionManager)?.clients?.get(id);
        if(client?.bot || client?._disconnectPromise || client?._connectPromise || client?.isOnline?.() || String(client?.state).toLowerCase()==='connecting') throw Error('Stop '+id+' and wait for logout before replacing its Microsoft account');
      }
    }
    const updated = this.repo.savePair(pairData);
    for (const role of replacements) {
      const id=require('./trading-controls').canonical(updated[role+'Id']), db=this.repo.db;
                                                                            
                                                                         
      for(const table of ['account_snapshots','balance_observations']) if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare('DELETE FROM '+table+' WHERE account_id=?').run(id);
      const client=(services.sessions || services.sessionManager)?.clients?.get(id);
      if(client){client.ign=null;client.balance=null;client._lastKnownBalance=null;client.transactions=[];client.chatHistory=[];client.latestEnderChest=[];client.enderChestLastUpdated=null;}
    }
    const idx = (updated.pairIndex || 1) - 1;
    if (idx >= 0) {
      if (services.store && typeof services.store.setBuyerAccount === 'function') {
        services.store.setBuyerAccount(idx, {
          email: updated.buyerEmail || '',
          ign: updated.buyerIgn || ''
        });
      }
      if (services.config && services.config.mc) {
        if (idx === 0) {
          services.config.mc.email = updated.buyerEmail || '';
          services.config.mc.ign = updated.buyerIgn || '';
        } else if (idx === 1) {
          services.config.mc.buyer2Email = updated.buyerEmail || '';
          services.config.mc.buyer2Ign = updated.buyerIgn || '';
        } else if (idx === 2) {
          services.config.mc.buyer3Email = updated.buyerEmail || '';
          services.config.mc.buyer3Ign = updated.buyerIgn || '';
        }
      }
    }
    this.emit('pairUpdated', updated);
    return updated;
  }

     
                             
     
  togglePair(pairId, disabled) {
    const updated = this.repo.togglePair(pairId, disabled);
    this.emit('pairUpdated', updated);
    return updated;
  }

     
                                                                     
     
  creditPairBalance(pairId, amount) {
    const pair = this.repo.getPairById(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);

    const newBalance = pair.accumulatedBalance + Number(amount);
    const updated = this.repo.updateAccumulatedBalance(pairId, newBalance);

    this.emit('balanceUpdated', {
      pairId,
      amountAdded: Number(amount),
      newBalance: updated.accumulatedBalance,
      state: updated.state,
      threshold: updated.threshold
    });

    if (updated.state === 'FREE' && pair.state !== 'FREE') {
      this.emit('thresholdReached', updated);
      this._drainQueue();
    }

    return updated;
  }

     
                                                          
     
  async acquirePairForOrder(orderId, requiredAmount) {
    const amount = Number(requiredAmount);
    const available = this.repo.getAvailablePair(amount);

    if (!available) {
      let allBusyAction = 'queue';
      if (services.settings) {
        try {
          allBusyAction = await services.settings.get('autosell.all_busy_action');
        } catch {
          allBusyAction = 'queue';
        }
      }

      if (allBusyAction === 'queue') {
        const queueEntry = { orderId, requiredAmount: amount, queuedAt: Date.now() };
        this.orderQueue.push(queueEntry);
        this.emit('orderQueued', queueEntry);
        return {
          acquired: false,
          queued: true,
          position: this.orderQueue.length,
          reason: 'No pair currently available with sufficient balance; queued.'
        };
      }

      return {
        acquired: false,
        queued: false,
        reason: 'All pairs busy or below threshold.'
      };
    }

    const locked = this.repo.lockPair(available.id, orderId);
    if (!locked) {
                                       
      return this.acquirePairForOrder(orderId, requiredAmount);
    }

    const lockedPair = this.repo.getPairById(available.id);
    this.emit('pairLocked', { pairId: lockedPair.id, orderId });
    return {
      acquired: true,
      pair: lockedPair
    };
  }

     
                                                                 
     
  completeOrderDelivery(pairId, orderId, deliveredAmount) {
    const pair = this.repo.getPairById(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);

    const remainingBalance = Math.max(0, pair.accumulatedBalance - Number(deliveredAmount));
    const released = this.repo.releasePair(pairId, remainingBalance);

    this.emit('pairReleased', {
      pairId,
      orderId,
      deliveredAmount: Number(deliveredAmount),
      remainingBalance: released.accumulatedBalance,
      state: released.state
    });

    this._drainQueue();
    return released;
  }

     
                                                            
     
  cancelOrderLock(pairId, orderId) {
    const pair = this.repo.getPairById(pairId);
    if (!pair) return null;

    if (pair.currentOrderId === orderId || pair.state === 'DELIVERING') {
      const released = this.repo.releasePair(pairId, pair.accumulatedBalance);
      this.emit('pairReleased', { pairId, orderId, cancelled: true, state: released.state });
      this._drainQueue();
      return released;
    }

    return pair;
  }

     
                                                        
     
  recoverStaleLocks(maxLockAgeMs = 15 * 60 * 1000) {
    const pairs = this.repo.getAllPairs();
    const now = Date.now();
    let recoveredCount = 0;

    for (const pair of pairs) {
      if (pair.state === 'DELIVERING' || pair.currentOrderId) {
        let isStale = false;
        if (maxLockAgeMs === 0) {
          isStale = true;                    
        } else if (pair.lockedAt) {
          const lockTime = new Date(pair.lockedAt).getTime();
          if (now - lockTime > maxLockAgeMs) {
            isStale = true;
          }
        } else {
          isStale = true;
        }

        if (isStale) {
                                                                                                         
          this.emit('pairNeedsOperator', { pairId: pair.id, previousOrder: pair.currentOrderId, reason: 'Stale payment lock retained' });
        }
      }
    }

    return recoveredCount;
  }

     
                                                      
     
  _drainQueue() {
    if (this.orderQueue.length === 0) return;

    for (let i = 0; i < this.orderQueue.length; i++) {
      const item = this.orderQueue[i];
      const available = this.repo.getAvailablePair(item.requiredAmount);
      if (available) {
        this.orderQueue.splice(i, 1);
        this.emit('queueOrderReady', { orderId: item.orderId, pairId: available.id, requiredAmount: item.requiredAmount });
        break;
      }
    }
  }

  getQueue() {
    return [...this.orderQueue];
  }
}

module.exports = PairManager;
