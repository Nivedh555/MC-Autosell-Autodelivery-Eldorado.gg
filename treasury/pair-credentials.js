'use strict';
const controls = require('./trading-controls');

async function configure(services, pair) {
  const roles = {...await services.settings.get('treasury.accountRoles')};
  const buyer = controls.canonical(pair.buyerId), seller = controls.canonical(pair.sellerId);
  if (pair.buyerEmail?.trim()) roles[buyer] = {...roles[buyer],role:'intake',ign:pair.buyerIgn,holderAccount:controls.hasHolder(pair)?seller:buyer};
  else delete roles[buyer];
  if (pair.sellerEmail?.trim()) roles[seller] = {...roles[seller],role:'holder',ign:pair.sellerIgn};
  else delete roles[seller];
  await services.settings.set('treasury.accountRoles',roles,'pair-credentials');
  for (const role of ['buyer','seller']) {
    const id=controls.canonical(pair[role+'Id']);
    for (const suffix of ['email','ign']) {
      const key='mc.'+id+'.'+suffix;
      if (!services.settings.definitions.has(key)) services.settings.register({id:key,type:'string',default:'',group:'Minecraft accounts',secret:false});
      await services.settings.set(key,pair[role+(suffix==='email'?'Email':'Ign')]||'','pair-credentials');
    }
    if (pair[role+'Email']?.trim()) (services.sessions||services.sessionManager)?.getClient(id);
  }
}

                                                                             
                                                                                
let tail=Promise.resolve();
function update(services,input) {
  const work=tail.then(async()=>{
    const manager=services.pairManager, previous=manager.getPair(input.id);
    controls.assertEditable(previous);
    const accounts = new Map();
    for (const saved of manager.getPairs()) {
      const pair = saved.id === input.id ? { ...saved, ...input } : saved;
      for (const role of ['buyer','seller']) {
        const email = String(pair[role+'Email'] || '').trim().toLowerCase();
        if (!email) continue;
        const id = controls.canonical(pair[role+'Id']);
        if (accounts.has(email)) throw Error('The same Microsoft login is assigned to ' + accounts.get(email) + ' and ' + id + '. For Discord intake use Buyer only and leave Seller empty.');
        accounts.set(email, id);
      }
    }
    const changed=['buyer','seller'].filter(role=>['Email','Ign'].some(key=>String(previous[role+key]||'').trim()!==String(input[role+key]??previous[role+key]??'').trim()));
    const sessions=services.sessions||services.sessionManager;
    const blocked=services.accountUpdates||(services.accountUpdates=new Set());
    const reconnect=[];
    const ids=changed.map(role=>controls.canonical(previous[role+'Id']));
    try {
      for(const id of ids) blocked.add(id);
      const deadline=Date.now()+15000;
      while(ids.some(id=>sessions?.getLeases?.(id)?.length)) {
        if(Date.now()>=deadline) throw Error('This account is busy. Let its current balance check or job finish, then save again.');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      controls.assertEditable(manager.getPair(input.id));
      for(const [index,role] of changed.entries()) {
        const id=ids[index],client=sessions?.clients?.get(id);
        if(client) {
          if(client.isOnline?.()||client._connectPromise||String(client.state).toLowerCase()==='connecting')reconnect.push(id);
          await client.disconnect('Updating '+role+' credentials');
        }
        if(String(input[role+'Email']??previous[role+'Email']??'').trim().toLowerCase()!==String(previous[role+'Email']||'').trim().toLowerCase() && (!input[role+'Ign']||input[role+'Ign']===previous[role+'Ign']))input[role+'Ign']='';
      }
      const pair=manager.savePair(input);
      await configure(services,pair);
      for(const id of ids)blocked.delete(id);
      for(const id of reconnect) {
        const role=id.startsWith('seller')?'seller':'buyer';
        if(pair[role+'Email']?.trim())Promise.resolve().then(()=>sessions.getClient(id).connect()).catch(error=>services.events?.emit('operator:alert',{component:'minecraft',accountId:id,reason:'Credentials saved, but reconnection failed: '+error.message}));
      }
      return {pair,hotReloaded:true,reconnecting:reconnect.filter(id=>pair[(id.startsWith('seller')?'seller':'buyer')+'Email']?.trim())};
    }finally{for(const id of ids)blocked.delete(id);}
  });
  tail=work.catch(()=>{});return work;
}
module.exports={configure,update};
