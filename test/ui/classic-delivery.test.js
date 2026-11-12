"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express"),path=require("node:path");
const {chromium}=require("playwright");
const {validateProfileOptions}=require("../../marketplace/browser/playwright-session");

test("the original dashboard opens saved links, uses the chosen seller browser and previews the actual guide images",async t=>{
  const app=express(),dist=path.resolve(__dirname,"../../web/dist"),calls=[];
  let browserOptions={channel:"chromium",sessionMode:"persistent",chromeProfile:"",actionMs:750,characterMs:1,timeoutMs:30000};
  app.use(express.json());app.use("/api",(req,res)=>{
    const success={success:true};
    if(req.path==="/events"){res.setHeader("Content-Type","text/event-stream");return res.end(": connected\n\n");}
    if(req.path==="/marketplace/setup")return res.json({connection:"hybrid",listing:{},browserOptions,chat:{autoSend:true},pairs:[],browser:{state:"CLOSED"}});
    if(req.path==="/marketplace/config"){if(req.body.browserOptions)browserOptions=validateProfileOptions(req.body.browserOptions);if(req.body.clientId){assert.deepEqual(Object.keys(req.body).sort(),['clientId','clientSecret']);return res.json({...success,message:'API credentials saved securely.'});}return res.json(success);}
    if(req.path==="/marketplace/test-connection")return setTimeout(()=>res.json({success:false,error:'Seller API sign-in failed (HTTP 401). Fixture rejection.'}),150);
    if(req.path==="/ops/browser/open"){calls.push(validateProfileOptions(req.body.browserOptions));return res.json({state:"ATTACHED_PAUSED",connected:true});}
    if(req.path==="/ops/browser")return res.json({bridge:{state:"CLOSED",connected:false}});
    if(req.path==="/ops/browser/profiles")return res.json({profiles:[{name:"Fixture Chrome",id:"Default",selectable:true}]});
    if(req.path==="/v3/overview")return res.json({accounts:[{id:"seller1",ign:"FixturePlayer",connected:false}],orders:[],payouts:[],wallet:{}});
    if(req.path==="/v3/review")return res.json({deliveries:[{id:"paid-closed",state:"RECONCILIATION_REQUIRED",reason:"Marketplace canceled after payment"}],
      messages:[{id:"paid-closed",message:"proof-text",state:"UNKNOWN",reason:"Read-only receipt check pending"}]});
    if(req.path==="/v3/eldorado/customer-messages"){
      if(req.method==='POST'){calls.push({templates:req.body.templates});return res.json({...success,message:'Buyer messages saved.'});}
      return res.json({templates:require('../../web/dist/buyer-guides/messages.json'),images:{username:'/buyer-guides/which-name.jpg',confirm:'/buyer-guides/how-to-confirm-1.png',feedback:'/buyer-guides/how-to-confirm-2.png'}});
    }
    return res.json({...success,pairs:[],orders:[],sellers:[],accounts:[],sales:[]});
  });
  app.get(['/','/classic'],(_req,res)=>res.sendFile(path.join(dist,'index.html')));app.use(express.static(dist));
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.route(/^https:/,route=>route.abort());const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base="http://127.0.0.1:"+server.address().port;await page.goto(base);
  await page.getByRole('heading',{name:'Minecraft delivery clients'}).waitFor();assert(await page.getByText('seller1 · FixturePlayer').isVisible());
  if(process.env.AUTOSELL_UI_CAPTURE_DIR)await page.screenshot({path:path.join(process.env.AUTOSELL_UI_CAPTURE_DIR,'classic-pairs.png'),fullPage:true});
  await page.goto(base+'/classic#connections');
  await page.getByText('Seller browser',{exact:true}).waitFor();
  if(process.env.AUTOSELL_UI_CAPTURE_DIR)await page.screenshot({path:path.join(process.env.AUTOSELL_UI_CAPTURE_DIR,'classic-eldorado.png'),fullPage:true});
  const select=page.locator('select').filter({has:page.locator('option[value=msedge]')});
  assert.equal(await select.inputValue(),'chromium');await select.selectOption('msedge');
  await page.getByRole('button',{name:'Save browser choice'}).click();
  await page.getByText(/Seller browser saved/).first().waitFor();await page.reload();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('select')).some(s=>s.value==='msedge'));
  const credentials=page.locator('section').filter({has:page.getByRole('heading',{name:'Seller API credentials',exact:true})});
  await credentials.getByLabel('Client ID',{exact:true}).fill('fixture-id');
  await credentials.getByLabel('Client secret',{exact:true}).fill('fixture-secret');
  await credentials.getByRole('button',{name:'Save API credentials'}).click();
  await credentials.getByText('API credentials saved securely.',{exact:true}).waitFor();
  assert.equal(await credentials.getByLabel('Client secret',{exact:true}).inputValue(),'');
  await credentials.getByRole('button',{name:'Check API connection'}).click();
  await credentials.getByText(/Fixture rejection/).waitFor();
  await page.getByRole('button',{name:'Open seller browser'}).click();
  await page.getByText('Seller browser connected',{exact:true}).waitFor();assert.equal(calls[0].channel,'msedge');
  assert.equal(await page.getByText('ATTACHED_PAUSED',{exact:true}).count(),0);
  await page.getByRole('link',{name:'Preview the exact messages and pictures'}).click();await page.getByRole('heading',{name:'Eldorado buyer messages'}).waitFor();
  const images=page.locator('.desk-example img');await images.nth(2).waitFor();
  assert(await images.evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth>0)));
  assert(await page.locator('pre').getByText("Done! Here's your proof 📸",{exact:true}).isVisible());
  await page.getByText('After payment verification',{exact:true}).locator('..').locator('textarea').fill('Payment confirmed for {ign}.');
  await page.getByRole('button',{name:'Save buyer messages'}).click();
  await page.getByText('Buyer messages saved.',{exact:true}).waitFor();
  assert.equal(calls.at(-1).templates.proof,'Payment confirmed for {ign}.');
  if(process.env.AUTOSELL_UI_CAPTURE_DIR)await page.screenshot({path:path.join(process.env.AUTOSELL_UI_CAPTURE_DIR,'classic-messages.png'),fullPage:true});
  assert.equal(await page.getByText('3. Shop assistant',{exact:true}).count(),0);assert.deepEqual(errors,[]);
  await page.goto(base+'/classic#orders');
  const review=page.locator('section').filter({has:page.getByRole('heading',{name:'Order proof and review'})});
  await review.getByText('RECONCILIATION_REQUIRED',{exact:true}).waitFor();
  assert(await review.getByText('UNKNOWN · proof-text',{exact:true}).isVisible());
  assert.equal(await review.getByRole('link',{name:'View order journal'}).first().getAttribute('href'),'/api/marketplace/orders/paid-closed/progress');
  assert.deepEqual(errors,[]);
});

