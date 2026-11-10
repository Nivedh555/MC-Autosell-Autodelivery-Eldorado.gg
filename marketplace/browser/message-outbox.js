'use strict';
const {randomUUID} = require('node:crypto');

function logicalKey(orderId, operation, request) {
  if (operation === 'sendMessageObserved') {
    if (!request.messageId) return null;
    for (const [prefix, key] of [['v3-completion','completion-text'],['customer-proof','proof-text'],['customer-sending','sending-text']]) {
      const base = prefix + ':' + orderId;
      if (request.messageId === base || request.messageId.startsWith(base + ':')) return key;
    }
    return 'text:' + request.messageId;
  }
  if (operation !== 'uploadEvidenceObserved' || !request.name) return null;
  if (/^(?:receipt-|delivery-).*\.png$|^delivery\.(?:png|txt)$|^delivery-logs\.txt$/i.test(request.name)) return 'payment-evidence';
  if (['minecraft-ign-guide.png','which-name.jpg'].includes(request.name)) return 'username-guide';
  if (/^how-to-confirm(?:-1)?\.png$/.test(request.name)) return 'confirm-guide';
  if (request.name === 'how-to-confirm-2.png') return 'feedback-guide';
  return 'attachment:' + request.name;
}

function adoptActions(db, orderId) {
  const filter = orderId === undefined ? '' : ' AND resource_id=?';
  const rows = db.prepare(`SELECT id,resource_id,operation,request,state,updated_ms,reason FROM browser_actions
    WHERE operation IN ('sendMessageObserved','uploadEvidenceObserved')${filter}
    ORDER BY (state='CONFIRMED') DESC, updated_ms DESC`).all(...(orderId === undefined ? [] : [orderId]));
  const insert = db.prepare(`INSERT OR IGNORE INTO message_outbox
    (order_id,logical_key,action_id,state,submission_started,reason,updated_ms) VALUES(?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const key = logicalKey(row.resource_id,row.operation,JSON.parse(row.request));
    if (!key) continue;
    // Legacy rows lacked a dispatch marker. Only this specific validation failure
    // was recorded strictly before any send activation.
    const safe = row.reason === 'The typed reply differs from the persisted reply; nothing was submitted.';
    const state = row.state === 'CONFIRMED' ? 'SENT' : safe ? 'FAILED' : 'UNKNOWN';
    insert.run(row.resource_id,key,row.id,state,safe ? 0 : 1,row.reason,row.updated_ms);
  }
}

function recover(db) {
  // Called once at boot with the backend instance lock held, before any workers start.
  adoptActions(db);
  db.prepare(`UPDATE message_outbox SET state=CASE WHEN submission_started=1 THEN 'UNKNOWN' ELSE 'FAILED' END,
    owner=NULL, next_check_ms=0, updated_ms=?, reason='Backend stopped during chat operation'
    WHERE state='SENDING'`).run(Date.now());
  db.prepare(`UPDATE message_outbox SET state='SENT',owner=NULL,reason=NULL,next_check_ms=0
    WHERE state!='SENT' AND action_id IN (SELECT id FROM browser_actions WHERE state='CONFIRMED')`).run();
}

class MessageOutbox {
  constructor(db, orderId, operation, request, proposedId) {
    this.db=db;
    this.orderId=orderId;
    this.key=logicalKey(orderId,operation,request);
    if (!this.key) throw Error('Order message needs a stable identity');
    this.owner=randomUUID();
    this.proposedId=proposedId;
  }

  claim() {
    const db=this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const get=db.prepare('SELECT * FROM message_outbox WHERE order_id=? AND logical_key=?');
      if (!get.get(this.orderId,this.key)) {
        adoptActions(db,this.orderId);
        db.prepare(`INSERT OR IGNORE INTO message_outbox(order_id,logical_key,action_id,state,updated_ms)
          VALUES(?,?,?,'PENDING',?)`).run(this.orderId,this.key,this.proposedId,Date.now());
      }
      const row=get.get(this.orderId,this.key);
      const physical=db.prepare('SELECT * FROM browser_actions WHERE id=?').get(row.action_id);
      if (row.state==='SENT' || physical?.state==='CONFIRMED') {
        if (!physical?.result) throw Error('Saved send receipt is missing. Review this order before proceeding.');
        const result=JSON.parse(physical.result);
        db.prepare("UPDATE message_outbox SET state='SENT',owner=NULL,reason=NULL,next_check_ms=0 WHERE action_id=?").run(row.action_id);
        db.exec('COMMIT');
        return {sent:true,result};
      }
      if (row.next_check_ms>Date.now()) throw Error('Previous chat submission is awaiting read-only reconciliation.');
      // Once a submit might have happened, reconcile that exact logical message
      // before sending any subsequent text or image to the same customer.
      if (!row.submission_started && db.prepare("SELECT 1 FROM message_outbox WHERE order_id=? AND state='UNKNOWN' LIMIT 1").get(this.orderId))
        throw Error('An earlier customer message has an uncertain outcome. Reconcile it before the next send.');
      const claimed=db.prepare(`UPDATE message_outbox SET state='SENDING',owner=?,updated_ms=?
        WHERE action_id=? AND state IN ('PENDING','FAILED','UNKNOWN')
        AND NOT EXISTS(SELECT 1 FROM message_outbox WHERE order_id=? AND state='SENDING')`)
        .run(this.owner,Date.now(),row.action_id,this.orderId);
      if (!claimed.changes) throw Error('Another sender is working in this order conversation.');
      db.exec('COMMIT');
      this.id=row.action_id;
      return {sent:false,reconcile:Boolean(row.submission_started),physical};
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }

  stage(operation,fingerprint,request) {
    const before=this.db.prepare("SELECT 1 FROM message_outbox WHERE action_id=? AND owner=? AND state='SENDING' AND submission_started=0").get(this.id,this.owner);
    if (!before) throw Error('Chat submission claim changed; no browser action allowed.');
    this.db.prepare(`INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,created_ms,updated_ms)
      VALUES(?,?,?,?,'INTENT',?,?,?) ON CONFLICT(id) DO UPDATE SET request=excluded.request,
      fingerprint=excluded.fingerprint,state='INTENT',reason=NULL,updated_ms=excluded.updated_ms`)
      .run(this.id,operation,this.orderId,fingerprint,JSON.stringify(request),Date.now(),Date.now());
  }

  dispatch() {
    const changed=this.db.prepare(`UPDATE message_outbox SET submission_started=1,updated_ms=?
      WHERE action_id=? AND owner=? AND state='SENDING' AND submission_started=0`).run(Date.now(),this.id,this.owner);
    if (!changed.changes) throw Error('Chat submission was already started; reconcile the saved receipt.');
  }

  finish(result) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved=this.db.prepare(`UPDATE message_outbox SET state='SENT',owner=NULL,reason=NULL,next_check_ms=0,updated_ms=?
        WHERE action_id=? AND owner=? AND state='SENDING'`).run(Date.now(),this.id,this.owner);
      if (!saved.changes) throw Error('Chat receipt lost its owning claim.');
      const recorded=this.db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,reason=NULL,updated_ms=? WHERE id=?").run(JSON.stringify(result),Date.now(),this.id);
      if (!recorded.changes) throw Error('Cannot confirm a chat receipt without its durable request.');
      this.db.exec('COMMIT');
      return result;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }

  failed(error) {
    const row=this.db.prepare("SELECT * FROM message_outbox WHERE action_id=? AND owner=? AND state='SENDING'").get(this.id,this.owner);
    if (!row) return;
    const reason=String(error.message).slice(0,450);
    const state=row.submission_started?'UNKNOWN':'FAILED';
    const delay=row.submission_started?Math.min(300000,5000*2**Math.min(row.checks,6)):0;
    this.db.prepare(`UPDATE message_outbox SET state=?,owner=NULL,reason=?,checks=checks+1,next_check_ms=?,updated_ms=?
      WHERE action_id=? AND owner=?`).run(state,reason,Date.now()+delay,Date.now(),this.id,this.owner);
    this.db.prepare("UPDATE browser_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=? AND state!='CONFIRMED'").run(reason,Date.now(),this.id);
  }
}
module.exports={MessageOutbox,logicalKey,recover};
