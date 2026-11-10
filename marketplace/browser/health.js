'use strict';
class BrowserHealth {
  constructor({now=Date.now}={}){this.now=now;this.failures=0;this.until=0;this.trips=0;}
  assertAvailable(){if(this.now()<this.until)throw Object.assign(Error('Browser recovery cooldown; next check at '+new Date(this.until).toISOString()),{code:'BROWSER_COOLDOWN',retryAt:this.until});}
  success(){this.failures=0;this.until=0;this.trips=0;}
  failure(error){
    if(error.code==='BROWSER_COOLDOWN')return;
    // A missing receipt/business rejection is an order problem, not evidence
    // that the entire browser is unhealthy. Never reset its action journal.
    if(error.name!=='TimeoutError'&&!/net::ERR_|Target (?:page|browser|context).*closed|sign[ -]in|signed-in seller account did not load|ELDORADO_ORDER_READ_TIMEOUT/i.test(error.code+' '+error.message))return;
    if(++this.failures>=3){this.until=this.now()+Math.min(300000,30000*2**Math.min(this.trips++,4));}
  }
  status(){return {state:this.now()<this.until?'COOLDOWN':this.failures>=3?'PROBE':'READY',consecutiveFailures:this.failures,retryAt:this.until||null};}
}
module.exports={BrowserHealth};
