'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {readOffers,URL}=require('../../marketplace/browser/observed-offers');
const {setAvailability}=require('../../marketplace/browser/offer-availability');
const pack=require('../../marketplace/browser/availability-pack.json');
const id='11111111-1111-4111-8111-111111111111';
function fixture({partial=false,empty=false,never=false}={}){
  return `<!doctype html><style>eld-dashboard-sidenav-user,eld-dashboard-offers-list-item,eld-chip{display:block}</style>
  <eld-dashboard-sidenav-user><a href="/users/FixtureSeller">FixtureSeller</a></eld-dashboard-sidenav-user><main></main>
  <script>
  window.clicks=0;
  const main=document.querySelector('main');
  function render(){
    main.innerHTML=${JSON.stringify(empty?'<p>Nothing found</p>':'<eld-dashboard-offers-list-item><p>DonutSMP</p><a aria-label="Edit" href="/dashboard/offers/Currency/edit/'+id+'">Edit</a><eld-chip>Paused</eld-chip><div><p>Quantity:</p><strong>500 M</strong></div><div><p>Min qty.:</p><strong>100 M</strong></div><button aria-label="Resume">Resume</button></eld-dashboard-offers-list-item>')};
    const button=main.querySelector('button');if(button)button.onclick=()=>{window.clicks++;main.querySelector('eld-chip').textContent='Active';button.setAttribute('aria-label','Pause');button.textContent='Pause';};
  }
  ${never?'':partial?"main.innerHTML='<eld-dashboard-offers-list-item><p>DonutSMP</p></eld-dashboard-offers-list-item>';setTimeout(render,250);":'setTimeout(render,250);'}
  </script>`;
}
test('Offers waits for delayed rows and complete controls before resuming the exact offer',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  for(const [name,config]of [['delayed rows',{}],['partial row',{partial:true}],['explicit empty result',{empty:true}]])await t.test(name,async()=>{
    const page=await browser.newPage();try{
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture(config)}));
      await page.goto(URL);
      const result=await readOffers(page,1500,{availabilityOnly:true,refresh:false});
      assert.equal(result.offers.length,config.empty?0:1);
      if(!config.empty){
        let authorizations=0;
        const updated=await setAvailability(page,{id,paused:false,sellerHref:result.sellerHref,pack,timeoutMs:1500,beforeClick:async()=>{authorizations++;}});
        assert.equal(updated.confirmed,true);assert.equal(updated.offer.status,'Active');assert.equal(authorizations,1);assert.equal(await page.evaluate(()=>window.clicks),1);
      }
    }finally{await page.close();}
  });
  await t.test('missing list times out without clicking',async()=>{
    const page=await browser.newPage();try{
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture({never:true})}));await page.goto(URL);
      await assert.rejects(readOffers(page,300,{availabilityOnly:true,refresh:false}),error=>error.code==='ELDORADO_OFFERS_LOADING');
      assert.equal(await page.evaluate(()=>window.clicks),0);
    }finally{await page.close();}
  });
});
