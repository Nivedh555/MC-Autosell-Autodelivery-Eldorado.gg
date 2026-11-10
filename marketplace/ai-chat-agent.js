'use strict';
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const services = require('../services');
const { classify, rules, templates } = require('./chat-rules');
const PREPAY = new Set(['DETECTED', 'VALIDATED', 'RESERVED', 'SESSION_READY']);
const dishonestClaim = /i(?:'m| am) (?:a )?human|not (?:a )?(?:bot|automated)|official proof|(?:attached|uploaded|included|sent).{0,30}(?:pic(?:ture)?|screenshot|attachment|proof)/i;
function validateOpening(reply) {
  if (typeof reply !== 'string' || !reply.trim() || reply.length > 500 || dishonestClaim.test(reply)) throw new Error('Use a first message of 1–500 characters. Avoid human-identity claims and do not claim an attachment was sent before its upload is confirmed.');
  return reply.trim();
}
class AiChatAgent extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; }
  get services() { return this.options.services || services; }
  get repo() { return this.options.repo || services.deliveryService?.repo; }
  get db() { return this.options.db?.raw() || services.db?.raw(); }
  async settings() {
    try { return await this.services.settings?.get('eldorado.chat.local') || {}; } catch { return {}; }
  }
  save(orderId, text, direction, intent, source, dueMs = Date.now(), id = crypto.randomUUID()) {
    if (!this.db) return null;
    this.db.prepare('INSERT OR IGNORE INTO buyer_messages(id,order_id,direction,source,text,intent,state,created_ms,due_ms) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, orderId, direction, source, text, intent, direction === 'in' ? 'received' : 'draft', Date.now(), dueMs);
    return id;
  }
  transcript(orderId) { return this.db ? this.db.prepare('SELECT * FROM buyer_messages WHERE order_id=? ORDER BY created_ms,rowid').all(orderId) : []; }
  async handleBuyerMessage(context) {
    const { orderId, message } = context;
    const raw = String(message || '').trim();
    if (!raw || raw.length > 4000) return { handled: false, action: 'invalid', reply: '' };
    const config = await this.settings();
    const row = this.repo?.get(orderId);
    const recorded=row?JSON.parse(row.payload):{};
    const automatic=Boolean(row?.conversationOnly||recorded.browserWorkflow);
    const result = classify(raw, config.rules || rules, {expectIgn:Boolean(automatic||row&&(PREPAY.has(row.state)||row.state==='WAITING_FOR_IGN')&&!recorded.buyerIgn),dashToUnderscore:config.dashToUnderscore!==false});
    if (context.messageId && this.db?.prepare('SELECT id FROM buyer_messages WHERE id=?').get(context.messageId)) return { handled: true, action: 'duplicate', reply: '' };
    this.save(orderId, raw, 'in', result.intent, context.source || 'operator-entered', Date.now(), context.messageId);
    let action = 'draft', key, directReply, draftId, draftIntent;
    const reference=context.reference||recorded.orderReference;
    const lastBuyer=reference?.messages?.filter(m=>m.peer===true&&m.kind!=='attachment').at(-1);
    const preparing=automatic&&(row.conversationOnly||PREPAY.has(row.state)||row.state==='WAITING_FOR_IGN');
    if(preparing&&lastBuyer?.text===raw&&!result.entities.ign){
      const interpreter=require('./chat-interpreter');
      const decision=await (this.options.interpreter||interpreter.forServices(this.services)).interpret({orderId,messageId:context.messageId,text:raw,ruleIntent:result.intent});
      const suggested=interpreter.suggestion(decision);
      if(suggested){directReply=suggested;draftIntent='recipient_clarification';draftId='ai-suggest:'+orderId+':'+require('./order-chat-flow').revision(reference.messages);action='clarify';}
    }
    if (result.intent === 'cancel') {
      if(row?.conversationOnly&&this.services.marketplace?.cancelConversation){
        try{await this.services.marketplace.cancelConversation(recorded,context.reference||recorded.orderReference);key='cancelled';action='cancelled';}
        catch(error){key='operator';action='handover';}
      }else if (row && PREPAY.has(row.state) && this.repo.chunks(orderId).length === 0) {
        const owner = crypto.randomUUID();
        if (this.repo.claim(orderId, owner)) {
          try {
            const adapter = this.options.adapter || services.marketplace;
            if (!adapter?.capabilities?.cancelOrder) throw new Error('Marketplace cancellation capability unavailable');
            this.repo.state(orderId, 'CANCEL_INTENT', 'Buyer explicitly requested cancellation; awaiting marketplace');
            await adapter.cancelOrder(orderId, 'Buyer explicitly requested cancellation');
            this.repo.state(orderId, 'CANCELLED');
            this.repo.release(orderId);
            key = 'cancelled'; action = 'cancelled';
            this.emit('orderCancelled', { orderId });
          } catch (error) {
            this.repo.state(orderId, 'NEEDS_OPERATOR', 'Cancellation outcome requires review: ' + error.message);
            key = 'operator'; action = 'handover';
          } finally { this.repo.unclaim(orderId, owner); }
        } else { key = 'delivering'; action = 'handover'; }
      } else { key = row?.state === 'DELIVERED' ? 'delivered' : 'operator'; action = 'handover'; }
    } else if (result.intent === 'missing' || result.intent === 'escalation') {
      if (row?.state === 'DELIVERED' && result.intent === 'missing') this.repo.state(orderId, 'NEEDS_OPERATOR', 'Buyer reports nonreceipt after recorded delivery; review evidence; do not repay or auto-refund');
      key = 'operator'; action = 'handover';
    } else if(automatic&&['ign','confirm_yes','confirm_no','recipient_correction','recipient_pause','ambiguous_ign'].includes(result.intent)){
      const started=['PAY_INTENT','PAY_SENT','PAY_VERIFIED','ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING','DELIVERED'].includes(row.state);
      if(started){key=this.stateTemplate(row.state);}
      else {
        const flow=require('./order-chat-flow'),amount=flow.quantityForOrder(recorded,context.reference||recorded.orderReference),selected=flow.selection(context.reference?.messages||recorded.orderReference?.messages||[],{...config,amount});
        if(selected.confirmed&&selected.latest){directReply='';action='recipient_confirmed';draftId='ign-confirmed:'+orderId+':'+selected.confirmationMessageId;}
        else if(selected.latest&&!selected.requiresClarification&&!selected.rejected&&selected.promptMessageId){directReply='';}
        else if(selected.latest&&!selected.requiresClarification&&!selected.rejected){directReply=flow.confirmationPrompt(selected.latest.ign,amount);draftId='ign-confirm:'+orderId+':'+selected.latest.messageId+(amount?':'+amount:'');draftIntent='recipient_confirmation';}
        else if(!directReply){directReply=result.intent==='confirm_no'?'No problem! What is the correct Minecraft username?':'Please send just your exact Minecraft username, including the starting dot for Bedrock. I will confirm it before sending.';draftIntent='recipient_correction';draftId='ign-clarify:'+orderId+':'+flow.revision(reference?.messages||[]);}
      }
    } else if (['automation','keep','ambiguous_cancel','ign','thanks','off_topic'].includes(result.intent)) {
      key = result.intent;
      if (result.intent === 'ign') {
        if (recorded.browserWorkflow && recorded.buyerIgn?.toLowerCase()===result.entities.ign?.toLowerCase()) key=PREPAY.has(row.state)?'ign_accepted':this.stateTemplate(row.state);
        else action='handover';
      }
    } else key = this.stateTemplate(row?.state);
    if (action === 'handover') {
      const detail=result.intent==='ign' ? `Buyer supplied Minecraft IGN ${result.entities.ign || '(not a valid complete username)'}. It is saved in the conversation; no payment recipient was changed.` : result.intent==='cancel' ? 'Buyer requested cancellation. The current order/payment state did not permit automatic cancellation.' : result.intent==='missing' ? 'Buyer says the delivery was not received. Review the captured delivery record; no repeat payment or automatic refund was issued.' : 'Buyer requested help or raised a dispute. Their message is saved for owner review.';
      this.services.events?.emit('operator:alert', { component:'buyer-chat',orderId,reason:detail });
      this.emit('operatorHandover', { orderId, intent: result.intent });
    }
    const reply = automatic&&config.minimalChat!==false&&!draftIntent?'':directReply??await this._reply(key, context, automatic&&result.entities.ign?{...row,payload:JSON.stringify({...recorded,buyerIgn:result.entities.ign})}:row, config);
    if (reply) {
      const transcript = this.transcript(orderId);
      const last = transcript.filter(m => m.direction === 'out').at(-1);
      const {min:typingMin,max:typingMax,interval}=require('./chat-timing').chatTiming(config);
      const dueMs = Math.max(Date.now() + crypto.randomInt(typingMin, typingMax + 1), (last?.due_ms || 0) + interval);
      this.save(orderId, reply, 'out', draftIntent||result.intent, 'local-rule-engine', dueMs,draftId);
    }
                                                                                                                       
    return { handled: true, action, cancelled: action === 'cancelled', reply, intent: result.intent, entities: result.entities, transport: 'manual-inbox', sent: false, persisted: Boolean(this.db) };
  }
  stateTemplate(state) {
    if (state === 'WAITING_FOR_IGN') return 'waiting_ign';
    if (state === 'DELIVERED') return 'delivered';
    if (['PAY_INTENT','PAY_SENT','PAY_VERIFIED','ALL_VERIFIED','EVIDENCE_BUILT','MARK_DELIVERED_PENDING'].includes(state)) return 'delivering';
    if (['RESERVED','SESSION_READY'].includes(state)) return 'joining';
    if (['NEEDS_OPERATOR','CANCEL_INTENT'].includes(state)) return 'operator';
    return 'queued';
  }
  async _reply(key, context, row, config) {
                                                                                          
    const variants = key === 'automation' ? templates.automation : config.templates?.[key] || templates[key] || templates.off_topic;
    if (!Array.isArray(variants) || variants.length < 4 || variants.some(v => typeof v !== 'string' || v.length > 500 || dishonestClaim.test(v))) throw new Error('Use four short, honest reply variants. An attachment upload is not configured by a reply template; only a confirmed file upload can establish that it was sent. Avoid human-identity claims.');
    const data = row ? JSON.parse(row.payload) : {};
    const fill = value => value.replaceAll('{amount}', String(data.amount ?? 'not captured')).replaceAll('{ign}', data.buyerIgn || 'not captured').replaceAll('{time}', row ? new Date(row.updated_ms).toISOString() : 'not captured');
    const used = new Set((context.preview ? [] : this.transcript(context.orderId)).filter(m => m.direction === 'out').map(m => m.text));
    const available = variants.map(fill).filter(v => !used.has(v));
    return available.length ? available[crypto.randomInt(available.length)] : '';
  }
  async _checkCancelKeywords(text) { return classify(text).intent === 'cancel'; }
  _checkNeedsHumanHandover(text) { return ['escalation','missing'].includes(classify(text).intent); }
  async _generateReply(context) {
    const config = await this.settings(); const intent = classify(context.message).intent;
    return this._reply(templates[intent] ? intent : this.stateTemplate(this.repo?.get(context.orderId)?.state), context, this.repo?.get(context.orderId), config);
  }
  async sendOpeningMessage(orderId, buyerIgn, amount) {
    const row = this.repo?.get(orderId);
    const id = 'opening:' + crypto.createHash('sha256').update(orderId).digest('hex');
    if (!row || !(PREPAY.has(row.state)||row.state==='WAITING_FOR_IGN'||row.conversationOnly===true) || this.db?.prepare('SELECT id FROM buyer_messages WHERE id=? OR (order_id=? AND direction=\'out\' AND intent=\'opening\' AND state=\'browser-confirmed-sent\')').get(id,orderId)) return { reply: '', sent: false, duplicateOrIneligible: true };
    const config = await this.settings();
    const orderForOpening=JSON.parse(row.payload);
    const known=require('./order-chat-flow').selection(orderForOpening.orderReference?.messages||[],{...config,amount:require('./order-chat-flow').quantityForOrder(orderForOpening,orderForOpening.orderReference)});
    if(known.latest&&!known.requiresClarification)return {reply:'',sent:false,skippedKnownRecipient:true};
    let reply = config.openingMessage || require('./order-chat-flow').DEFAULT_OPENING;
    if(!this.db?.prepare("SELECT id FROM browser_actions WHERE operation='uploadEvidenceObserved' AND resource_id=? AND state='CONFIRMED' AND json_extract(request,'$.name')='minecraft-ign-guide.png'").get(orderId))reply=reply.replace(' (example picture attached)','');
    if(this.services.gameBridge){
      const order=JSON.parse(row.payload);
      const quantity=require('./order-chat-flow').quantityForOrder(order,order.orderReference);
      reply=require('./customer-messages').render('opening',{buyer:order.buyerName||order.buyerMarketplaceId||order.browserOrder?.buyerName,amount:quantity});
    }
    validateOpening(reply);
    const {min,max}=require('./chat-timing').chatTiming(config);
    this.save(orderId, reply.trim(), 'out', 'opening', 'local-rule-engine', Date.now() + crypto.randomInt(min, max + 1), id);
    return { reply: reply.trim(), sent: false, transport: 'manual-inbox', id };
  }
}
module.exports = AiChatAgent;
module.exports.validateOpening = validateOpening;
