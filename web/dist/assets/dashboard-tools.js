const tabs = new Set(['overview','pairs','analytics','orders','eldorado-setup','treasury','sales','sellers','user-data','env-studio','wallet','ai-chat','controls']);
const aliases={clients:'pairs',connections:'eldorado-setup',buying:'controls',review:'orders'};
export function tabFromHash(){const id=location.hash.slice(1);return aliases[id]||(tabs.has(id)?id:'pairs');}

export function dashboardTools(React,request){
  const {createElement:h,useState,useEffect}=React;
  const post=(url,body)=>request(url,{method:'POST',body:JSON.stringify(body)});
  const button=(label,onClick,disabled=false,primary=false)=>h('button',{type:'button',onClick,disabled,className:primary?'desk-primary':undefined},label);
  const label=(title,control)=>h('label',null,title,control);
  const section=(title,...children)=>h('section',{className:'desk-panel'},h('h3',null,title),...children);
  const row=(...items)=>h('div',{className:'desk-row'},...items);
  const note=text=>h('p',null,text);
  const startupError=error=>error?.status===404?'Restart Start-Windows.cmd to load startup checks.':error?.message||'Startup check could not finish. Try again.';
  async function checkStartupAfterBrowserOpen(){
    try{
      const data=await post('/marketplace/startup/check',{});
      if(!Array.isArray(data?.steps))throw Error('Restart Start-Windows.cmd to load startup checks.');
      window.dispatchEvent(new CustomEvent('autosell:startup-changed'));
      const browser=data.steps.find(step=>step.id==='browser');
      return browser?.state==='ready'?'Seller browser connected and login verified. '+data.headline+' '+(data.nextAction||''):
        'Seller browser opened. Sign in to Eldorado in that browser, then click Check startup. '+(browser?.detail||data.headline||'');
    }catch(error){
      window.dispatchEvent(new CustomEvent('autosell:startup-changed'));
      return 'Seller browser opened. Sign in to Eldorado in that browser, then click Check startup. '+startupError(error);
    }
  }
  function BrowserConnection({bridge}){
    const state=bridge?.state;
    let label='Seller browser disconnected';
    if(state==='OPENING') label='Connecting to seller browser…';
    else if(state==='NEEDS_OPERATOR') label='Seller browser needs attention';
    else if(bridge?.connected) label='Seller browser connected';
    const reason=(bridge?.reason||'').replace(/\s*Trading is paused\.?$/i,'').trim();
    const verified=bridge?.sellerCheck?.identityMatched&&bridge?.sellerCheck?.compatible;
    const detail=verified?'Seller login verified. Check the offer separately in Delivery readiness.':bridge?.connected?
      'Sign in to Eldorado in this browser, then click Check startup to verify the seller account.':reason;
    const browser={chrome:'Google Chrome',msedge:'Microsoft Edge',chromium:'Bundled Chromium'}[bridge?.channel];
    return h('div',{className:'desk-browser-status','aria-live':'polite'},
      h('strong',null,label),bridge?.busy?h('p',null,'Working: '+(bridge.currentOperation||'browser check')):null,
      bridge?.connected?h('p',null,[browser,bridge.chromeProfile,bridge.browserVersion].filter(Boolean).join(' · ')):null,
      h('p',null,detail||'Open the seller browser and sign in to Eldorado.'));
  }
  function StartupPanel(){
    const [status,setStatus]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState('');
    const sequence=React.useRef(0),pending=React.useRef(false);
    async function load(remote=false,enabled){
      if(pending.current)return;
      const writing=remote||typeof enabled==='boolean';
      if(writing){pending.current=true;setBusy(remote?'Checking seller and offer…':'Updating Global Autosell…');}
      const current=++sequence.current;
      try{
        if(typeof enabled==='boolean'){
          await post('/marketplace/controls',{enabled});
          window.dispatchEvent(new CustomEvent('autosell:global-changed',{detail:enabled}));
        }
        const data=remote?await post('/marketplace/startup/check',{}):await request('/marketplace/startup');
        if(current!==sequence.current)return;
        if(!Array.isArray(data?.steps)||typeof data.headline!=='string')throw Error('Restart Start-Windows.cmd to load startup checks.');
        setStatus(data);setError('');
      }catch(e){
        if(current===sequence.current){setError(startupError(e));setStatus(null);}
      }finally{if(writing){pending.current=false;setBusy('');}}
    }
    useEffect(()=>{
      const refresh=()=>load();
      refresh();
      const timer=setInterval(refresh,6000);
      window.addEventListener('autosell:authenticated',refresh);
      window.addEventListener('autosell:startup-changed',refresh);
      window.addEventListener('autosell:global-changed',refresh);
      return()=>{sequence.current++;clearInterval(timer);window.removeEventListener('autosell:authenticated',refresh);window.removeEventListener('autosell:startup-changed',refresh);window.removeEventListener('autosell:global-changed',refresh);};
    },[]);
    const labels={ready:'Ready',blocked:'Action needed',waiting:'Waiting',unknown:'Unchecked'};
    function jump(id){
      if(id==='game'){location.hash='pairs';return;}
      const section=document.getElementById(id==='browser'?'seller-browser-setup':id==='automation'?'buyer-message-setup':'currency-offer-setup');
      if(section){section.scrollIntoView({block:'start'});section.focus({preventScroll:true});}
    }
    return h('section',{className:'desk-panel desk-startup','aria-labelledby':'delivery-readiness-title'},
      h('h3',{id:'delivery-readiness-title'},'Delivery readiness'),
      error?h('p',{role:'alert'},error):h('div',{role:'status'},
        h('strong',null,status?.headline||'Checking delivery setup…'),
        status?.nextAction?h('p',null,status.nextAction):null),
      status?h('ol',{className:'desk-readiness-steps'},...status.steps.map(step=>h('li',{key:step.id,'data-startup-step':step.id},
        h('div',null,h('b',null,step.label),h('span',{className:step.state==='ready'?'desk-online':'desk-offline'},labels[step.state]||'Unchecked')),
        step.detail?h('p',null,step.detail):null,
        step.state!=='ready'&&step.nextAction?h('p',{className:'desk-next-action'},step.nextAction):null,
        step.state!=='ready'&&['browser','game','offer'].includes(step.id)?button({browser:'Seller browser settings',game:'Open AutoSell Pairs',offer:'Offer settings'}[step.id],()=>jump(step.id)):null))):null,
      note('Check startup verifies seller login and reads the offer. Automation is controlled separately below.'),
      row(button(busy==='Checking seller and offer…'?'Checking startup…':'Check startup',()=>load(true),Boolean(busy),true),
        typeof status?.globalEnabled==='boolean'?button(status.globalEnabled?'Pause automation':'Enable automation',()=>load(false,!status.globalEnabled),Boolean(busy)):null),
      busy?h('output',{'aria-live':'polite'},busy):null);
  }
  function useAction(){
    const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
    return {busy,message,status:h('output',{'aria-live':'polite'},message),run:async fn=>{
      if(busy)return; setBusy(true);setMessage('');
      try{setMessage((await fn())||'');}catch(e){setMessage(e.message);}finally{setBusy(false);}
    }};
  }
  function useData(url,interval=0){
    const [data,setData]=useState(null),[error,setError]=useState('');
    useEffect(()=>{let live=true;async function read(){try{const result=await request(url);if(live){setData(result);setError('');}}catch(e){if(live)setError(e.message);}}
      const events=url==='/marketplace/startup'?['autosell:authenticated','autosell:startup-changed','autosell:global-changed']:['autosell:authenticated'];
      read();events.forEach(event=>window.addEventListener(event,read));const timer=interval?setInterval(read,interval):null;
      return ()=>{live=false;clearInterval(timer);events.forEach(event=>window.removeEventListener(event,read));};
    },[url,interval]);return [data,setData,error];
  }
  function AutomationStatus(){
    const [status,,error]=useData('/marketplace/startup',6000);
    const enabled=error?undefined:status?.globalEnabled;
    return h('a',{href:'#eldorado-setup',className:'desk-automation-status'+(enabled===true?' is-on':''),
      title:error||status?.headline||'Open Eldorado Setup to check startup'},
      enabled===true?'AUTOMATION ON':enabled===false?'AUTOMATION OFF':'STARTUP UNCHECKED');
  }
  function downloadPair(data){
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='autosell-bridge.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function SellerCredentials({onChange}){
    const [setup,,error]=useData('/marketplace/setup');
    const [clientId,setId]=useState(''),[clientSecret,setSecret]=useState(''),[saved,setSaved]=useState(null);
    const action=useAction(),configured=saved||setup;
    async function save(){await action.run(async()=>{
      const body={...(clientId.trim()?{clientId:clientId.trim()}:{}),...(clientSecret.trim()?{clientSecret:clientSecret.trim()}: {})};
      if(!Object.keys(body).length)return 'No replacement credentials entered. Your saved credentials are unchanged.';
      const result=await post('/marketplace/config',body);setSaved(result);setId('');setSecret('');await onChange?.();return result.message;
    });}
    async function check(){await action.run(async()=>{
      if(clientId.trim()||clientSecret.trim())throw Error('Save your edited credentials first. This check uses the saved values.');
      const result=await post('/marketplace/test-connection',{});
      return (result.success?result.message||'Seller API connection passed.':result.error||'Seller API check failed.')+(result.restartRequired?' '+(result.workerMessage||'Restart Autosell to load the saved connection.'):'');
    });}
    return section('Seller API credentials',note('Use the Client ID and full Client secret from the same active Eldorado credential. Browser sign-in is checked separately. Saved values stay encrypted.'),
      label('Client ID',h('input',{type:'password',autoComplete:'off',value:clientId,onChange:e=>setId(e.target.value),placeholder:configured?.clientIdConfigured?'Saved — leave blank to keep':'Enter Client ID'})),
      label('Client secret',h('input',{type:'password',autoComplete:'new-password',value:clientSecret,onChange:e=>setSecret(e.target.value),placeholder:configured?.clientSecretConfigured?'Saved — leave blank to keep':'Enter full Client secret'})),
      note('The last four secret characters shown in Eldorado’s credentials list are not the full secret.'),
      row(button('Save API credentials',save,action.busy||!setup),button(action.busy?'Working…':'Check API connection',check,action.busy||!setup)),
      action.busy?h('output',{'aria-live':'polite'},'Working on the seller API request…'):action.status,error?note(error):null);
  }
  function PrismClients({pairs=[],onChange}){
    const [overview,setOverview,error]=useData('/v3/overview',4000),[show,setShow]=useState(false),[image,setImage]=useState(null);
    const action=useAction();
    const slots=pairs.flatMap(p=>['buyer','seller'].map(role=>role+p.pairIndex));
    async function pair(event){
      event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));
      await action.run(async()=>{const data=await post('/v3/game/pair',body);downloadPair(data);setOverview(await request('/v3/overview'));onChange?.();setShow(false);return 'Pairing file downloaded. Save it in this instance’s config folder, then restart Minecraft.';});
    }
    return h('div',{id:'prism-clients'},section('Minecraft delivery clients',
      note('Open Prism Launcher → Autosell Delivery using your paired Minecraft account. Join the configured server and keep the game open during delivery.'),
      ...(overview?.accounts||[]).map(a=>h('div',{key:a.id,className:'desk-row'},h('strong',null,a.id+' · '+a.ign),h('span',{className:a.connected?'desk-online':'desk-offline'},a.connected?'Online':'Offline'),
        button('Capture screenshot',()=>action.run(async()=>{const result=await post('/v3/game/capture',{accountId:a.id});setImage(result.url);}),action.busy||!a.connected))),
      error?note(error):null,row(button(show?'Close pairing':'Pair a client',()=>setShow(!show),action.busy)),
      show?h('form',{className:'desk-form',onSubmit:pair},label('Account slot',h('select',{name:'accountId',defaultValue:slots.includes('seller1')?'seller1':slots[0]},...slots.map(id=>h('option',{key:id},id)))),
        label('Exact Minecraft IGN',h('input',{required:true,name:'ign',autoComplete:'off',maxLength:17})),h('button',{disabled:action.busy||!slots.length},'Download pairing file'),
        note('Downloading a new pairing file replaces the old token for this slot.')):null,
      image?h('div',null,h('img',{src:image,className:'desk-thumb',alt:'Actual Minecraft client capture'}),button('Close screenshot',()=>setImage(null))):null,action.status));
  }
  function CompetitorPrices(){
    const [preview,setPreview]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
    async function compare(){
      if(loading)return;
      setLoading(true);setError('');setPreview(null);
      try{
        const data=await post('/marketplace/pricing/preview',{});
        if(!Array.isArray(data?.rows)||data.currency!=='USD'||data.unit!=='1M'||!Number.isFinite(new Date(data.checkedAt).getTime())){
          throw Error('The server returned an incomplete comparison. Refresh the page and try again.');
        }
        setPreview(data);
      }catch(cause){
        const guidance={403:'Access denied. Check your dashboard sign-in and Seller API permissions.',429:'Eldorado is limiting requests. Wait before comparing again.'};
        setError([guidance[cause.status],cause.message].filter(Boolean).join(' ')||'Could not load competitor prices.');
      }finally{setLoading(false);}
    }
    const coins=value=>/^\d+$/.test(String(value))?BigInt(value).toLocaleString('en-US'):'Unknown';
    return h('div',null,
      row(button(loading?'Comparing prices…':'Compare competitor prices',compare,loading)),
      error?h('p',{role:'alert'},error):null,
      preview?h('div',{role:'region','aria-label':'Competitor price comparison'},
        h('p',{role:'status'},'For '+coins(preview.comparisonCoins)+' coins: '+preview.distinctSellers+' qualifying '+(preview.distinctSellers===1?'seller':'sellers')+' across '+preview.eligibleOffers+' '+(preview.eligibleOffers===1?'offer':'offers')+'.'),
        h('p',null,'Checked ',h('time',{dateTime:new Date(preview.checkedAt).toISOString()},new Date(preview.checkedAt).toLocaleString()),' · '+preview.source),
        preview.rows.length?h('div',{style:{overflowX:'auto'}},h('table',{style:{width:'100%',textAlign:'left',fontSize:'.85rem'}},
          h('caption',{style:{textAlign:'left',padding:'6px 0'}},'Cheapest qualifying sellers, one offer per seller'),
          h('thead',null,h('tr',null,...['Seller','Price (USD/M)','Stock (coins)','Minimum (coins)'].map(title=>h('th',{key:title,scope:'col',style:{padding:'6px'}},title)))),
          h('tbody',null,...preview.rows.map((entry,index)=>h('tr',{key:index},
            h('th',{scope:'row',style:{padding:'6px'}},entry.seller),
            h('td',{style:{padding:'6px',whiteSpace:'nowrap'}},'$'+entry.pricePerMillion+'/M'),
            h('td',{style:{padding:'6px'}},coins(entry.stockCoins)),h('td',{style:{padding:'6px'}},coins(entry.minimumCoins))))))):
          note('No other active seller offers matched this order size and stock requirement.')):null);
  }
  function OfferLink({listing={},onChange}){
    const [options,setOptions]=useState(null),action=useAction();
    async function link(event){event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));await action.run(async()=>{await post('/v3/eldorado/offer',body);setOptions(null);await onChange?.();window.dispatchEvent(new CustomEvent('autosell:startup-changed'));return 'Offer linked to '+body.accountId+'. Open Delivery readiness and click Check startup.';});}
    return h('div',{id:'currency-offer-setup',tabIndex:-1},section('Existing currency offer',note(listing.offerId?'Linked offer: '+listing.offerId:'After signing in and checking the connection, select the offer this Minecraft account will deliver.'),
      button('Find existing offers',()=>action.run(async()=>{const result=await request('/v3/eldorado/offers');setOptions(result);return result.offers.length?'':'No matching currency offer was found in this seller account.';}),action.busy),
      options?.offers.length?h('form',{onSubmit:link,className:'desk-form'},note('Pause automation before linking a different offer.'),label('Currency offer',h('select',{name:'offerId',required:true,defaultValue:options.offers.some(o=>o.id===listing.offerId)?listing.offerId:''},h('option',{value:'',disabled:true},'Choose your Eldorado listing'),...options.offers.map(o=>h('option',{value:o.id,key:o.id},[o.gameLabel,o.status,o.quantityDisplay,o.pricePerMillion!=null?'$'+o.pricePerMillion+'/M':null,o.id].filter(Boolean).join(' · '))))),
        label('Delivery account',h('select',{name:'accountId'},...options.accounts.map(id=>h('option',{key:id},id)))),h('button',{disabled:action.busy||!options.accounts.length},'Link offer'),
        !options.accounts.length?note('Pair a client under AutoSell Pairs first.'):null):null,action.status,
      listing.offerId&&listing.apiBinding?h(CompetitorPrices,{key:[listing.offerId,listing.apiBinding.gameId,listing.apiBinding.serverId].join('/') }):null));
  }
  function ChatGuide(){
    const [messages,setMessages]=useState(null),[images,setImages]=useState({}),[tax,setTax]=useState(null),[error,setError]=useState(''),action=useAction();
    useEffect(()=>{let live=true;request('/v3/eldorado/customer-messages').then(data=>{if(live){setMessages(data.templates);setImages(data.images);setTax(data.tax);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
    const fields={buyer:'Buyer',amount:'500M',ign:'YourName',url:'https://www.eldorado.gg/order/example'};
    const titles={opening:'Greeting',confirm:'Confirm the recipient',sending:'Before payment',proof:'After payment verification',delivered:'After Eldorado marks the order delivered'};
    const preview=text=>text.replace(/\{(\w+)\}/g,(_,id)=>fields[id]||'{'+id+'}');
    const edit=(key,value)=>setMessages(current=>({...current,[key]:value}));
    const upload=(slot,file)=>action.run(async()=>{
      if(!file||file.type!=='image/png'||file.size>1024*1024)throw Error('Choose a PNG under 1 MB.');
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Could not read image'));reader.readAsDataURL(file);});
      const result=await post('/v3/eldorado/customer-messages/image/'+slot,{dataUrl});
      setImages(current=>({...current,[slot]:result.image}));return result.message;
    });
    const image=(slot,title)=>h('div',{key:slot,className:'desk-example'},h('strong',null,title),images[slot]?h('img',{src:images[slot],alt:title,style:{maxWidth:'100%',maxHeight:'220px',objectFit:'contain'}}):null,
      label('Replace with PNG',h('input',{type:'file',accept:'image/png',disabled:action.busy,onChange:event=>upload(slot,event.target.files?.[0])})));
    return section('Eldorado buyer messages',note('Edit the wording and guide images used for new orders. {buyer}, {amount}, {ign}, and {url} insert order details. A queued message keeps its saved wording.'),
      note(tax?'Observed DonutSMP transfer tax: '+(tax.basisPoints/100).toFixed(2)+'%. The bot deducts it from the funded order amount.':'No verified DonutSMP tax receipt yet. Automatic payments wait until the tax is calibrated.'),
      ...(messages?[
        ...Object.keys(titles).map(key=>h('div',{key,className:'desk-example'},h('strong',null,titles[key]),h('textarea',{value:messages[key],rows:Math.max(3,Math.min(9,messages[key].split('\n').length+1)),onChange:event=>edit(key,event.target.value),style:{width:'100%',marginTop:'.7rem'}}),h('pre',null,preview(messages[key])))),
        button('Save buyer messages',()=>action.run(async()=>{const result=await post('/v3/eldorado/customer-messages',{templates:messages});return result.message;}),action.busy,true),
        note('For proof, the bot sends a cropped payment screenshot only after payment verification. The full screenshot stays in the private owner record.'),
        image('username','Minecraft username guide'),image('confirm','Confirm delivery guide'),image('feedback','Thumbs up guide'),action.status
      ]:[note(error||'Loading messages…')]));
  }
  function BuyingPanel(){
    const [preview,setPreview,error]=useData('/v3/discord/preview'),action=useAction();
    if(!preview)return section('Discord buying panel',note(error||'Loading designs…'));
    return section('Discord buying panel',note('Choose the design for /sell-panel.'),row(label('Panel design',h('select',{disabled:action.busy,value:preview.selected.source+':'+preview.selected.index,onChange:e=>{const [source,index]=e.target.value.split(':');action.run(async()=>{setPreview(await request('/v3/discord/preview?source='+source+'&index='+index));});}},...preview.choices.map(c=>h('option',{key:c.source+c.index,value:c.source+':'+c.index},c.label)))),
      button('Use this design',()=>action.run(async()=>{const r=await post('/v3/discord/design',preview.selected);return 'Selected '+r.label+'.';}),action.busy)),h('div',{className:'desk-example',style:{borderColor:'#'+(preview.color||0xdc143c).toString(16).padStart(6,'0')}},h('strong',null,preview.title),h('pre',null,preview.description),...(preview.fields||[]).map((f,i)=>h('div',{key:i},h('strong',null,f.name),h('pre',null,f.value)))),action.status);
  }
  function WalletPanel(){
    const [overview,setOverview,error]=useData('/v3/overview',15000),[seed,setSeed]=useState(''),[imp,setImp]=useState(false),action=useAction();
    const refresh=async()=>setOverview(await request('/v3/overview'));
    return section('Seller payout wallet',note(overview?.wallet.address||error||'Set up your local payout wallet to buy from Discord sellers.'),
      overview&&!overview.wallet.configured?row(button('Create payout wallet',()=>action.run(async()=>{const w=await post('/v3/wallet/create',{});setSeed(w.mnemonic);await refresh();}),action.busy),
        button('Import recovery phrase',()=>setImp(!imp),action.busy)):null,
      imp?h('form',{onSubmit:e=>{e.preventDefault();const form=e.currentTarget;const mnemonic=new FormData(form).get('mnemonic');action.run(async()=>{await post('/v3/wallet/import',{mnemonic});form.reset();setImp(false);await refresh();return 'Wallet imported.';});}},label('Recovery phrase',h('textarea',{name:'mnemonic',required:true,autoComplete:'off',spellCheck:false})),h('button',{disabled:action.busy},'Import wallet')):null,
      seed?h('div',null,note('Back up your recovery words privately. They are displayed once.'),h('pre',{className:'desk-secret'},seed),button('I saved the words',()=>setSeed(''))):null,
      row(button('Check payout confirmations',()=>action.run(async()=>{await post('/v3/wallet/check-transactions',{});await refresh();return 'Payout status refreshed.';}),action.busy),h('a',{href:'/intake-setup'},'Seller payout limits and setup')),
      ...(overview?.payouts||[]).slice(0,10).map(p=>h('div',{key:p.id,className:'desk-row'},p.id+' · '+p.state+' · '+(p.chain_status||'Awaiting chain check'),p.txid?h('a',{href:'https://litecoinspace.org/tx/'+encodeURIComponent(p.txid),target:'_blank',rel:'noreferrer'},'Transaction'):null)),action.status);
  }
  function ReviewPanel(){
    const [data,,error]=useData('/v3/review',15000),[ov]=useData('/v3/overview',15000);
    const rows=data?Object.entries(data).flatMap(([group,items])=>items.map(item=>({...item,group}))):[];
    return section('Order proof and review',...(ov?.orders||[]).filter(o=>o.hasEvidence).slice(0,15).map(o=>h('p',{key:o.id},h('a',{href:'/api/v3/evidence/'+encodeURIComponent(o.id),target:'_blank',rel:'noreferrer'},'View proof · '+o.id))),
      ...(rows.length?rows.slice(0,25).map(r=>h('p',{key:[r.group,r.id,r.message].join('/')},
        h('strong',null,[r.state,r.message].filter(Boolean).join(' · ')), ' · '+r.id+' · '+(r.reason||'Review the recorded transaction.'),
        ['deliveries','notifications','messages'].includes(r.group)?h('a',{href:'/api/marketplace/orders/'+encodeURIComponent(r.id)+'/progress',target:'_blank',rel:'noreferrer'},' View order journal'):null)):
        [error?h('p',{role:'alert'},error):note(data?'No orders need review.':'Loading orders…')]));
  }
  return {PrismClients,OfferLink,ChatGuide,BuyingPanel,WalletPanel,ReviewPanel,SellerCredentials,StartupPanel,BrowserConnection,AutomationStatus,checkStartupAfterBrowserOpen};
}
