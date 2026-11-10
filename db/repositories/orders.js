'use strict';

class OrdersRepository {
  constructor(db) {
    this.db = db;
  }

  saveOrder(order) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO orders(id,seller_discord_id,status,count,payout,created_at,updated_at,details)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      seller_discord_id=excluded.seller_discord_id,status=excluded.status,count=excluded.count,
      payout=excluded.payout,updated_at=excluded.updated_at,details=excluded.details`)
      .run(order.id,order.sellerDiscordId,order.status,order.count||0,
        order.payout ? JSON.stringify(order.payout) : null,order.createdAt||now,now,JSON.stringify(order));
  }

  getOrder(id) {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._mapRow(row) : null;
  }

  getAllOrders() {
    const stmt = this.db.prepare('SELECT * FROM orders');
    return stmt.all().map(r => this._mapRow(r));
  }

  _mapRow(row) {
    return {
      ...JSON.parse(row.details || '{}'),
      id: row.id,
      sellerDiscordId: row.seller_discord_id,
      status: row.status,
      count: row.count,
      payout: row.payout ? JSON.parse(row.payout) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = OrdersRepository;
