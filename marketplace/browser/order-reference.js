'use strict';
                                                                          
                                                                              
async function readReference(page,order,timeoutMs=15000,{ownerReview=false,customerCancellation=false}={}){
  let stage='order navigation';
  try{return await readReferencePage(page,order,timeoutMs,value=>{stage=value;},ownerReview||customerCancellation&&require('../order-status').closure(order.status)==='canceled');}
  catch(error){if(error.name!=='TimeoutError')throw error;throw Object.assign(Error('Eldorado '+stage+' timed out for order '+order.id+'. Check that this order and its buyer chat load in the connected seller profile. This read sent no payment or message.',{cause:error}),{code:'ELDORADO_ORDER_READ_TIMEOUT'});}
}
async function readReferencePage(page,order,timeoutMs,setStage,ownerReview){
  const url=new URL(order.orderUrl);
  if(url.origin!=='https://www.eldorado.gg'||url.pathname!=='/order/'+order.id||url.search||url.hash||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(order.id))throw Error('A captured exact order link is required.');
  const sameOrder=()=>{try{const current=new URL(page.url());return current.origin===url.origin&&current.pathname===url.pathname&&!current.hash&&[...current.searchParams.keys()].every(key=>key==='backButtonParams');}catch{return false;}};
  if(!sameOrder()){
                                                                          
                                                                                
    const capturedLink=page.locator('eld-dashboard-orders-list a[href^="/order/'+order.id+'"]');
    if(await capturedLink.count()===1)await capturedLink.click({timeout:timeoutMs});
    else await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:timeoutMs});
  }
  setStage('order details');
  await page.locator('eld-seller-order-details-card').waitFor({state:'visible',timeout:timeoutMs});
  const details=await page.evaluate(()=>{
    const header=document.querySelector('eld-order-header'),card=document.querySelector('eld-seller-order-details-card');
    if(document.querySelectorAll('eld-seller-order-page').length!==1||!header||!card)throw Error('The captured seller order layout changed.');
    const value=label=>{
      const nodes=[...card.querySelectorAll('span')].filter(n=>n.textContent.trim()===label);
      if(nodes.length!==1||nodes[0].parentElement.children.length!==2)throw Error('Order detail is missing or ambiguous: '+label);
      return nodes[0].parentElement.children[1].textContent.trim();
    };
    const ids=[...header.querySelectorAll('span')].map(n=>n.textContent.trim()).filter(text=>text.startsWith('Order ID: '));
    if(ids.length!==1)throw Error('Order header identity changed.');
    return {id:ids[0].slice('Order ID: '.length),status:header.querySelector('eld-chip')?.textContent.trim(),gameLabel:value('Game'),quantityDisplay:value('Quantity'),buyerName:value('Buyer'),controls:[...document.querySelectorAll('eld-seller-order-state-card button[aria-label]')].filter(n=>n.getClientRects().length).map(n=>n.getAttribute('aria-label'))};
  });
  if(order.hybridApiOrder){
    const closure=require('../order-status').closure;
    const expected=closure(order.status),observed=closure(details.status);
    if(expected&&expected===observed)details.status=order.status;
  }
  if(details.id!==order.id||details.buyerName!==order.buyerName||details.gameLabel!==order.gameLabel||(order.hybridApiOrder?require('./observed-offers').coins(details.quantityDisplay)!==String(order.amount):details.quantityDisplay!==order.quantityDisplay))throw Error('Order page differs from its captured order. Refresh history before reviewing it.');
  const {closure}=require('../order-status');
  if(!ownerReview && (closure(details.status)==='canceled'||closure(details.status)==='completed' && !closure(order.status))){
    if(!sameOrder())throw Error('Order page changed during status capture.');
    return {...details,chatText:'',messages:[],capturedAt:new Date().toISOString(),referenceOnly:true,executionEligible:false,source:'Captured terminal seller order header; room was not inspected',paymentsSent:0,messagesSent:0};
  }
  setStage('buyer chat loading');
  await page.locator('eld-chat-skeleton').waitFor({state:'hidden',timeout:timeoutMs});
  const chat=require('./observed-chat'),frame=await chat.frameFor(page,order.buyerName,timeoutMs);
  setStage('chat messages');
  const {text,messages}=await chat.capture(frame,order.id,timeoutMs);
  if(text.split(/\r?\n/).find(line=>line.trim())!==order.buyerName)throw Error('The chat room header differs from the order buyer.');
  if(!sameOrder())throw Error('Order page changed during reference capture.');
  return {...details,chatText:text,messages,recipient:require('../ign-rules').recipientCandidates(messages),chatSource:'captured visible TalkJS room text; individual message authors/identifiers not yet verified',capturedAt:new Date().toISOString(),referenceOnly:true,executionEligible:false,source:'captured seller order page and embedded chat',paymentsSent:0,messagesSent:0};
}
module.exports={readReference};
