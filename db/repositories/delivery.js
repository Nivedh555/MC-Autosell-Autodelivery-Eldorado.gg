'use strict';
const crypto = require('node:crypto');
const {closure, closedStatus, stoppedStates} = require('../../marketplace/order-status');
const terminal = new Set(['DELIVERED', 'TRANSFERRED', 'NEEDS_OPERATOR', 'EXPIRED', 'DRY_RUN', ...stoppedStates]);
class DeliveryRepository {
  constructor(database) {
    if (!database?.raw) throw new Error('Delivery requires the real Database wrapper');
    this.database = database;
    this.db = database.raw();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { return this.db.prepare('SELECT * FROM delivery_orders WHERE id=?').get(String(id)); }
  closedStatus(id) {
    const row = this.db.prepare('SELECT payload FROM marketplace_observations WHERE id=?').get(id);
    if (!row) return null;
    const observation = JSON.parse(row.payload);
    return closedStatus(observation.status, observation.apiStatus);
  }
  applyMarketplaceStatus(id, status) {
    if (!closure(status)) return;
    const reconcile = () => {
      const row = this.get(id);
      const archived = this.db.prepare('SELECT payload,source FROM marketplace_observations WHERE id=?').get(id);
      const payload = archived ? JSON.parse(archived.payload) : {id};
      const remote = closedStatus(status, payload.status, payload.apiStatus);
      this.db.prepare('INSERT INTO marketplace_observations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,last_ms=excluded.last_ms')
        .run(id, JSON.stringify({...payload, status:remote, apiStatus:payload.apiStatus ? remote : undefined}), archived?.source || 'Verified marketplace order status', Date.now(), Date.now());
      this.db.prepare('UPDATE observed_order_holds SET status=?,resolved_ms=? WHERE order_id=? AND resolved_ms IS NULL').run(remote, Date.now(), id);
      if (!row || row.mode==='owner-capture' || JSON.parse(row.payload).kind==='transfer') return;
      if (row.state==='RECONCILIATION_REQUIRED' || (row.state==='DELIVERED' && closure(remote)==='completed')) return;
      const chunks = this.chunks(id);
      const fullyPaid = chunks.length && chunks.every(chunk => chunk.state==='PAY_VERIFIED') &&
        chunks.reduce((total,chunk) => total + BigInt(chunk.amount), 0n) === BigInt(JSON.parse(row.payload).amount);
      const canceled = closure(remote)==='canceled';
      const ackId = 'markDelivered:'+id, browserAckId = 'markDeliveredObserved:'+id;
      const ackEligible = ['ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING','DELIVERED'].includes(row.state);
      const ack = !canceled && fullyPaid && ackEligible && (this.db.prepare('SELECT state FROM seller_api_actions WHERE id=?').get(ackId) ||
        this.db.prepare('SELECT state FROM browser_actions WHERE id=?').get(browserAckId));
      const state = ack ? 'DELIVERED' : chunks.length ? 'RECONCILIATION_REQUIRED' : canceled ? 'CANCELLED' : 'MARKETPLACE_CLOSED';
      if (row.state===state) return;
      const reason = state==='RECONCILIATION_REQUIRED' ? 'Marketplace status '+remote+' after payment intent. Reconcile the recorded payment with Eldorado. Automatic payment, proof and acknowledgement stopped.'
        : state==='DELIVERED' ? 'Verified full payment and marketplace delivery acknowledgement reconciled from '+remote+'.'
        : 'Marketplace reports '+remote+'. Order closed before any local payment.';
      if (ack) {
        const receipt = JSON.stringify({orderId:id,status:remote,source:'Terminal marketplace status readback'});
        this.db.prepare("UPDATE seller_api_actions SET state='CONFIRMED',result=?,reason=NULL,updated_ms=? WHERE id=?").run(receipt,Date.now(),ackId);
        this.db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,reason=NULL,updated_ms=? WHERE id=?").run(receipt,Date.now(),browserAckId);
      }
      if (!chunks.length || fullyPaid) this.release(id);
      this.db.prepare('UPDATE delivery_orders SET state=?,reason=?,next_attempt_ms=0,updated_ms=? WHERE id=?').run(state,reason,Date.now(),id);
      this.event(id,'STATE',{state,reason,remoteStatus:remote,previousState:row.state});
    };
    return this.db.isTransaction ? reconcile() : this.transaction(reconcile);
  }
  recoverMarketplaceClosures() {
    const rows = this.db.prepare(`SELECT d.id,o.payload FROM delivery_orders d JOIN marketplace_observations o ON o.id=d.id
      WHERE d.mode='live' AND d.state NOT IN ('TRANSFERRED','DRY_RUN','EXPIRED','CANCELLED','MARKETPLACE_CLOSED','RECONCILIATION_REQUIRED')`).all();
    for (const row of rows) {
      const observation=JSON.parse(row.payload), status=closedStatus(observation.status,observation.apiStatus);
      if(status && !(closure(status)==='completed' && this.get(row.id).state==='DELIVERED')) this.applyMarketplaceStatus(row.id,status);
    }
  }
  event(id, kind, data = {}) {
    this.db.prepare('INSERT INTO delivery_events(order_id,kind,data,wall_ms,monotonic_ns) VALUES(?,?,?,?,?)')
      .run(id, kind, JSON.stringify(data), Date.now(), process.hrtime.bigint().toString());
    require('../../marketplace/customer-message-config').recordDeliveryEvent(this.db,id,kind,data);
  }
  observe(order, mode) {
    if (typeof order.id !== 'string' || !order.id || order.id.length > 200) throw new Error('Invalid order identifier');
    const payload = JSON.stringify({ id: order.id, buyerIgn: order.buyerIgn, amount: order.amount, unitSize: order.unitSize, offerId: order.offerId, gameId: order.gameId, serverId: order.serverId, buyerMarketplaceId:order.buyerMarketplaceId });
    const fingerprint = crypto.createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      const existing = this.get(order.id);
      if (existing) {
        if (!terminal.has(existing.state) && (existing.fingerprint !== fingerprint || existing.mode !== mode)) {
          this.state(order.id, 'NEEDS_OPERATOR', 'Order identity/amount/units or execution mode changed on re-ingestion');
        }
        return this.get(order.id);
      }
      this.db.prepare('INSERT INTO delivery_orders(id,fingerprint,payload,state,mode,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?)')
        .run(order.id, fingerprint, JSON.stringify(order), 'DETECTED', mode, Date.now(), Date.now());
      this.event(order.id, 'DETECTED', { mode });
      return this.get(order.id);
    });
  }
  state(id, state, reason = null) {
    const current = this.get(id);
    if(current?.state==='DELIVERED'){
      if(state==='DELIVERED')return;
      if(state!=='NEEDS_OPERATOR')throw Error('Completed order cannot resume automatic delivery');
    }
    if (stoppedStates.has(current?.state) && state!==current.state) throw Error('Marketplace closed this order. Automatic transitions are forbidden.');
    if (current?.state === 'NEEDS_OPERATOR' && state !== 'NEEDS_OPERATOR') throw new Error('Operator hold is latched; automatic transitions are forbidden');
    this.db.prepare('UPDATE delivery_orders SET state=?,reason=?,updated_ms=? WHERE id=?').run(state, reason, Date.now(), id);
    this.event(id, 'STATE', { state, reason });
  }
  lock(id, account, owner, amount, balance) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(account)) return false;
      if (this.db.prepare("SELECT 1 FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get(account)) return false;
      this.db.prepare('INSERT INTO delivery_account_locks VALUES(?,?,?,?,?,?)').run(account, id, owner, String(amount), String(balance), Date.now());
      this.db.prepare('UPDATE delivery_orders SET account_id=? WHERE id=?').run(account, id);
      this.state(id, 'RESERVED');
      return true;
    });
  }
  release(id) { this.db.prepare('DELETE FROM delivery_account_locks WHERE order_id=?').run(id); }
  resumeConfirmedOpening(id,messageId) {
    return this.transaction(()=>{
      const row=this.get(id),message=this.db.prepare('SELECT * FROM buyer_messages WHERE id=?').get(messageId);
      if(row?.state!=='NEEDS_OPERATOR'||!/^Step opening_message:/.test(row.reason||'')||!row.reason.includes('No payment command was issued for this order.')||this.chunks(id).length||
        message?.order_id!==id||message.intent!=='opening'||message.direction!=='out'||message.source!=='local-rule-engine'||message.state!=='browser-confirmed-sent')return false;
      this.release(id);
      this.db.prepare("UPDATE delivery_orders SET state='VALIDATED',reason=NULL,next_attempt_ms=0,updated_ms=? WHERE id=?").run(Date.now(),id);
      this.event(id,'OPENING_RECOVERED',{messageId,previousReason:row.reason,reason:'Greeting confirmed; no payment intent exists. Fresh delivery checks may resume.'});
      return true;
    });
  }
  claim(id, owner) { return Boolean(this.db.prepare('INSERT OR IGNORE INTO delivery_order_claims VALUES(?,?)').run(id, owner).changes); }
  unclaim(id, owner) { this.db.prepare('DELETE FROM delivery_order_claims WHERE order_id=? AND owner=?').run(id, owner); }
  chunks(id) { return this.db.prepare('SELECT * FROM delivery_chunks WHERE order_id=? ORDER BY chunk_index').all(id); }
  recoverListingHolds() {
    const rows=this.db.prepare("SELECT * FROM delivery_orders WHERE mode='live' AND state='NEEDS_OPERATOR' AND (reason LIKE 'Step pause_listing:%No payment command was issued for this order.' OR reason='The selected seller browser is disconnected No payment command was issued for this order.' OR reason='Step lease: Session manager is shutting down No payment command was issued for this order.')").all();
    for(const row of rows){
      const order=JSON.parse(row.payload);
      if(!order.hybridWorkflow||this.chunks(row.id).length||this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE order_id=?').get(row.id)||this.db.prepare('SELECT 1 FROM delivery_order_claims WHERE order_id=?').get(row.id))continue;
      this.transaction(()=>{
        this.db.prepare("UPDATE delivery_orders SET state='VALIDATED',reason=NULL,next_attempt_ms=0,updated_ms=? WHERE id=? AND state='NEEDS_OPERATOR'").run(Date.now(),row.id);
        this.event(row.id,'PRE_PAYMENT_LISTING_RECOVERED',{previousReason:row.reason,reason:'No payment intent or account lock exists. Recheck order, buyer confirmation and funded stock before delivery.'});
      });
    }
  }
  correctUnpaidRecipient(order) {
    return this.transaction(()=>{
      const row=this.get(order.id);
      if(row?.state!=='NEEDS_OPERATOR'||row.reason!=='Buyer changed their recipient or confirmation before payment No payment command was issued for this order.'||this.chunks(order.id).length||this.db.prepare('SELECT 1 FROM delivery_account_locks WHERE order_id=?').get(order.id)||this.db.prepare('SELECT 1 FROM delivery_order_claims WHERE order_id=?').get(order.id))return false;
      const previous=JSON.parse(row.payload);
      if(!previous.hybridWorkflow||['id','amount','unitSize','offerId','gameId','serverId','buyerMarketplaceId'].some(key=>previous[key]!==order[key]))return false;
      const identity=JSON.stringify({id:order.id,buyerIgn:order.buyerIgn,amount:order.amount,unitSize:order.unitSize,offerId:order.offerId,gameId:order.gameId,serverId:order.serverId,buyerMarketplaceId:order.buyerMarketplaceId});
      this.db.prepare("UPDATE delivery_orders SET fingerprint=?,payload=?,state='VALIDATED',reason=NULL,next_attempt_ms=0,updated_ms=? WHERE id=?").run(crypto.createHash('sha256').update(identity).digest('hex'),JSON.stringify(order),Date.now(),order.id);
      this.event(order.id,'UNPAID_RECIPIENT_CORRECTED',{previousIgn:previous.buyerIgn,confirmedIgn:order.buyerIgn,reason:'Fresh funded order and buyer confirmation; no payment attempt exists.'});
      return true;
    });
  }
  recoverCompletionHolds() {
    const rows=this.db.prepare("SELECT * FROM delivery_orders WHERE mode='live' AND state='NEEDS_OPERATOR' AND (reason LIKE 'Step evidence:%' OR reason='Marketplace acknowledgement deadline exceeded; all payments already verified')").all();
    for(const row of rows){
      const chunks=this.chunks(row.id),order=JSON.parse(row.payload);
      if(!chunks.length||chunks.some(chunk=>chunk.state!=='PAY_VERIFIED')||chunks.reduce((sum,chunk)=>sum+BigInt(chunk.amount),0n)!==BigInt(order.amount))continue;
      this.transaction(()=>{
        this.release(row.id);
        this.db.prepare("UPDATE delivery_orders SET state=?,reason=NULL,next_attempt_ms=0,updated_ms=? WHERE id=? AND state='NEEDS_OPERATOR'").run(row.evidence?'EVIDENCE_BUILT':'ALL_VERIFIED',Date.now(),row.id);
        this.event(row.id,'COMPLETION_RECOVERED',{previousReason:row.reason,reason:'Full payment verified; resume proof and acknowledgement only.'});
      });
    }
  }
  intent(id, index, chunk, before) {
    this.transaction(() => {
      if (terminal.has(this.get(id)?.state)) throw new Error('Order is terminal; no payment intent permitted');
      this.db.prepare('INSERT INTO delivery_chunks(order_id,chunk_index,amount,command_amount,debit,state,before_balance,idempotency_key) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, index, String(chunk.net), String(chunk.command), String(chunk.debit), 'PAY_INTENT', String(before), `${id}:${index}`);
      this.state(id, 'PAY_INTENT');
    });
  }
  sent(id, index) {
    this.db.prepare("UPDATE delivery_chunks SET state='PAY_SENT' WHERE order_id=? AND chunk_index=?").run(id, index);
    if (!stoppedStates.has(this.get(id)?.state)) this.state(id, 'PAY_SENT');
  }
  verify(id, index, result, ledger, account, onVerified) {
    this.transaction(() => {
      const chunk = this.chunks(id)[index];
      if (!chunk || chunk.state !== 'PAY_SENT') throw new Error('Chunk has no recorded send');
      this.db.prepare("UPDATE delivery_chunks SET state='PAY_VERIFIED',after_balance=?,result=? WHERE order_id=? AND chunk_index=?")
        .run(String(result.after), JSON.stringify(result), id, index);
      ledger?.append({ idempotencyKey: `delivery:${id}:${index}`, entryType: 'delivery', currency: 'donut', amount: Number(chunk.debit), referenceType: 'marketplace_order', referenceId: id, accountId: account, metadata: { recipientAmount: chunk.amount, mode: this.get(id).mode } });
      onVerified?.(chunk);
      // The server can confirm an in-flight debit after Eldorado canceled the order.
      // Keep the evidence and ledger entry without reopening the delivery.
      const delivery=this.get(id);
      if (!stoppedStates.has(delivery.state)) this.state(id, 'PAY_VERIFIED');
      else {
        const chunks=this.chunks(id);
        if(chunks.every(item=>item.state==='PAY_VERIFIED') &&
          chunks.reduce((sum,item)=>sum+BigInt(item.amount),0n)===BigInt(JSON.parse(delivery.payload).amount))this.release(id);
      }
    });
  }
  history(id) { return this.db.prepare('SELECT * FROM delivery_events WHERE order_id=? ORDER BY sequence').all(id); }
  awaitingScreenshot(account,id){
    return this.db.prepare("SELECT d.id FROM delivery_orders d WHERE d.account_id=? AND d.id!=? AND d.state='ALL_VERIFIED' AND d.evidence IS NULL AND NOT EXISTS(SELECT 1 FROM delivery_events e WHERE e.order_id=d.id AND e.kind='SCREENSHOT') LIMIT 1").get(account,id);
  }
  recover() {
    this.recoverMarketplaceClosures();
                                                                                                
    const rows = this.db.prepare("SELECT * FROM delivery_orders WHERE state IN ('RESERVED','SESSION_READY','PAY_INTENT','PAY_SENT','PAY_VERIFIED','CANCEL_INTENT') OR (mode='owner-capture' AND state IN ('DETECTED','VALIDATED'))").all();
    for (const row of rows) {
      const chunks=this.chunks(row.id),order=JSON.parse(row.payload);
      if(row.mode!=='owner-capture'&&row.state==='PAY_VERIFIED'&&chunks.length&&chunks.every(c=>c.state==='PAY_VERIFIED')&&chunks.reduce((sum,c)=>sum+BigInt(c.amount),0n)===BigInt(order.amount)){
        this.transaction(()=>{this.release(row.id);this.state(row.id,'ALL_VERIFIED','Restart after full verified payment; resume evidence only.');this.event(row.id,'COMPLETION_RECOVERED',{previousState:row.state,paymentRepeated:false});});
      }else if(row.mode!=='owner-capture'&&['RESERVED','SESSION_READY'].includes(row.state)&&!chunks.length){
        this.transaction(()=>{this.release(row.id);this.state(row.id,'VALIDATED','Restart before any payment intent; fresh order and balance checks will run again.');});
      }else this.state(row.id, 'NEEDS_OPERATOR', `Restart during ${row.state}; reconcile captures and both balances before any further payment. Account remains locked.`);
    }
    this.db.prepare('DELETE FROM delivery_order_claims').run();
    return rows.length;
  }
  pending() { return this.db.prepare("SELECT * FROM delivery_orders WHERE mode!='owner-capture' AND state IN ('DETECTED','VALIDATED','ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING') AND next_attempt_ms<=? ORDER BY created_ms").all(Date.now()); }
}
module.exports = { DeliveryRepository, terminal };
