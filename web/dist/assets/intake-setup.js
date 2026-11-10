'use strict';
(() => {
  const $ = id => document.getElementById(id); let state, activeCapture, timer, feedbackTarget;
  const tell = (message,error=false) => {
    const output=$('feedback');output.textContent=message;output.classList.toggle('error',error);
    if($('setup').hidden)document.querySelector('main').insertBefore(output,$('login-card'));
    else if(feedbackTarget?.id==='login')$('setup').prepend(output);
    else if(feedbackTarget?.tagName==='FORM')feedbackTarget.append(output);
    else if(feedbackTarget)feedbackTarget.closest('section')?.append(output);
  };
  async function request(path,body) {
    const csrf=decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/)?.[1]||'');
    const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok){if(response.status===401){$('login-card').hidden=false;$('setup').hidden=true;}throw Error(typeof data.error==='string'?data.error:data.error?.message||'Request failed');}return data;
  }
  const micros = value => {if(!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))throw Error('Use positive USD limits with at most six decimals');const [n,f='']=value.split('.');return String(BigInt(n)*1000000n+BigInt(f.padEnd(6,'0')));};
  function option(select,value,label){const item=document.createElement('option');item.value=value;item.textContent=label;select.append(item);}
  async function refresh(fill=true){
    state=await request('/intake/status');$('login-card').hidden=true;$('setup').hidden=false;
    const checks=[['Buyer configured',state.accounts.length>0],['Buyer online',state.accounts.some(a=>a.online)],['Receipt format saved',state.incomingConfigured],['Payout policy enabled',Boolean(state.payoutPolicy.enabled)],['Wallet configured',state.walletConfigured],['Send LTC enabled',state.sendEnabled],['Money buying enabled',state.buyMoneyEnabled],['Spawner buying enabled',state.buySkellyEnabled]];
    $('checks').replaceChildren();for(const [label,ok] of checks){const li=document.createElement('li');li.textContent=(ok?'Ready · ':'Needs setup · ')+label;li.className=ok?'good':'wait';$('checks').append(li);}
    const selected=$('account').value;$('account').replaceChildren();for(const a of state.accounts)option($('account'),a.id,a.id+' · '+(a.ign||'IGN not detected')+(a.online?' · online':' · offline'));if(selected)$('account').value=selected;
    const capture=$('capture-id').value;$('capture-id').replaceChildren();option($('capture-id'),'','Choose a capture');for(const run of state.captures)option($('capture-id'),run.id,run.account_id+' · '+new Date(run.started_ms).toLocaleString()+' · '+run.state);$('capture-id').value=activeCapture||capture;
    if(fill){const p=state.payoutPolicy;$('address-mode').value=p.addressMode||'linked-seller';$('addresses').value=(p.allowedAddresses||[]).join('\n');$('per-tx').value=p.maxPerTxFiatMicros?Number(p.maxPerTxFiatMicros)/1e6:'';$('per-day').value=p.maxPerDayFiatMicros?Number(p.maxPerDayFiatMicros)/1e6:'';$('payout-enabled').checked=Boolean(p.enabled);$('send-enabled').checked=state.sendEnabled;}
  }
  function action(id,fn){const element=$(id);element.addEventListener(element.tagName==='FORM'?'submit':'click',async event=>{event.preventDefault();feedbackTarget=element;const buttons=[...element.querySelectorAll('button')];if(element.tagName==='BUTTON')buttons.push(element);for(const b of buttons)b.disabled=true;try{await fn();}catch(error){tell(error.message,true);}finally{for(const b of buttons)b.disabled=false;}});}
  action('login',async()=>{const password=$('password').value;try{await request('/auth/login',{password,dashboardSession:true});await refresh();tell('Signed in.');}finally{$('password').value='';}});
  action('refresh',async()=>{await refresh();tell('Status refreshed.');});
  action('policy',async()=>{await request('/intake/policy',{enabled:$('payout-enabled').checked,addressMode:$('address-mode').value,allowedAddresses:$('addresses').value.split(/\s+/).filter(Boolean),maxPerTxFiatMicros:micros($('per-tx').value),maxPerDayFiatMicros:micros($('per-day').value)});await request('/config',{ltcSendEnabled:$('send-enabled').checked});await refresh();tell('Payout settings saved. No transaction was sent.');});
  action('pause',async()=>{await request('/marketplace/controls',{enabled:false});await refresh(false);tell('Intake paused. You can capture a test receipt.');});
  action('resume',async()=>{await request('/marketplace/controls',{enabled:true});await refresh(false);tell('Intake resumed. New sales still check every prerequisite.');});
  async function loadCapture(){const id=$('capture-id').value;if(!id)throw Error('Choose a capture');const data=await request('/ops/calibration/'+encodeURIComponent(id));const chosen=$('event-id').value;$('event-id').replaceChildren();option($('event-id'),'','Select the actual incoming payment receipt');for(const e of data.events||[]){if(e.kind!=='chat')continue;const line=JSON.parse(e.data);if(line.sender||line.position==null||line.position==='chat')continue;option($('event-id'),String(e.id),line.raw);}$('event-id').value=chosen;$('event-id').dispatchEvent(new Event('change'));return data;}
  $('event-id').addEventListener('change',()=>{$('raw-receipt').textContent=$('event-id').selectedOptions[0]?.value?$('event-id').selectedOptions[0].textContent:'Select the actual incoming payment line, not the /bal reply.';});
  action('load-capture',loadCapture);
  action('capture',async()=>{const accountId=$('account').value;if(!accountId)throw Error('Configure Buyer1 in AutoSell Pairs first');if(state.enabled)throw Error('Pause intake before starting a capture');const result=await request('/ops/calibration/start',{accountId,confirmation:'CAPTURE '+accountId});activeCapture=result.id;await refresh(false);$('capture-id').value=activeCapture;$('capture-info').textContent='Recording for 60 seconds. Have another player send a known small test amount to '+($('account').selectedOptions[0]?.textContent||accountId)+'. No automatic LTC payout occurs during this setup capture.';tell('Capture started.');clearInterval(timer);const deadline=Date.now()+65000;timer=setInterval(()=>{if(Date.now()>deadline){clearInterval(timer);return;}loadCapture().catch(()=>{});},2000);});
  action('receipt',async()=>{const result=await request('/intake/incoming',{captureId:$('capture-id').value,eventId:Number($('event-id').value),ign:$('sender').value.trim(),amountText:$('amount').value.trim(),confirmation:'USE CAPTURED INCOMING RECEIPT'});clearInterval(timer);await refresh(false);tell(result.message);});
  window.addEventListener('pagehide',()=>clearInterval(timer));
  if(window.gsap){const media=gsap.matchMedia();media.add('(prefers-reduced-motion: no-preference)',()=>{gsap.from('.intro',{y:12,opacity:0,duration:.45,ease:'power2.out'});});}
  refresh().catch(error=>tell(error.message==='Unauthorized'?'Sign in with your dashboard password.':error.message,true));
})();
