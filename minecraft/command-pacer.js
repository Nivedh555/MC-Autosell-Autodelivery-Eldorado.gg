'use strict';
class CommandPacer {
 constructor({intervalMs=1100,now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){this.intervalMs=intervalMs;this.now=now;this.sleep=sleep;this.tails=new Map();this.last=new Map();}
 run(account,send){
  const work=(this.tails.get(account)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const wait=this.last.has(account)?this.intervalMs-(this.now()-this.last.get(account)):0;
   if(wait>0)await this.sleep(wait);
   this.last.set(account,this.now());
   return send();
  });
  this.tails.set(account,work);
  work.finally(()=>{if(this.tails.get(account)===work)this.tails.delete(account);}).catch(()=>{});
  return work;
 }
 mark(account){this.last.set(account,this.now());}
}
const pacers=new WeakMap();
function paceCommand(bot,send){
 if(bot.transport!=='fabric')return send();
 let pacer=pacers.get(bot);if(!pacer){pacer=new CommandPacer();pacers.set(bot,pacer);}
 return pacer.run('commands',send);
}
function markDispatched(bot){const pacer=pacers.get(bot);if(pacer)pacer.mark('commands');}
module.exports={CommandPacer,paceCommand,markDispatched};
