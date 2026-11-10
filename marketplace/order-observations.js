'use strict';
class OrderObservations {
  constructor(database) { this.db = database.raw(); this.repo = new (require('../db/repositories/delivery').DeliveryRepository)(database); }
  recordReference(order, reference) {
    if(reference.id!==order.id||reference.referenceOnly!==true||reference.executionEligible!==false||reference.paymentsSent!==0||reference.messagesSent!==0)throw Error('Only a matching read-only order reference may be archived.');
    if(!Array.isArray(reference.messages)||reference.messages.length>500)throw Error('Captured reference message list is invalid.');
    for(const message of reference.messages)if(!/^local:[a-f0-9]{64}$/.test(message.id)||message.moneyActionsAllowed!==false||typeof message.text!=='string'||message.text.length>4000)throw Error('Captured room message lacks a bounded local observation identity.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO browser_observations(id,url,data,created_ms,source) VALUES(?,?,?,?,?)').run(require('node:crypto').randomUUID(),order.orderUrl,JSON.stringify(reference),Date.now(),'captured order reference');
      const recipient=require('./ign-rules').recipientCandidates(reference.messages);
      this.observe({...order,status:reference.status||order.status,buyerIgn:recipient.latest&&!recipient.requiresClarification?recipient.latest.ign:null,orderReference:reference,orderReferenceError:null},order.source);
      for(const message of reference.messages)this.db.prepare("INSERT OR IGNORE INTO buyer_messages(id,order_id,direction,source,text,intent,state,created_ms,due_ms) VALUES(?,?,?,?,?,'reference','captured-reference',?,?)").run(message.id,order.id,message.peer?'in':'out','browser-observed-room; author not captured',message.text,Date.now(),Date.now());
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  annotate(id,details){
    const row=this.db.prepare('SELECT payload,source FROM marketplace_observations WHERE id=?').get(id);
    if(row)this.observe({...JSON.parse(row.payload),...details},row.source);
  }
  observe(order, source = 'captured marketplace response') {
    if (typeof order.id !== 'string' || !order.id || order.id.length > 200) throw Error('Captured order identifier is missing or invalid');
    if (order.orderUrl) {
      const existing = this.db.prepare('SELECT id FROM marketplace_observations WHERE json_extract(payload,\'$.orderUrl\')=? AND id NOT LIKE \'visible:%\'').get(order.orderUrl);
      if (order.id.startsWith('visible:') && existing) order={...order,id:existing.id};
      if (!order.id.startsWith('visible:')) this.db.prepare("DELETE FROM marketplace_observations WHERE id LIKE 'visible:%' AND json_extract(payload,'$.orderUrl')=?").run(order.orderUrl);
    }
    const prior=this.db.prepare('SELECT payload FROM marketplace_observations WHERE id=?').get(order.id);
    const saved=prior ? JSON.parse(prior.payload) : {};
    for(const key of ['orderReference','orderReferenceError','routingReason','chatReason','buyerIgn'])if(order[key]===undefined&&saved[key]!==undefined)order={...order,[key]:saved[key]};
    const closed=require('./order-status').closedStatus(order.status,order.apiStatus,saved.status,saved.apiStatus);
    if(closed)order={...order,status:closed,apiStatus:order.apiStatus||saved.apiStatus ? closed : undefined};
    const persist=()=>{
      this.db.prepare(`INSERT INTO marketplace_observations VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,source=excluded.source,last_ms=excluded.last_ms`)
        .run(order.id, JSON.stringify(order), source, Date.now(), Date.now());
      if(closed)this.repo.applyMarketplaceStatus(order.id,closed);
    };
    if(closed&&!this.db.isTransaction)this.repo.transaction(persist);
    else persist();
  }
  list() {
    const rows = this.db.prepare(`SELECT o.id,o.payload observed,o.source,o.first_ms,o.last_ms,
      d.state,d.reason,d.mode,d.account_id,d.created_ms,d.updated_ms,d.evidence,d.payload delivery
      FROM marketplace_observations o LEFT JOIN delivery_orders d ON d.id=o.id
      UNION ALL SELECT d.id,NULL,NULL,d.created_ms,d.updated_ms,d.state,d.reason,d.mode,
      d.account_id,d.created_ms,d.updated_ms,d.evidence,d.payload FROM delivery_orders d
      WHERE NOT EXISTS(SELECT 1 FROM marketplace_observations o WHERE o.id=d.id) ORDER BY last_ms DESC`).all();
    const holds=new Map(this.db.prepare('SELECT * FROM observed_order_holds WHERE resolved_ms IS NULL').all().map(row=>[row.order_id,row]));
    const ownerHolds=new Map(this.db.prepare('SELECT * FROM owner_delivery_holds WHERE released_ms IS NULL').all().map(row=>[row.order_id,row]));
    return rows.map(({ observed, delivery, evidence, ...row }) => {
      const captured = observed ? JSON.parse(observed) : {}, execution = delivery ? JSON.parse(delivery) : {};
      return { ...captured, ...execution, ...row, account_id:row.account_id||holds.get(row.id)?.account_id||null, marketplaceStatus: captured.status ?? null,
        deliveryState: row.state || null, state: row.state || captured.status || 'not captured',
        executionRecorded: Boolean(delivery), evidence: Boolean(evidence),
        detectionState:holds.has(row.id)?'DETAILS_NEEDED':null,detectionReason:captured.chatReason||captured.orderReferenceError||captured.routingReason||holds.get(row.id)?.reason||null,
        ownerDeliveryHold:ownerHolds.get(row.id)?.reason||null };
    });
  }
}
module.exports = { OrderObservations };
