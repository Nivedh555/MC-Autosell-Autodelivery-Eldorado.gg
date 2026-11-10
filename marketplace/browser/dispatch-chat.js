'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const {MessageOutbox,logicalKey} = require('./message-outbox');
const chat = require('./observed-chat');
const attachments = require('./evidence-upload');
const references = require('./order-reference');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const delivered = value => require('../order-status').closure(value)==='completed';

async function run(session,order,operation,request,proposedId,completion,work) {
  return session.observedExclusive(async () => {
    const outbox=new MessageOutbox(session.services.db.raw(),order.id,operation,request,proposedId);
    const claim=outbox.claim();
    if (claim.sent) return claim.result;
    let ownsBrowser=false;
    try {
      if (!session.context || !['ATTACHED_PAUSED','RUNNING'].includes(session.state) || session.busy)
        throw Error('Connect the selected seller browser before sending this order message.');
      ownsBrowser=true;
      session.busy=true;
      session.active=operation;
      const generation=session.epoch;
      const check=()=>{
        if (session.epoch!==generation || !session.context) throw Error('Seller browser disconnected during the order message.');
      };
      if (!session.page || session.page.isClosed()) session.page=await session.newPage();
      const history=await session.orderChatContext(order,{completionNotification:completion===true,cancellationNotification:completion==='cancellation'});
      const current=history.orders.find(row=>row.id===order.id);
      if (!current || history.sellerHref!==request.sellerHref ||
          ['buyerName','gameLabel','quantityDisplay','orderUrl'].some(key=>order[key]!==current[key]))
        throw Error('The selected seller or buyer conversation changed.');
      if (completion==='cancellation'?require('../order-status').closure(current.status)!=='canceled':completion ? !delivered(current.status) : current.status!=='Pending delivery')
        throw Error('This order is no longer eligible for this customer message.');
      check();
      const result=await work({outbox,claim,current,check});
      check();
      outbox.finish(result);
      session.record(operation,claim.reconcile?'RECONCILED_OUTGOING':'CONFIRMED_OUTGOING');
      return result;
    } catch(error) {
      outbox.failed(error);
      session.reason=error.message;
      throw error;
    } finally {
      if (ownsBrowser) { session.busy=false; session.active=null; }
    }
  });
}

function send(session,order,text,messageId,sellerHref,authorize) {
  if (typeof authorize!=='function'||typeof messageId!=='string'||!messageId||messageId.length>200)
    throw Error('An authorized persisted reply is required.');
  const request={orderId:order.id,text,messageId,sellerHref};
  const proposedId='sendMessageObserved:'+hash(JSON.stringify([order.id,messageId]));
  const db=session.services.db.raw();
  const snapshot=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_message_snapshots'").get()?db.prepare('SELECT event,text FROM customer_message_snapshots WHERE id=? AND order_id=?').get(messageId,order.id):null;
  const completion=logicalKey(order.id,'sendMessageObserved',request)==='completion-text'||snapshot&&['review_request','payment_verified'].includes(snapshot.event)&&delivered(order.status)?true:snapshot?.event==='buyer_canceled'?'cancellation':false;
  if(snapshot&&snapshot.text!==text){const old=db.prepare("SELECT request FROM browser_actions WHERE operation='sendMessageObserved' AND resource_id=? AND json_extract(request,'$.messageId')=? LIMIT 1").get(order.id,messageId);if(!old||JSON.parse(old.request).text!==text)throw Error('Customer message differs from its scheduled content.');}
  return run(session,order,'sendMessageObserved',request,proposedId,completion,async ({outbox,claim,current,check}) => {
    const previous=claim.physical && JSON.parse(claim.physical.request);
    if (previous && (previous.orderId!==order.id || previous.sellerHref!==sellerHref))
      throw Error('Saved chat action belongs to a different order or seller.');
    // Pin original content, including versioned historical completion templates.
    const value=previous?.text ?? text;
    if (claim.reconcile) {
      if (!Array.isArray(previous?.before)) throw Error('Previous chat submission lacks its comparison snapshot. Review the order conversation.');
      const ref=await references.readReference(session.page,current,session.config.timeoutMs,{customerCancellation:completion==='cancellation'});
      if (ref.status!==current.status) throw Error('Order changed while reconciling its earlier message.');
      const receipt=chat.newReceipt(previous.before,ref.messages,order.id,value);
      return {...receipt,recovered:true};
    }
    if (previous) {
      const ref=await references.readReference(session.page,current,session.config.timeoutMs,{customerCancellation:completion==='cancellation'});
      await authorize(ref);
      // The durable marker proves no click was attempted. Only an unchanged draft
      // can be cleared and restaged. A user's edited draft stays intact.
      const frame=await chat.frameFor(session.page,current.buyerName,session.config.timeoutMs);
      const composer=frame.getByRole('textbox',{name:'Say something...',exact:true});
      const draft=(await composer.innerText()).trim();
      if (draft && draft!==value.trim()) throw Error('An existing unsent draft was edited. Review the order conversation.');
      if (draft) {check();await composer.fill('');}
    }
    const config=await session.services.settings?.get('eldorado.chat.local')||{};
    return chat.send(session.page,current,value,{
      timeoutMs:session.config.timeoutMs,characterMs:config.fastReplies!==false?0:session.config.characterMs,check,customerCancellation:completion==='cancellation',
      beforeSend:async ref=>{
        await authorize(ref);check();
        const persisted={...request,text:value,before:ref.messages};
        outbox.stage('sendMessageObserved',hash(JSON.stringify(request)),persisted);
      },
      beforeSubmit:authorize,
      beforeActivate:()=>outbox.dispatch()
    });
  });
}

function upload(session,order,file,sellerHref,authorize,{confirmationGuide=false}={}) {
  if(typeof authorize!=='function') throw Error('An authorized persisted upload is required.');
  const request={orderId:order.id,sellerHref,name:path.basename(file)};
  const key=logicalKey(order.id,'uploadEvidenceObserved',request);
  const proposedId='uploadEvidenceObserved:'+order.id+':logical:'+hash(key);
  return run(session,order,'uploadEvidenceObserved',request,proposedId,confirmationGuide,async ({outbox,claim,current,check})=>{
    if (claim.reconcile) {
      const saved=claim.physical && JSON.parse(claim.physical.request);
      if (!saved || saved.orderId!==order.id || saved.sellerHref!==sellerHref || !Array.isArray(saved.before) || !saved.hash)
        throw Error('Previous upload lacks a comparison snapshot. Review the order conversation.');
      const ref=await references.readReference(session.page,current,session.config.timeoutMs);
      if (ref.status!==current.status) throw Error('Order changed while reconciling its earlier attachment.');
      const frame=await chat.frameFor(session.page,current.buyerName,session.config.timeoutMs);
      const after=await frame.locator('.UserMessage__message-row').evaluateAll(attachments.attachmentRows);
      const result=attachments.newAttachmentReceipt(saved.before,after,order.id,saved.name,saved.hash);
      return {...result.receipt,recovered:true};
    }
    const result=await attachments.upload(session.page,current,file,{
      timeoutMs:Math.max(45000,session.config.timeoutMs),check,
      beforeSend:async details=>{
        await authorize();check();
        outbox.stage('uploadEvidenceObserved',details.hash,{...request,...details});
      },
      beforeSelection:()=>outbox.dispatch(),
      beforePreviewClick:authorize
    });
    return result.receipt;
  });
}

module.exports={send,upload};
