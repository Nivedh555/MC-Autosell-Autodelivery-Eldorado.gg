'use strict';

class PairsRepository {
     
                                                   
     
  constructor(db) {
    this.db = db;
    try {
      this.db.exec('ALTER TABLE account_pairs ADD COLUMN disabled INTEGER DEFAULT 0;');
    } catch {}
  }

  getAllPairs() {
    const stmt = this.db.prepare('SELECT * FROM account_pairs ORDER BY pair_index ASC');
    return stmt.all().map(r => this._mapPairRow(r));
  }

  getPairById(id) {
    const stmt = this.db.prepare('SELECT * FROM account_pairs WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapPairRow(row) : null;
  }

  getPairByIndex(index) {
    const stmt = this.db.prepare('SELECT * FROM account_pairs WHERE pair_index = ?');
    const row = stmt.get(index);
    return row ? this._mapPairRow(row) : null;
  }

  savePair(pair) {
    const now = new Date().toISOString();
    const existing = this.getPairById(pair.id);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE account_pairs SET
          pair_index = ?,
          buyer_id = ?,
          buyer_ign = ?,
          buyer_email = ?,
          seller_id = ?,
          seller_ign = ?,
          seller_email = ?,
          accumulated_balance = ?,
          threshold = ?,
          state = ?,
          current_order_id = ?,
          locked_at = ?,
          disabled = ?,
          updated_at = ?
        WHERE id = ?
      `);
      stmt.run(
        pair.pairIndex ?? existing.pairIndex,
        pair.buyerId ?? existing.buyerId,
        pair.buyerIgn ?? existing.buyerIgn,
        pair.buyerEmail ?? existing.buyerEmail,
        pair.sellerId ?? existing.sellerId,
        pair.sellerIgn ?? existing.sellerIgn,
        pair.sellerEmail ?? existing.sellerEmail,
        pair.accumulatedBalance ?? existing.accumulatedBalance,
        pair.threshold ?? existing.threshold,
        pair.state ?? existing.state,
        pair.currentOrderId !== undefined ? pair.currentOrderId : existing.currentOrderId,
        pair.lockedAt !== undefined ? pair.lockedAt : existing.lockedAt,
        pair.disabled !== undefined ? (pair.disabled ? 1 : 0) : (existing.disabled ? 1 : 0),
        now,
        pair.id
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO account_pairs (
          id, pair_index, buyer_id, buyer_ign, buyer_email,
          seller_id, seller_ign, seller_email, accumulated_balance,
          threshold, state, current_order_id, locked_at, disabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        pair.id,
        pair.pairIndex,
        pair.buyerId || `buyer_${pair.pairIndex}`,
        pair.buyerIgn || '',
        pair.buyerEmail || '',
        pair.sellerId || `seller_${pair.pairIndex}`,
        pair.sellerIgn || '',
        pair.sellerEmail || '',
        pair.accumulatedBalance || 0,
        pair.threshold || 3000000000,
        pair.state || 'BELOW_THRESHOLD',
        pair.currentOrderId || null,
        pair.lockedAt || null,
        pair.disabled ? 1 : 0,
        now,
        now
      );
    }

    return this.getPairById(pair.id);
  }

     
                                                  
                                             
                                                                       
     
  setPairCount(targetCount, defaultThreshold = 3000000000) {
    if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 100) throw new Error('Pair count must be a whole number from 1 to 100');
    const pairs = this.getAllPairs();
    const currentCount = pairs.length;
                                                            
    for (const pair of pairs.filter(pair => pair.pairIndex > targetCount)) {
      if (pair.currentOrderId || pair.lockedAt || ['DELIVERING','BUSY'].includes(pair.state)) throw new Error(`Cannot remove pair ${pair.id} with an active or unresolved order`);
    }

    if (targetCount > currentCount) {
      for (let i = currentCount + 1; i <= targetCount; i++) {
        const id = `pair_${i}`;
        this.savePair({
          id,
          pairIndex: i,
          buyerId: `buyer_${i}`,
          buyerIgn: '',
          buyerEmail: '',
          sellerId: `seller_${i}`,
          sellerIgn: '',
          sellerEmail: '',
          accumulatedBalance: 0,
          threshold: defaultThreshold,
          state: 'BELOW_THRESHOLD'
        });
      }
    } else if (targetCount < currentCount) {
      for (let i = currentCount; i > targetCount; i--) {
        const pair = this.getPairByIndex(i);
        if (pair) {
          if (pair.state === 'DELIVERING' || pair.state === 'BUSY') {
            throw new Error(`Cannot remove pair ${pair.id} while it is ${pair.state}`);
          }
          const delStmt = this.db.prepare('DELETE FROM account_pairs WHERE id = ?');
          delStmt.run(pair.id);
        }
      }
    }

    return this.getAllPairs();
  }

     
                                                                       
     
  updateAccumulatedBalance(pairId, newBalance, thresholdOverride) {
    const pair = this.getPairById(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);

    const threshold = thresholdOverride !== undefined ? thresholdOverride : pair.threshold;
    let newState = pair.state;

                                                                                   
    if (pair.state !== 'DELIVERING' && pair.state !== 'BUSY') {
      newState = newBalance >= threshold ? 'FREE' : 'BELOW_THRESHOLD';
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE account_pairs SET
        accumulated_balance = ?,
        threshold = ?,
        state = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(newBalance, threshold, newState, now, pairId);

    return this.getPairById(pairId);
  }

     
                                              
     
  lockPair(pairId, orderId) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE account_pairs SET
        state = 'DELIVERING',
        current_order_id = ?,
        locked_at = ?,
        updated_at = ?
      WHERE id = ? AND state = 'FREE'
    `);
    const result = stmt.run(orderId, now, now, pairId);
    return result.changes > 0;
  }

     
                                                                          
     
  releasePair(pairId, remainingBalance) {
    const pair = this.getPairById(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);

    const balance = remainingBalance !== undefined ? Math.max(0, remainingBalance) : pair.accumulatedBalance;
    const newState = balance >= pair.threshold ? 'FREE' : 'BELOW_THRESHOLD';
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE account_pairs SET
        state = ?,
        accumulated_balance = ?,
        current_order_id = NULL,
        locked_at = NULL,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(newState, balance, now, pairId);

    return this.getPairById(pairId);
  }

     
                                                  
     
  getAvailablePair(requiredAmount) {
    const stmt = this.db.prepare(`
      SELECT * FROM account_pairs
      WHERE state = 'FREE' AND accumulated_balance >= ? AND (disabled IS NULL OR disabled = 0)
      ORDER BY accumulated_balance DESC, pair_index ASC
      LIMIT 1
    `);
    const row = stmt.get(requiredAmount);
    return row ? this._mapPairRow(row) : null;
  }

  togglePair(pairId, disabled) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE account_pairs SET
        disabled = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(disabled ? 1 : 0, now, pairId);
    return this.getPairById(pairId);
  }

                                

  saveChatMessage(message) {
    const now = new Date().toISOString();
    const id = message.id || `chat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const stmt = this.db.prepare(`
      INSERT INTO order_chat_messages (id, order_id, sender, message, timestamp, is_automated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      message.orderId,
      message.sender,
      message.message,
      message.timestamp || Date.now(),
      message.isAutomated ? 1 : 0,
      now
    );
    return { id, ...message };
  }

  getChatMessages(orderId) {
    const stmt = this.db.prepare('SELECT * FROM order_chat_messages WHERE order_id = ? ORDER BY timestamp ASC');
    return stmt.all(orderId).map(r => ({
      id: r.id,
      orderId: r.order_id,
      sender: r.sender,
      message: r.message,
      timestamp: r.timestamp,
      isAutomated: r.is_automated === 1,
      createdAt: r.created_at
    }));
  }

                                                  

  updateOrderDeliveryProof(orderId, proofData) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE marketplace_orders SET
        proof_image_path = ?,
        pre_balance = ?,
        post_balance = ?,
        delivery_tx_data = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      proofData.proofImagePath || null,
      proofData.preBalance !== undefined ? proofData.preBalance : null,
      proofData.postBalance !== undefined ? proofData.postBalance : null,
      proofData.deliveryTxData ? (typeof proofData.deliveryTxData === 'string' ? proofData.deliveryTxData : JSON.stringify(proofData.deliveryTxData)) : null,
      now,
      orderId
    );
  }

  updateOrderCancellation(orderId, cancelReason) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE marketplace_orders SET
        state = 'cancelled',
        cancelled_at = ?,
        cancel_reason = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, cancelReason || 'Cancelled by buyer/operator', now, orderId);
  }

  _mapPairRow(row) {
    return {
      id: row.id,
      pairIndex: row.pair_index,
      buyerId: row.buyer_id,
      buyerIgn: row.buyer_ign || '',
      buyerEmail: row.buyer_email || '',
      sellerId: row.seller_id,
      sellerIgn: row.seller_ign || '',
      sellerEmail: row.seller_email || '',
      accumulatedBalance: Number(row.accumulated_balance || 0),
      threshold: Number(row.threshold || 3000000000),
      state: row.state,
      currentOrderId: row.current_order_id,
      lockedAt: row.locked_at,
      disabled: Boolean(row.disabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = PairsRepository;
