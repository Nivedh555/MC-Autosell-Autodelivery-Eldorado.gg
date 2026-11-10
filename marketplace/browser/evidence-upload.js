'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const attachmentRows=require('./observed-chat').readRows;
function outgoingFile(row,name) {
  if(row.peer!==false) return false;
  if(row.names?.includes(name))return true;
  // Some TalkJS versions put the filename and size inside the image bubble's
  // message body. A plain text mention/quote or a filename prefix is insufficient.
  const label=String(row.text||'').trim().replace(/\s*\([\d.,]+\s*(?:bytes?|[KMGT]?i?B)\)\s*$/i,'').trim();
  return Boolean(row.html || row.kind==='attachment') && label===name;
}
function newAttachmentReceipt(before,after,orderId,name,hash){
  if(!Array.isArray(before)||!Array.isArray(after))throw Error('Captured attachment snapshots required');
  const matches=row=>outgoingFile(row,name);
  if(before.some(matches))throw Error('This attachment already existed before upload; no new receipt was inferred');
  const prior=new Set(before.map(row=>JSON.stringify([row.peer,row.displayedTime,row.text])));
  const added=after.filter(row=>!prior.has(JSON.stringify([row.peer,row.displayedTime,row.text]))&&matches(row));
  if(added.length!==1)throw Error('Attachment outcome is unconfirmed; the file will not be uploaded again');
  return {receipt:{orderId,name,sha256:hash,displayedTime:added[0].displayedTime,text:added[0].text,links:added[0].links,confirmation:'New outgoing file bubble in the exact order chat',buyerRead:'not captured',scope:'Browser upload receipt, not marketplace acceptance of evidence'},observedHtml:added[0].html};
}
async function upload(page,order,file,{beforeSend,beforeSelection,beforePreviewClick,check=()=>{},timeoutMs=15000,onSelection}={}){
  if(typeof beforeSend!=='function')throw Error('Persisted attachment intent required');
  const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>5*1024*1024)throw Error('Only a bounded local evidence artifact can be uploaded');
  const reference=await require('./order-reference').readReference(page,order,timeoutMs);
  if(reference.status!==order.status)throw Error('Order changed before evidence upload');
  const frame=await require('./observed-chat').frameFor(page,order.buyerName,timeoutMs);
  const input=frame.locator('input[type="file"].test__fileupload-input');
  if(await input.count()!==1||await frame.getByRole('button',{name:'Share a file',exact:true}).count()!==1)throw Error('Observed attachment controls changed');
  const before=await frame.locator('.UserMessage__message-row').evaluateAll(attachmentRows);
  const name=path.basename(file),hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(before.some(row=>outgoingFile(row,name)))throw Error('This filename already appears in the conversation; inspect it rather than upload twice');
  check();await beforeSend({orderId:order.id,name,hash,before});check();
  const validateSubmission=async()=>{
    const latest=await require('./order-reference').readReference(page,order,timeoutMs);
    if(latest.status!==order.status)throw Error('Order changed before attachment submission.');
    if(beforePreviewClick)await beforePreviewClick();
    check();
    await require('./observed-chat').assertOrderPage(page,order);
    if(await require('./observed-chat').frameFor(page,order.buyerName,timeoutMs)!==frame)throw Error('Buyer chat changed before upload submission');
  };
  await require('./observed-chat').assertOrderPage(page,order);
  if(await require('./observed-chat').frameFor(page,order.buyerName,timeoutMs)!==frame)throw Error('Buyer chat changed before upload');
                                                                              
  // File selection can submit on some browser versions. Persist the boundary
  // before selecting the file even when this client shows a confirmation preview.
  await validateSubmission();
  if(beforeSelection) await beforeSelection();
  check();
  await input.setInputFiles(file,{timeout:timeoutMs});
  if(onSelection)await onSelection(frame);
                                                                          
                                                                           
                                                                  
  await submitPreview(frame,name,{timeoutMs,check,beforeClick:validateSubmission,alreadySent:async()=>{
    const after=await frame.locator('.UserMessage__message-row').evaluateAll(attachmentRows);
    try{newAttachmentReceipt(before,after,order.id,name,hash);return true;}catch{return false;}
  }});
  const deadline=Date.now()+timeoutMs;
  for(;;){
    check();const after=await frame.locator('.UserMessage__message-row').evaluateAll(attachmentRows);
    let result;try{result=newAttachmentReceipt(before,after,order.id,name,hash);}catch(error){if(Date.now()>=deadline)throw Error('Eldorado attachment confirmation timed out; the saved upload will not be repeated.',{cause:error});}
    if(result){await require('./observed-chat').assertOrderPage(page,order);return result;}
    await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,deadline-Date.now()))));
  }
}
async function submitPreview(frame,name,{timeoutMs,check=()=>{},beforeClick=async()=>{},alreadySent=async()=>false}){
  const deadline=Date.now()+timeoutMs;
  const preview=frame.getByText(name,{exact:true});
  while(Date.now()<deadline){
    check();
    if(await alreadySent())return;
    if(await preview.count()===1&&await preview.isVisible()&&!await preview.evaluate(node=>Boolean(node.closest('.UserMessage__message-row')))){
      const send=frame.getByRole('button',{name:'Send',exact:true}).and(frame.locator('button:not([disabled])'));
      if(await send.count()===1&&await send.isEnabled()){
        await beforeClick();check();
        await require('./submission').submit(send,{timeoutMs:Math.max(1,deadline-Date.now()),check});return;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,deadline-Date.now()))));
  }
  throw Error('Attachment preview did not become ready; Send was not clicked.');
}
module.exports={upload,attachmentRows,newAttachmentReceipt,submitPreview};
