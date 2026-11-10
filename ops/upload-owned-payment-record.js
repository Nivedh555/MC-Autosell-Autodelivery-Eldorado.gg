'use strict';
                                                                                   
const {DatabaseSync}=require('node:sqlite'),path=require('node:path'),crypto=require('node:crypto'),fs=require('node:fs');
const {PlaywrightSession}=require('../marketplace/browser/playwright-session');
async function main(){
  const [orderId,captureId,artifact='delivery-logs.txt']=process.argv.slice(2);
  if(artifact!=='delivery-logs.txt')throw Error('Only the customer-safe delivery log can be exported; internal captures stay private');
  if(!/^[a-f0-9-]{36}$/.test(orderId||'')||!/^owner-payment-capture:[a-f0-9-]{36}$/.test(captureId||''))throw Error('Exact owned order ID and persisted owner-payment capture ID required');
  const db=new DatabaseSync(path.join(__dirname,'..','data','autosell.db'));let intent=false;
  const allowed=new Set(['eldorado.browser.options','eldorado.browser.profile']);
  const session=new PlaywrightSession({db:{raw:()=>db},settings:{get:async id=>{if(!allowed.has(id))throw Error('Unsupported setting');return JSON.parse(db.prepare('SELECT value FROM settings WHERE id=?').get(id)?.value||'{}');}}});
  const id='uploadOwnerRecord:'+orderId+':'+captureId+':'+artifact;
  try{
    const row=db.prepare("SELECT evidence FROM delivery_orders WHERE id=? AND mode='owner-capture'").get(captureId);if(!row?.evidence)throw Error('No persisted captured payment evidence');
    const evidence=JSON.parse(row.evidence),base=path.resolve(__dirname,'..','data','proofs',evidence.artifactId);
    if(!/^[a-f0-9-]{36}$/.test(evidence.artifactId)||path.resolve(evidence.directory)!==base||!evidence.signed)throw Error('Invalid evidence directory/signature');
    require('../marketplace/proof-generator').verifyPack(base,evidence.publicKey);
    const prior=db.prepare('SELECT state FROM browser_actions WHERE id=?').get(id);if(prior){console.log(JSON.stringify(prior));return;}
    if(db.prepare("SELECT id FROM browser_actions WHERE state IN ('INTENT','NEEDS_OPERATOR') AND operation!='uploadOwnerRecord' LIMIT 1").get())throw Error('An unresolved browser mutation exists');
    await session.open();const history=await session.inspectOrders(),order=history.orders.find(row=>row.id===orderId);if(!order)throw Error('Owned order not found in actual Sold Orders');
    const hold=db.prepare('SELECT reason FROM owner_delivery_holds WHERE order_id=?').get(orderId);if(!hold)throw Error('This export command is restricted to an owner-held test order');
    const request={orderId,captureId,sellerHref:history.sellerHref};
    const result=await require('../marketplace/browser/evidence-upload').upload(session.page,order,path.join(base,artifact),{timeoutMs:30000,beforeSend:async details=>{
      db.prepare("INSERT INTO browser_actions(id,operation,resource_id,fingerprint,state,request,created_ms,updated_ms) VALUES(?,?,?,?,'INTENT',?,?,?)").run(id,'uploadOwnerRecord',orderId,crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),JSON.stringify({...request,...details}),Date.now(),Date.now());intent=true;
    }});
    db.prepare("UPDATE browser_actions SET state='CONFIRMED',result=?,updated_ms=? WHERE id=?").run(JSON.stringify(result.receipt),Date.now(),id);
    const publicReceipt={orderId:result.receipt.orderId,name:result.receipt.name,sha256:result.receipt.sha256,displayedTime:result.receipt.displayedTime,scope:result.receipt.scope};
    fs.writeFileSync(path.join(__dirname,'..','docs','verification','live-evidence-upload.json'),JSON.stringify(publicReceipt,null,2));
    await session.page.screenshot({path:path.join(__dirname,'..','docs','verification','live-evidence-upload.png'),fullPage:true});
    console.log(JSON.stringify(publicReceipt,null,2));
  }catch(error){
    if(intent)db.prepare("UPDATE browser_actions SET state='NEEDS_OPERATOR',reason=?,updated_ms=? WHERE id=?").run(error.message,Date.now(),id);
    if(session.page&&!session.page.isClosed()){
      await session.page.screenshot({path:path.join(__dirname,'..','docs','verification','live-upload-pending.png'),fullPage:true}).catch(()=>{});
    }
    throw error;
  }
  finally{await session.close();db.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
