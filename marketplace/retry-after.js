'use strict';
function retryAfterMs(headers,now=Date.now()){
 const value=headers?.get?.('retry-after')??headers?.['retry-after']??headers?.['Retry-After'];
 let delay=30000;
 if(value!=null&&String(value).trim()!==''){
  const seconds=Number(value);delay=Number.isFinite(seconds)&&seconds>=0?seconds*1000:Date.parse(value)-now;
 }
 if(!Number.isFinite(delay)||delay<0)delay=30000;
 return Math.max(1000,Math.min(300000,Math.ceil(delay)));
}
module.exports={retryAfterMs};
