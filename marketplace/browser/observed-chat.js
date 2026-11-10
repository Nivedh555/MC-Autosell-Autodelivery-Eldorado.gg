'use strict';
const crypto = require('node:crypto');

                                                                              
                                                                                
function fingerprint(orderId, message) {
  if(message.domId)return 'local:' + crypto.createHash('sha256').update(JSON.stringify([orderId,'observed-dom',message.domId,message.text,message.peer])).digest('hex');
  return 'local:' + crypto.createHash('sha256').update(JSON.stringify([orderId, message.text, message.displayedTime, message.peer])).digest('hex');
}
function messages(orderId, rows) {
  if (!Array.isArray(rows) || rows.length > 500) throw Error('Order chat exceeds the bounded message reader.');
  const seen = new Set();
  return rows.map((row,index) => {
    if (typeof row.text !== 'string' || !row.text || row.text.length > 4000 || typeof row.peer !== 'boolean') throw Object.assign(Error('An Eldorado chat message is incomplete or exceeds the text limit; wait for the chat to finish loading.'),{code:'CHAT_MESSAGE_INCOMPLETE'});
    if(row.displayedTime!=null&&(typeof row.displayedTime!=='string'||row.displayedTime.length>256))throw Error('Invalid bounded chat timestamp');
    if(row.domId!=null&&(typeof row.domId!=='string'||!row.domId||row.domId.length>256))throw Error('Invalid bounded chat DOM identity');
    row={text:row.text,peer:row.peer,kind:row.kind||'text',displayedTime:row.displayedTime||null,...(row.domId?{domId:row.domId}:{})};
    const id = fingerprint(orderId, row);
    // Repeated adjacent yes/no replies have the same effect on confirmation.
    // TalkJS sometimes supplies the same timestamp and no message ID for them.
    // Collapse only these controls; ambiguous repeated names/text still stop.
    if(seen.has(id)&&row.peer&&rows[index-1]?.peer&&rows[index-1].text===row.text&&/^(?:yes|y|no|n)$/i.test(row.text.trim()))return null;
    if (seen.has(id)) throw Error('Identical chat messages lack distinct captured identities; no reply or recipient was inferred.');
    seen.add(id);
    return {...row, id, identityScope:'Local observation fingerprint, not an Eldorado or TalkJS message ID', author:'not captured', moneyActionsAllowed:false};
  }).filter(Boolean);
}
function readRows(nodes){
  if(nodes.length>500)throw Error('Order chat exceeds the bounded message reader');
  return nodes.map(row=>{
    let scope=row,peer=row.classList.contains('UserMessage__by-other'),domId=row.getAttribute('data-message-id'),displayedTime=null;
    for(let depth=0;scope&&depth<5;depth++,scope=scope.parentElement){
      if(scope!==row&&scope.querySelectorAll('.UserMessage__message-row').length!==1)break;
      peer ||= scope.classList.contains('UserMessage__by-other');
      domId ||= scope.getAttribute('data-message-id');
      const times=[...scope.querySelectorAll('[role="time"],time[datetime]')].filter(node=>!node.closest('.MessageBody__message-text'));
      const values=[...new Set(times.map(node=>node.getAttribute('datetime')||node.getAttribute('title')).filter(Boolean))];
      if(values.length===1)displayedTime ||= values[0];
    }
    const body=row.querySelector('.MessageBody__message-text');
    const names=[...row.querySelectorAll('img[alt],a[download]')].map(node=>node.getAttribute('alt')||node.getAttribute('download')).filter(Boolean);
    const attachment=row.querySelector('img,a[download],audio,video');
    const text=(body?.innerText??body?.textContent)?.trim()||names.join(' ')||(attachment?'[Image or file attachment without a caption]':'');
    return {text,kind:body?'text':'attachment',displayedTime,peer,domId,names,links:[...row.querySelectorAll('a[href]')].map(node=>({text:node.textContent.trim().slice(0,4000),href:node.href})),html:attachment?row.outerHTML.slice(0,12000):''};
  });
}
async function frameFor(page, buyerName, timeoutMs) {
  const find = () => page.frames().filter(frame => {
    try { const u = new URL(frame.url()); return u.origin === 'https://app.talkjs.com' && /^\/app\/[^/]+\/user\/[^/]+\/chatbox\/[^/]+$/.test(u.pathname); } catch { return false; }
  });
  const deadline=Date.now()+timeoutMs;let candidates=find();
  while(!candidates.length&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,Math.min(100,deadline-Date.now())));candidates=find();}
  if (candidates.length !== 1) throw Error(candidates.length?'More than one buyer chat opened for this order. Refresh its page before retrying.':'The buyer chat did not finish loading. Keep the seller browser connected; Autosell will retry reading it.');
  const frame = candidates[0];
  await frame.locator('.ChatHeader__title a').first().waitFor({state:'visible', timeout:timeoutMs});
  const headers = await frame.locator('.ChatHeader__title a').evaluateAll(nodes => nodes.map(n => ({href:n.href, text:n.textContent.trim()})));
  if (!headers.length || headers.length > 2 || !headers.some(n => n.text === buyerName) || headers.some(n => {
    try { const u = new URL(n.href); return !['https://eldorado.gg','https://www.eldorado.gg'].includes(u.origin) || u.pathname !== '/users/' + encodeURIComponent(buyerName) || Boolean(u.search || u.hash); } catch { return true; }
  })) throw Error('The chat room profile link differs from the order buyer.');
  return frame;
}
async function capture(frame, orderId, timeoutMs) {
  const text = await frame.locator('body').innerText({timeout:timeoutMs});
  if (text.length > 100000) throw Error('Chat room exceeds the bounded reference capture.');
  const deadline=Date.now()+timeoutMs;
  for(;;){
    const rows=await frame.locator('.UserMessage__message-row').evaluateAll(readRows);
    try{return {text,messages:messages(orderId,rows)};}
    catch(error){if(error.code!=='CHAT_MESSAGE_INCOMPLETE'||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(100,deadline-Date.now())));}
  }
}
function newReceipt(before, after, orderId, text) {
  if(before.some(row=>row.peer===false&&row.text===text))throw Error('This outgoing text was already present before the send; no new receipt was inferred.');
                                                                            
                                                                        
  const ids = new Set(before.map(row => row.id));
  const added = after.filter(row => !ids.has(row.id) && row.peer === false && row.text === text);
  if (added.length !== 1) throw Error('The new outgoing chat message is missing or ambiguous; inspect the conversation before any retry.');
  return {...added[0], orderId, confirmation:'New outgoing bubble captured in the exact order conversation', remoteAcknowledgement:'not captured', buyerRead:'not captured', moneyActionsAllowed:false};
}
async function assertOrderPage(page,order){
  const current=new URL(page.url()),expected=new URL(order.orderUrl);
  if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.hash||[...current.searchParams.keys()].some(key=>key!=='backButtonParams'))throw Error('Order page changed before the action; no click was sent.');
  const ids=await page.locator('eld-order-header span').evaluateAll(nodes=>nodes.map(node=>node.textContent.trim()).filter(text=>text.startsWith('Order ID: ')));
  if(ids.length!==1||ids[0]!=='Order ID: '+order.id)throw Error('Order header changed before the action; no click was sent.');
}
async function waitForReceipt(frame,orderId,text,before,timeoutMs,check=()=>{}){
  const deadline=Date.now()+timeoutMs;
  const timedOut=cause=>Object.assign(
    Error('Eldorado chat send confirmation timed out; inspect the saved reply before retrying.',{cause}),
    {code:'CHAT_CONFIRMATION_TIMEOUT'}
  );
  let lastError;
  for(;;){
    check();
    const remaining=deadline-Date.now();
    if(remaining<=0)throw timedOut(lastError);
    let after;
    try {after=await capture(frame,orderId,remaining);}
    catch(error){
      if(error.name==='TimeoutError'&&Date.now()>=deadline)throw timedOut(error);
      throw error;
    }
    try {return newReceipt(before,after.messages,orderId,text);}
    catch(error) {lastError=error;}
    const delay=Math.min(100,deadline-Date.now());
    if(delay<=0)throw timedOut(lastError);
    await new Promise(resolve=>setTimeout(resolve,delay));
  }
}
async function send(page, order, text, {timeoutMs=15000, characterMs=60, check=()=>{}, beforeSend, beforeSubmit, beforeActivate,customerCancellation=false}={}) {
  if (typeof beforeSend !== 'function' || typeof beforeSubmit !== 'function') throw Error('A persisted chat send intent and final authorization are required.');
  if(typeof text!=='string'||!text.trim()||text.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw Error('Use a bounded plain-text customer message.');
  if (!Number.isSafeInteger(characterMs) || characterMs < 0 || characterMs > 200) throw Error('Chat typing delay must be between 0 and 200 milliseconds.');
  if (text.length * characterMs > 45000) throw Error('The configured reply typing duration exceeds 45 seconds.');
  const reference = await require('./order-reference').readReference(page, order, timeoutMs,{customerCancellation});
  if (reference.status !== order.status) throw Error('The order status changed; refresh before sending its reply.');
  const frame = await frameFor(page, order.buyerName, timeoutMs);
  const composer = frame.getByRole('textbox', {name:'Say something...', exact:true});
  const button = frame.getByRole('button', {name:'Send', exact:true});
  if (await composer.count() !== 1 || await button.count() !== 1) throw Error('The observed order chat controls changed.');
  const draft=(await composer.innerText()).trim();
  if (draft) throw Error('The chat composer already contains a draft; it was left untouched.');
  if (reference.messages.some(row => !row.peer && row.text === text)) throw Error('This reply already appears in the conversation; no duplicate was sent.');
  check(); await beforeSend(reference); check();
                                                                             
                                                                       
  if (/[\r\n]/.test(text)) await fillMultiline(composer,text);
  else if (characterMs === 0) await composer.fill(text);
  else await composer.pressSequentially(text, {delay:characterMs, timeout:Math.min(60000, timeoutMs + text.length * characterMs)});
  check();
  if ((await composer.innerText()).trim() !== text.trim()) throw Error('The typed reply differs from the persisted reply; nothing was submitted.');
  await button.click({trial:true, timeout:timeoutMs});
  const currentReference=await require('./order-reference').readReference(page,order,timeoutMs,{customerCancellation});
  if(currentReference.status!==order.status)throw Error('The order status changed while typing; the reply was not submitted.');
  await beforeSubmit(currentReference);check();
  await assertOrderPage(page,order);
  if(await frameFor(page,order.buyerName,timeoutMs)!==frame)throw Error('Buyer chat changed before submission; no message was sent.');
  await require('./submission').submit(button,{timeoutMs,check,beforeActivate});
  const receipt=await waitForReceipt(frame,order.id,text,reference.messages,timeoutMs,check);
  check();
  const current = new URL(page.url()), expected = new URL(order.orderUrl);
  if (current.origin !== expected.origin || current.pathname !== expected.pathname || current.hash || [...current.searchParams.keys()].some(key => key !== 'backButtonParams')) throw Error('The order page changed during reply confirmation.');
  return receipt;
}
async function fillMultiline(composer,text){
  const lines=text.replace(/\r\n?/g,'\n').split('\n');
  await composer.fill(lines[0]);
  for(const line of lines.slice(1)){
    await composer.press('Shift+Enter');
    if(line)await composer.pressSequentially(line,{delay:0});
  }
}
module.exports = {fingerprint, messages, readRows, frameFor, capture, newReceipt, waitForReceipt, assertOrderPage, send, fillMultiline};
