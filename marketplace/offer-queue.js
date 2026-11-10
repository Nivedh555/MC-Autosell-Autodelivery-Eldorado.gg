'use strict';
const { integer } = require('../minecraft/verified-payments');
                                                                              
                                                                                  
class OfferQueue {
  constructor(database) { this.db = database.raw(); this.tail = Promise.resolve(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value=fn();this.db.exec('COMMIT');return value; }
    catch(error) { this.db.exec('ROLLBACK');throw error; }
  }
  exclusive(fn) { const work = this.tail.then(fn); this.tail = work.catch(() => {}); return work; }
  active(offer) { return typeof offer === 'string' && offer ? this.db.prepare('SELECT * FROM offer_turns WHERE offer_id=?').get(offer) : null; }
  waiting(offer) { return typeof offer === 'string' && offer ? this.db.prepare('SELECT * FROM offer_waiting WHERE offer_id=? ORDER BY sequence').all(offer) : []; }
  observe(offer, account, balance, threshold, observedMs = Date.now()) {
    if (integer(balance) < integer(threshold)) {
      this.db.prepare('DELETE FROM offer_waiting WHERE offer_id=? AND account_id=?').run(offer, account); return;
    }
    this.db.prepare(`INSERT INTO offer_waiting(offer_id,account_id,balance,observed_ms) VALUES(?,?,?,?)
      ON CONFLICT(offer_id,account_id) DO UPDATE SET balance=excluded.balance,observed_ms=excluded.observed_ms`)
      .run(offer, account, String(balance), observedMs);
  }
  unresolved(offer) {
                                                                              
                                                                                
    const journal=this.db.prepare(`SELECT id,account_id,state,payload FROM delivery_orders
      WHERE ${require('./listing-reservations').reservesStockSql}`)
      .all().filter(row => {
        const payload = JSON.parse(row.payload);
        return payload.kind !== 'transfer' && payload.offerId === offer;
      }).map(({payload,...row})=>row);
    const captured=this.db.prepare(`SELECT h.order_id id,h.account_id,'DETAILS_NEEDED' state
      FROM observed_order_holds h LEFT JOIN delivery_orders d ON d.id=h.order_id
      WHERE h.offer_id=? AND h.resolved_ms IS NULL AND d.id IS NULL`).all(offer);
    return [...journal,...captured];
  }
  select(offer, accounts, freshnessMs = 60000) {
    return this.transaction(()=>this.selectLocked(offer,accounts,freshnessMs));
  }
  selectLocked(offer, accounts, freshnessMs) {
    const eligible = new Set(accounts), current = this.active(offer);
    if (current?.account_id) return current.account_id;                       
    if (this.unresolved(offer).length) return null;
    const next = this.waiting(offer).find(row => eligible.has(row.account_id) && Date.now() - row.observed_ms <= freshnessMs);
    if (!next) return null;
    this.db.prepare(`INSERT INTO offer_turns(offer_id,account_id,activated_ms,reason,completed) VALUES(?,?,?,NULL,0)
      ON CONFLICT(offer_id) DO UPDATE SET account_id=excluded.account_id,activated_ms=excluded.activated_ms,reason=NULL,completed=0`)
      .run(offer, next.account_id, Date.now());
    return next.account_id;
  }
  release(offer, account, reason) {
    return this.transaction(()=>this.releaseLocked(offer,account,reason));
  }
  releaseLocked(offer, account, reason) {
    if (this.active(offer)?.account_id !== account) return false;
    if (this.unresolved(offer).length) return false;
                                                                               
                                                                            
    this.db.prepare('DELETE FROM offer_waiting WHERE offer_id=? AND account_id=?').run(offer, account);
    this.db.prepare('UPDATE offer_turns SET account_id=NULL,reason=?,completed=0 WHERE offer_id=? AND account_id=?').run(reason, offer, account);
    return true;
  }
  completed(offer, account) { this.db.prepare('UPDATE offer_turns SET completed=1 WHERE offer_id=? AND account_id=?').run(offer,account); }
  assign(orderId, offer) {
    return this.transaction(()=>this.assignLocked(orderId,offer));
  }
  assignLocked(orderId, offer) {
    const account = this.active(offer)?.account_id;
    if (!account) throw Error('This funded order has no active pair assignment. Review it before sending coins.');
    const row = this.db.prepare('SELECT account_id FROM delivery_orders WHERE id=?').get(orderId);
    if (!row) throw Error('Order assignment requires an existing persisted delivery record.');
    if (row?.account_id && row.account_id !== account) throw Error('The recorded order belongs to a different pair; it cannot be reassigned.');
    this.db.prepare('UPDATE delivery_orders SET account_id=? WHERE id=? AND account_id IS NULL').run(account, orderId);
    return account;
  }
}
module.exports = { OfferQueue };
