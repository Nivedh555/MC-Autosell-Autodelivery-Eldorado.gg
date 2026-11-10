'use strict';
const crypto = require('node:crypto');
const AiChatAgent = require('./ai-chat-agent');
class ChatScheduler {
  constructor(services) { this.services = services; this.busy = false; this.stopped=false; this.agent = new AiChatAgent(); this.sends = new Map(); this.recipientWakes=new Map(); }
  async start() {
    this.stopped=false;
    if (this.timer) return;
    const marketplace=this.services.marketplace;
    if((marketplace?.documentedSellerApi||marketplace?.profile)&&(!marketplace.capabilities?.getMessages||!marketplace.capabilities?.sendMessage))this.recoverObservedDrafts();
    const interrupted = this.services.db.raw().prepare("SELECT id,order_id FROM buyer_messages WHERE state='SEND_INTENT'").all();
    this.services.db.raw().prepare("UPDATE buyer_messages SET state='NEEDS_OPERATOR' WHERE state='SEND_INTENT'").run();
    for (const row of interrupted) this.services.events.emit('operator:alert', { component: 'chat', orderId: row.order_id, reason: 'Restart during message send; inspect the order conversation before sending again' });
    const config = await this.services.settings.get('eldorado.chat.local');
    if (config.autoSend !== true) return;
    if (!Number.isSafeInteger(config.pollMs) || config.pollMs < 1000) throw new Error('Configure a bounded chat polling interval');
    this.timer = setInterval(() => this.requestTick(), require('./chat-timing').chatTiming(config).poll); this.timer.unref?.();
    this.requestTick();
  }
  stop() { this.stopped=true;clearInterval(this.timer); this.timer=null;clearImmediate(this.wake);this.wake=null;this.tickRequested=false; }
  requestTick() {
    if(this.stopped)return;
    if(this.busy){this.tickRequested=true;return;}
    if(this.wake)return;
    this.wake=setImmediate(()=>{this.wake=null;void this.tick().catch(error=>this.services.events.emit('operator:alert',{component:'chat',reason:error.message}));});
    this.wake.unref?.();
  }
  recoverObservedDrafts(orderId){
    const s=this.services;if(!s.browserBridge?.recordsChatSubmitIntents)return;
                                                                              
                                                      
    const confirmed=s.db.raw().prepare("SELECT m.id,m.order_id FROM buyer_messages m JOIN delivery_orders d ON d.id=m.order_id WHERE m.intent='opening' AND m.state='browser-confirmed-sent' AND d.state='NEEDS_OPERATOR' AND d.reason LIKE 'Step opening_message:%'"+(orderId?' AND m.order_id=?':'')).all(...(orderId?[orderId]:[]));
    for(const row of confirmed)if(s.deliveryService?.repo?.resumeConfirmedOpening?.(row.order_id,row.id))s.orderPoller?.requestPoll?.();
    const db=s.db.raw(),rows=db.prepare("SELECT id,order_id FROM buyer_messages WHERE direction='out' AND source='local-rule-engine' AND state IN ('SEND_INTENT','NEEDS_OPERATOR')"+(orderId?' AND order_id=?':'')).all(...(orderId?[orderId]:[]));
    for(const row of rows){
      if(this.sends.has(row.id))continue;
      const actionId='sendMessageObserved:'+crypto.createHash('sha256').update(JSON.stringify([row.order_id,row.id])).digest('hex');
      const action=db.prepare('SELECT state FROM browser_actions WHERE id=?').get(actionId);
                                                                               
                                                                       
      if(!action||action.state==='CONFIRMED'||s.browserBridge.reconcilesChatSendOutcomes&&['INTENT','NEEDS_OPERATOR'].includes(action.state))db.prepare("UPDATE buyer_messages SET state='draft' WHERE id=? AND state IN ('SEND_INTENT','NEEDS_OPERATOR')").run(row.id);
    }
  }
  async sendDraft(pending) {
    if (this.sends.has(pending.id)) return this.sends.get(pending.id);
    const work = (async()=>{
      const s=this.services,db=s.db.raw();
      const latest=db.prepare('SELECT * FROM buyer_messages WHERE id=?').get(pending.id);
      if(latest?.state==='browser-confirmed-sent')return true;
      if(!latest || latest.state!=='draft')throw Error('Opening/reply send outcome requires review; it will not be sent again.');
      await s.rollout.authorize('sendMessage');
      if(!db.prepare("UPDATE buyer_messages SET state='SEND_INTENT' WHERE id=? AND state='draft'").run(pending.id).changes)throw Error('Another message send has claimed this draft.');
      try{
        await s.marketplace.sendMessage(pending.order_id,pending.text,pending.id);
        db.prepare("UPDATE buyer_messages SET state='browser-confirmed-sent',sent_ms=? WHERE id=?").run(Date.now(),pending.id);
        return true;
      }catch(error){db.prepare("UPDATE buyer_messages SET state='NEEDS_OPERATOR' WHERE id=?").run(pending.id);throw error;}
    })();
    this.sends.set(pending.id,work);
    try{return await work;}finally{this.sends.delete(pending.id);}
  }
  async ensureOpening(orderId) {
    const s=this.services,config=await s.settings.get('eldorado.chat.local');
    if(config.autoSend!==true || config.openingEnabled===false)return false;
    if(!s.marketplace.capabilities.getMessages || !s.marketplace.capabilities.sendMessage)throw Error('Opening message cannot be sent: the real order chat controls have not been reviewed. No coins were sent.');
    const opening=await this.agent.sendOpeningMessage(orderId);
    if(opening.skippedKnownRecipient||opening.skippedConfigured)return true;
    const pending=s.db.raw().prepare("SELECT * FROM buyer_messages WHERE order_id=? AND intent='opening' AND direction='out' ORDER BY created_ms LIMIT 1").get(orderId);
    if(!pending)throw Error('Opening message was not prepared for this funded order.');
    if(pending.state==='browser-confirmed-sent')return true;
    if(this.sends.has(pending.id))return this.sends.get(pending.id);
    if(pending.state!=='draft')throw Error('Opening message outcome is unknown. Review order chat before retrying; no coins were sent.');
    const wait=pending.due_ms-Date.now();if(wait>60000)throw Error('Opening message delay exceeds the bounded schedule.');
    if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
    return this.sendDraft(pending);
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    const s = this.services, db = s.db.raw();
    try {
      const config = await s.settings.get('eldorado.chat.local');
      if(config.autoSend && (s.marketplace.profile||s.marketplace.hybrid) && (!s.marketplace.capabilities.getMessages || !s.marketplace.capabilities.sendMessage) && s.browserBridge?.sendOrderMessageObserved) {
        await this.tickObserved(config);return;
      }
      if (!config.autoSend || !s.marketplace.capabilities.getMessages || !s.marketplace.capabilities.sendMessage || !await require('../treasury/trading-controls').globallyEnabled(s.settings)) return;
      await s.rollout.authorize('sendMessage');
      for (const row of db.prepare("SELECT * FROM delivery_orders WHERE mode='live' AND state IN ('DETECTED','VALIDATED','WAITING_FOR_IGN') ORDER BY updated_ms DESC LIMIT 20").all()) {
        if(s.deliveryService.repo.closedStatus(row.id))continue;
        const order = JSON.parse(row.payload); if (order.kind === 'transfer') continue;
        if (!order.buyerMarketplaceId) { s.events.emit('operator:alert', { component: 'chat', orderId: row.id, reason: 'Buyer marketplace identity unavailable; cannot authenticate inbound chat author' }); continue; }
        if (config.openingEnabled !== false && s.marketplace.contract?.statuses?.paid?.includes(order.status)) await this.agent.sendOpeningMessage(row.id, order.buyerIgn, order.amount);
        const messages = await s.marketplace.getMessages(row.id);
        if (!Array.isArray(messages) || messages.length > 500) throw new Error('Observed message list is invalid');
        for (const message of messages) {
          if (message.orderId !== row.id || typeof message.id !== 'string' || !message.id || typeof message.text !== 'string') throw new Error('Message lacks stable order/message identity');
          if (message.author !== order.buyerMarketplaceId) continue;
          const messageId = crypto.createHash('sha256').update(JSON.stringify([row.id, message.id])).digest('hex');
          await this.agent.handleBuyerMessage({ orderId: row.id, message: message.text, messageId, source: 'browser-observed-buyer' });
        }
        const pending = db.prepare("SELECT * FROM buyer_messages WHERE order_id=? AND direction='out' AND state='draft' AND source='local-rule-engine' AND due_ms<=? ORDER BY due_ms LIMIT 1").get(row.id, Date.now());
        if (!pending) continue;
        const latest = s.deliveryService.repo.get(row.id);
        if (pending.intent === 'opening' && ['NEEDS_OPERATOR','CANCELLED','EXPIRED','DELIVERED'].includes(latest.state)) { db.prepare("UPDATE buyer_messages SET state='stale-draft' WHERE id=?").run(pending.id); continue; }
                                                                                       
                                                                                   
        if (pending.created_ms < row.updated_ms && ['greeting','ready','status'].includes(pending.intent)) {
          db.prepare("UPDATE buyer_messages SET state='stale-draft' WHERE id=?").run(pending.id);
          continue;
        }
        const previous = db.prepare("SELECT max(sent_ms) AS last FROM buyer_messages WHERE order_id=? AND state='browser-confirmed-sent'").get(row.id).last;
        if (previous && Date.now() - previous < require('./chat-timing').chatTiming(config).interval) continue;
        await this.sendDraft(pending);
      }
    } finally { this.busy = false;if(this.tickRequested){this.tickRequested=false;this.requestTick();} }
  }
  async tickObserved(config) {
    const s=this.services,db=s.db.raw();
    if(!await require('../treasury/trading-controls').globallyEnabled(s.settings))return;
    const browser=s.browserBridge.status();
    if(!browser.connected||!['ATTACHED_PAUSED','RUNNING'].includes(browser.state))return;
    const policy=await s.settings.get('listing.policy');
    if(!policy?.observedSellerHref||!policy.offerId)return;
    const archive=new(require('./order-observations').OrderObservations)(s.db);
    const {monitoring,withinMonitoring}=require('./order-monitor');
    const monitor=s.marketplace.documentedSellerApi?monitoring(s.db,policy):null;
                                                                                
                                                                               
    this.fairChats||=new(require('./fair-batch').FairBatch)();
    const conversations=new Map(this.fairChats.take(archive.list().filter(order=>!require('../db/repositories/delivery').terminal.has(order.deliveryState)&&(!order.executionRecorded||['DETECTED','VALIDATED','WAITING_FOR_IGN'].includes(order.deliveryState)&&order.browserWorkflow)&&order.gameLabel==='DonutSMP'&&order.marketplaceStatus==='Pending delivery'&&order.orderUrl&&(!s.marketplace.hybrid||order.offerId===policy.offerId)&&withinMonitoring(order,monitor)&&(!monitor||!order.monitorScope||order.monitorScope===monitor.scope)),4).map(order=>[order.id,order]));
    const contextRepo={get:id=>{
      const order=conversations.get(id);if(!order)return null;
      const execution=s.deliveryService?.repo?.get(id);if(execution&&JSON.parse(execution.payload).browserWorkflow)return execution;
      return {id,state:order.ownerDeliveryHold?'NEEDS_OPERATOR':'WAITING_FOR_IGN',conversationOnly:true,payload:JSON.stringify(order),updated_ms:order.last_ms};
    }};
    const agent=new AiChatAgent({db:s.db,services:s,repo:contextRepo});
    for(const order of conversations.values()){
      try{
        if(archive.repo.closedStatus(order.id))continue;
        const reference=await s.browserBridge.inspectOrderReference(order);
        archive.recordReference(order,reference);
        order.orderReference=reference;
        archive.annotate(order.id,{chatReason:null});
        if(reference.status!=='Pending delivery')continue;
        const flow=require('./order-chat-flow'),recipient=flow.selection(reference.messages,{...config,amount:flow.quantityForOrder(order,reference),orderId:order.id,services:s});
        const wakeKey=JSON.stringify([recipient.latest?.ign,recipient.confirmationMessageId]);
        if(!order.executionRecorded&&!order.ownerDeliveryHold&&recipient.latest&&!recipient.requiresClarification&&recipient.confirmed&&this.recipientWakes.get(order.id)!==wakeKey){this.recipientWakes.set(order.id,wakeKey);s.orderPoller?.requestPoll?.();}
        this.recoverObservedDrafts(order.id);
        // Timestamp hydration can change a local inbound fingerprint. A visible
        // amount/recipient-bound prompt already satisfies that confirmation draft.
        if(recipient.promptMessageId&&recipient.latest){
          const visible=reference.messages.find(message=>message.id===recipient.promptMessageId);
          if(visible)db.prepare("UPDATE buyer_messages SET state='stale-draft' WHERE order_id=? AND direction='out' AND intent='recipient_confirmation' AND state='draft' AND text=?").run(order.id,visible.text);
        }
        if(config.openingEnabled!==false){
          if(!s.gameBridge&&(config.openingMessage||require('./order-chat-flow').DEFAULT_OPENING).includes('(example picture attached)')&&!db.prepare("SELECT id FROM buyer_messages WHERE order_id=? AND intent='opening' AND direction='out'").get(order.id)&&s.browserBridge.uploadOrderEvidenceObserved){
            try{
              await s.browserBridge.uploadOrderEvidenceObserved(order,require('node:path').join(__dirname,'assets','minecraft-ign-guide.png'),policy.observedSellerHref,async()=>{
                const fresh=await s.settings.get('listing.policy');
                if(!await require('../treasury/trading-controls').globallyEnabled(s.settings)||fresh.observedSellerHref!==policy.observedSellerHref)throw Error('Replies stopped or seller changed before the guide upload');
              });
            }catch(error){archive.annotate(order.id,{chatReason:'IGN guide upload unconfirmed: '+error.message+'. The greeting will omit the attachment claim.'});}
          }
          await agent.sendOpeningMessage(order.id);
          if(s.gameBridge&&db.prepare("SELECT id FROM buyer_messages WHERE order_id=? AND intent='opening' AND state='browser-confirmed-sent'").get(order.id)){
            await require('./customer-messages').sendNameGuide(s,order,policy.observedSellerHref);
          }
        }
        for(const message of reference.messages.filter(row=>row.peer&&row.kind!=='attachment')){
          const id='chat-in:'+crypto.createHash('sha256').update(JSON.stringify([order.id,message.id])).digest('hex');
          await agent.handleBuyerMessage({orderId:order.id,message:message.text,messageId:id,reference,source:'captured buyer-room direction; individual author not authenticated'});
        }
        for(const draft of db.prepare("SELECT id,text,intent FROM buyer_messages WHERE order_id=? AND direction='out' AND state='draft' AND intent IN ('recipient_confirmation','recipient_correction','recipient_clarification')").all(order.id)){
          if(!require('./chat-draft-policy').current(draft,reference,order,config))db.prepare("UPDATE buyer_messages SET state='stale-draft' WHERE id=? AND state='draft'").run(draft.id);
        }
        if(config.minimalChat!==false){
          db.prepare("UPDATE buyer_messages SET intent='recipient_confirmation' WHERE order_id=? AND id LIKE 'ign-confirm:%' AND state='draft'").run(order.id);
          db.prepare("UPDATE buyer_messages SET state='stale-draft' WHERE order_id=? AND direction='out' AND source='local-rule-engine' AND state='draft' AND intent NOT IN ('opening','recipient_confirmation','recipient_correction','recipient_clarification','customer_event')").run(order.id);
        }
        const pending=db.prepare("SELECT * FROM buyer_messages WHERE order_id=? AND direction='out' AND state='draft' AND source='local-rule-engine' AND due_ms<=? ORDER BY due_ms LIMIT 1").get(order.id,Date.now());
        if(!pending)continue;
        const current=contextRepo.get(order.id);
        if(current&&!current.conversationOnly&&pending.created_ms<current.updated_ms&&['greeting','ready','status','ign','confirm_yes','confirm_no','recipient_confirmation','recipient_correction'].includes(pending.intent)){
          db.prepare("UPDATE buyer_messages SET state='stale-draft' WHERE id=?").run(pending.id);continue;
        }
        const previous=db.prepare("SELECT max(sent_ms) last FROM buyer_messages WHERE order_id=? AND state='browser-confirmed-sent'").get(order.id).last;
        if(previous&&Date.now()-previous<require('./chat-timing').chatTiming(config).interval)continue;
        await this.sendObservedDraft(order,pending,policy.observedSellerHref);
      }catch(error){const reason='Order chat needs attention: '+error.message;archive.annotate(order.id,{chatReason:reason});s.events.emit('operator:alert',{component:'chat',orderId:order.id,reason:reason+'. No payment was authorized by this conversation reader.'});}
    }
  }
  async sendObservedDraft(order,pending,sellerHref) {
    if(this.sends.has(pending.id))return this.sends.get(pending.id);
    const work=this.sendObservedDraftOwned(order,pending,sellerHref);
    this.sends.set(pending.id,work);
    try{return await work;}finally{this.sends.delete(pending.id);}
  }
  async sendObservedDraftOwned(order,pending,sellerHref) {
    const s=this.services,db=s.db.raw();
                                                                             
                                                                              
    const authorize=async reference=>{
      const config=await s.settings.get('eldorado.chat.local');
      const policy=await s.settings.get('listing.policy');
      if(!config.autoSend||await s.settings.get('general.bot.paused')||policy.observedSellerHref!==sellerHref)throw Error('Automatic replies were paused or the selected seller changed.');
      if(reference.id!==order.id||reference.status!=='Pending delivery')throw Error('The order no longer matches this reply.');
      if(reference.messages&&!require('./chat-draft-policy').current(pending,reference,order,config))throw Object.assign(Error('Buyer conversation changed; the old draft was not submitted.'),{chatNotSubmitted:true});
    };
    await authorize({id:order.id,status:order.marketplaceStatus});
    if(!db.prepare("UPDATE buyer_messages SET state='SEND_INTENT' WHERE id=? AND state='draft'").run(pending.id).changes){
      if(db.prepare('SELECT state FROM buyer_messages WHERE id=?').get(pending.id)?.state==='browser-confirmed-sent')return true;
      throw Error('This reply already has an unconfirmed send intent; no second message was sent.');
    }
    try{
      const receipt=await s.browserBridge.sendOrderMessageObserved(order,pending.text,pending.id,sellerHref,authorize);
      if(receipt.orderId!==order.id||receipt.text!==pending.text||receipt.peer!==false||receipt.moneyActionsAllowed!==false)throw Error('Reply receipt does not match its persisted draft.');
      db.prepare("UPDATE buyer_messages SET state='browser-confirmed-sent',sent_ms=? WHERE id=?").run(Date.now(),pending.id);
      if(s.deliveryService?.repo?.resumeConfirmedOpening?.(order.id,pending.id))s.orderPoller?.requestPoll?.();
    }catch(error){db.prepare('UPDATE buyer_messages SET state=? WHERE id=?').run(error.chatNotSubmitted===true?'draft':'NEEDS_OPERATOR',pending.id);throw error;}
  }
}
module.exports = { ChatScheduler };
