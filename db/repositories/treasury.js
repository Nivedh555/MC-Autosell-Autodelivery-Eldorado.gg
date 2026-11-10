'use strict';

class TreasuryRepository {
  constructor(db) {
    this.db = db;
  }

                      

  createTransfer(transfer) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO transfers (id, from_account, to_account, amount, state, chunks_sent, chunks_total, ledger_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      transfer.id,
      transfer.fromAccount,
      transfer.toAccount,
      transfer.amount,
      transfer.state,
      transfer.chunksSent || 0,
      transfer.chunksTotal || 0,
      transfer.ledgerIds ? JSON.stringify(transfer.ledgerIds) : '[]',
      transfer.createdAt || now,
      now
    );
    
    return this.getTransfer(transfer.id);
  }

  updateTransfer(id, updates) {
    const now = new Date().toISOString();
    const sets = [];
    const values = [];
    
    const fields = {
      state: 'state',
      chunksSent: 'chunks_sent',
      chunksTotal: 'chunks_total',
      ledgerIds: 'ledger_ids'
    };

    for (const [key, col] of Object.entries(fields)) {
      if (updates[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(key === 'ledgerIds' ? JSON.stringify(updates[key]) : updates[key]);
      }
    }

    if (sets.length === 0) return this.getTransfer(id);

    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = this.db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getTransfer(id);
  }

  getTransfer(id) {
    const stmt = this.db.prepare('SELECT * FROM transfers WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapTransferRow(row) : null;
  }

  getPendingTransfers() {
    const stmt = this.db.prepare('SELECT * FROM transfers WHERE state IN (?, ?, ?)');
    return stmt.all('PENDING', 'SENT', 'STUCK').map(r => this._mapTransferRow(r));
  }

  _mapTransferRow(row) {
    return {
      id: row.id,
      fromAccount: row.from_account,
      toAccount: row.to_account,
      amount: row.amount,
      state: row.state,
      chunksSent: row.chunks_sent,
      chunksTotal: row.chunks_total,
      ledgerIds: row.ledger_ids ? JSON.parse(row.ledger_ids) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

                               

  createMarketplaceOrder(order) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO marketplace_orders (id, external_id, offer_id, buyer_ign, amount, price, state, delivery_tx_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      order.id,
      order.externalId,
      order.offerId,
      order.buyerIgn,
      order.amount,
      order.price,
      order.state,
      order.deliveryTxIds ? JSON.stringify(order.deliveryTxIds) : '[]',
      order.createdAt || now,
      now
    );
    
    return this.getMarketplaceOrder(order.id);
  }

  updateMarketplaceOrder(id, updates) {
    const now = new Date().toISOString();
    const sets = [];
    const values = [];
    
    const fields = {
      state: 'state',
      deliveryTxIds: 'delivery_tx_ids'
    };

    for (const [key, col] of Object.entries(fields)) {
      if (updates[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(key === 'deliveryTxIds' ? JSON.stringify(updates[key]) : updates[key]);
      }
    }

    if (sets.length === 0) return this.getMarketplaceOrder(id);

    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = this.db.prepare(`UPDATE marketplace_orders SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getMarketplaceOrder(id);
  }

  getMarketplaceOrder(id) {
    const stmt = this.db.prepare('SELECT * FROM marketplace_orders WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapMarketplaceOrderRow(row) : null;
  }

  _mapMarketplaceOrderRow(row) {
    return {
      id: row.id,
      externalId: row.external_id,
      offerId: row.offer_id,
      buyerIgn: row.buyer_ign,
      amount: row.amount,
      price: row.price,
      state: row.state,
      deliveryTxIds: row.delivery_tx_ids ? JSON.parse(row.delivery_tx_ids) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = TreasuryRepository;
