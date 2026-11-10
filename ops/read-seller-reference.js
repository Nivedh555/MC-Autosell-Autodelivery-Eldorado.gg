'use strict';
                                                                               
                                                                            
const path=require('node:path'),fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {PlaywrightSession}=require('../marketplace/browser/playwright-session');
async function main(){
  const db=new DatabaseSync(path.join(__dirname,'..','data','autosell.db'),{readOnly:true});
  const allowed=new Set(['eldorado.browser.options','eldorado.browser.profile']);
  const session=new PlaywrightSession({db:{raw:()=>db},settings:{get:async id=>{
    if(!allowed.has(id))throw Error('Unsupported inspection setting');
    return JSON.parse(db.prepare('SELECT value FROM settings WHERE id=?').get(id)?.value||'{}');
  }}});
  try{
    await session.open();
    const history=await session.inspectOrders();
    const references=[];
    for(const order of history.orders.filter(row=>row.status==='Pending delivery').slice(0,5))references.push(await session.inspectOrderReference(order));
    let chatControls;
    if(process.argv.includes('--chat-controls')&&history.orders[0]){
      const reference=await session.inspectOrderReference(history.orders[0]);
      const frame=await require('../marketplace/browser/observed-chat').frameFor(session.page,reference.buyerName,15000);
      chatControls=await frame.evaluate(()=>({buttons:[...document.querySelectorAll('button,[role="button"]')].filter(n=>n.getClientRects().length).map(n=>({tag:n.tagName,text:n.textContent.trim(),label:n.getAttribute('aria-label'),title:n.getAttribute('title'),class:n.className})),files:[...document.querySelectorAll('input[type="file"]')].map(n=>({accept:n.accept,multiple:n.multiple,class:n.className})),attachments:[...document.querySelectorAll('a[href]')].filter(n=>n.getClientRects().length).map(n=>({text:n.textContent.trim(),href:'[private attachment URL omitted]'}))}));
    }
    const result={capturedAt:new Date().toISOString(),history,references,chatControls,mutationsSent:0};
    const out=path.join(__dirname,'..','data','private-diagnostics','latest-seller-reference.json');
    fs.mkdirSync(path.dirname(out),{recursive:true});
    fs.writeFileSync(out,JSON.stringify(result,null,2));
    console.log(JSON.stringify({capturedAt:result.capturedAt,sellerHref:history.sellerHref,orders:history.orders.length,openOrderReferences:references.length,mutationsSent:0,privateRecord:out},null,2));
  }finally{await session.close();db.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
