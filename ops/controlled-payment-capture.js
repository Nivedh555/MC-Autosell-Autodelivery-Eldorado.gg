'use strict';
const {DeliveryRepository} = require('../db/repositories/delivery');
const {VerifiedPayments,validIgn} = require('../minecraft/verified-payments');
const {connectionRecord} = require('../minecraft/connection-record');

                                                                                   
                                                                                
async function captureOneCoin(recorder, request, options = {}) {
  const services=recorder.services, {accountId,recipient,requestId,confirmation}=request;
  const match=typeof confirmation==='string'&&/^SEND ([1-9][0-9]{0,15}) COINS TO (\.?[A-Za-z0-9_]{3,16})$/.exec(confirmation);
  const amount=confirmation==='PAY ONE COIN TO '+recipient?1n:match&&match[2]===recipient?BigInt(match[1]):0n;
  if(!validIgn(recipient)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId||'')||amount<1n||amount>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Confirm the exact nominal coin amount and one valid recipient.');
  const roles=await services.settings.get('treasury.accountRoles');
  if(!Object.hasOwn(roles||{},accountId))throw Error('Choose a configured sending account.');
  const repo=new DeliveryRepository(services.db),id='owner-payment-capture:'+requestId;
  const existing=repo.get(id);
  if(existing){const payload=JSON.parse(existing.payload);if(existing.account_id!==accountId||payload.buyerIgn!==recipient||payload.amount!==amount.toString())throw Error('This capture ID belongs to a different account, amount or recipient.');return result(repo,id);}
  await recorder.assertAvailable(accountId);
  const pack=await services.settings.get('delivery.patternPack');
  const verifier=new VerifiedPayments(pack,(kind,data)=>repo.event(id,kind,data),undefined,{readOnly:true});
  if(!pack.recipientBalanceCalibrated)throw Error('Review this server’s recipient balance reply first.');
                                                             
  repo.observe({id,buyerIgn:recipient,amount:amount.toString(),purpose:'Explicit owner-requested nominal transfer/capture; no marketplace fulfillment'},'owner-capture');
  repo.db.prepare('UPDATE delivery_orders SET account_id=? WHERE id=?').run(accountId,id);
  repo.state(id,'VALIDATED');
  let lease,locked=false,intent=false,before=null,after=null;
  const step=async(name,fn)=>{await options.fault?.('before',name);const value=await fn();await options.fault?.('after',name);return value;};
  try{
    lease=await step('lease',()=>services.sessions.acquire(accountId,'owner-payment-capture:'+requestId,{ttlMs:120000}));
    await step('ready',()=>lease.ready());
    await recorder.assertAvailable(accountId);
    const bot=lease.getBot();repo.event(id,'CONNECTION',connectionRecord(bot,accountId,lease.getClient?.()));
    await verifier.exclusive(bot,async raw=>{
      before=await step('sender-before',()=>verifier.readBalance(raw));
      if(before<amount)throw Error('Verified sender balance is below the explicitly requested amount; no payment was sent.');
      if(!repo.lock(id,accountId,id,before,before))throw Error('Account became reserved; no payment was sent.');
      locked=true;
      await step('recipient-before',()=>verifier.readRecipientBalance(raw,recipient));
      if(await require('../treasury/trading-controls').globallyEnabled(services.settings))throw Error('Ordinary trading must remain stopped during this controlled capture.');
                                                                             
                                                                        
      repo.intent(id,0,{net:amount,command:amount,debit:amount},before);intent=true;
      await step('pay-command',async()=>{
        if(await require('../treasury/trading-controls').globallyEnabled(services.settings))throw Error('Trading resumed before the capture command; review its intent.');
        const command='/pay '+recipient+' '+amount;
        repo.event(id,'command',{command,wallMs:Date.now(),monotonicNs:process.hrtime.bigint().toString(),scope:'Explicit owner transfer command; outcome not yet verified'});
        raw.chat(command);repo.sent(id,0);
      });
                                                                               
                                                                                   
      await step('record-window',()=>options.wait?options.wait(pack.timeoutMs):new Promise(resolve=>setTimeout(resolve,pack.timeoutMs)));
      after=await step('sender-after',()=>verifier.readBalance(raw));
      await step('recipient-after',()=>verifier.readRecipientBalance(raw,recipient));
      repo.db.prepare('UPDATE delivery_chunks SET after_balance=?,result=? WHERE order_id=? AND chunk_index=0').run(after.toString(),JSON.stringify({before:before.toString(),after:after.toString(),observedDebit:(before-after).toString(),paymentVerified:false}),id);
    });
    repo.state(id,'NEEDS_OPERATOR',amount+'-coin command captured once. Observed sender debit '+(before-after)+'. Review the actual server confirmation and record; no automatic retry or marketplace action is permitted.');
  }catch(error){
    repo.state(id,'NEEDS_OPERATOR',(intent?'Payment intent exists; outcome requires review. Never resend automatically. ':'No payment intent was created. ')+error.message);
    if(locked&&!intent){repo.release(id);locked=false;}
    if(error.simulatedCrash)throw error;
  }finally{lease?.release();}
                                                                            
  try{
    const history=repo.history(id),connections=history.filter(e=>e.kind==='CONNECTION').map(e=>JSON.parse(e.data));
    const data={orderId:id,buyerIgn:recipient,amount:amount.toString(),amountMeaning:'Explicit owner nominal transfer/capture, separate from every marketplace order',recipientNet:'not captured',sellerIgn:connections.at(-1)?.holderIgn||null,state:repo.get(id).state,mode:'owner-capture',preBalance:before?.toString()??null,postBalance:after?.toString()??null,chunks:repo.chunks(id),history,connection:connections,capturedChatLines:history.filter(e=>e.kind==='chat').map(e=>JSON.parse(e.data)),commands:history.filter(e=>e.kind==='command').map(e=>({...JSON.parse(e.data),wallMs:e.wall_ms,monotonicNs:e.monotonic_ns})),transcript:[],ledgerRows:[]};
    const evidence=await step('evidence',()=>options.buildEvidence?options.buildEvidence(data):new(require('../marketplace/proof-generator').ProofGenerator)(undefined,{vault:services.vault}).generateDeliveryProof(data));
    repo.db.prepare('UPDATE delivery_orders SET evidence=? WHERE id=?').run(JSON.stringify(evidence),id);
  }catch(error){repo.event(id,'EVIDENCE_ERROR',{reason:error.message});}
  services.events?.emit('operator:alert',{component:'payment-capture',orderId:id,reason:repo.get(id).reason});
  return result(repo,id);
}
function result(repo,id){const row=repo.get(id),payload=JSON.parse(row.payload);return {id,state:row.state,reason:row.reason,accountId:row.account_id,recipient:payload.buyerIgn,nominalAmount:payload.amount,scope:'Controlled real owner transfer/capture, not marketplace fulfillment',chunks:repo.chunks(id),history:repo.history(id),evidence:row.evidence?JSON.parse(row.evidence):null,marketplaceActions:0,paymentVerified:false};}
module.exports={captureOneCoin,result};
