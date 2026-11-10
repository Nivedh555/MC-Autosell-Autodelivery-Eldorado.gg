'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {readOrders,URL_SOLD,HEADERS,normalize}=require('../../marketplace/browser/observed-orders');
const {parseEndpoint}=require('../../marketplace/browser/owned-cdp');
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
function fixture(config={}){
  return `<!doctype html><style>eld-dashboard-orders-page,eld-dashboard-orders-list,eld-dashboard-sidenav-user,eld-cursor-based-pagination,eld-dashboard-orders-filter,eld-no-results{display:block}td,th{padding:8px}eld-skeleton{display:block;height:20px}</style>
  <eld-dashboard-sidenav-user></eld-dashboard-sidenav-user><eld-dashboard-orders-page>
  <eld-dashboard-orders-filter>${config.otherFilter?'<button role="combobox">All games</button>':''}<button role="combobox" id="status">${config.filtered?'Pending delivery':'All statuses'}</button><div id="options" hidden><button role="option">All statuses</button></div></eld-dashboard-orders-filter>
  <eld-skeleton></eld-skeleton><eld-dashboard-orders-list></eld-dashboard-orders-list>
  <eld-cursor-based-pagination><button class="pagination-arrow disable">Previous</button><button class="pagination-arrow" id="next">Next</button></eld-cursor-based-pagination></eld-dashboard-orders-page>
  <script>
  const config=${JSON.stringify(config)},ids=${JSON.stringify(ids)},headers=${JSON.stringify(HEADERS)};let current=0;
  const list=document.querySelector('eld-dashboard-orders-list'),next=document.querySelector('#next'),filter=document.querySelector('#status'),skeleton=document.querySelector('eld-skeleton');
  function render(){
    skeleton.hidden=true;skeleton.style.display='none';
    document.querySelector('eld-dashboard-sidenav-user').innerHTML='<a href="/users/FixtureSeller">FixtureSeller</a>';
    const cells=['DonutSMP','Currency','Buyer'+current,'19 October 2026','Pending delivery','100M','$1.00'];
    const link=config.linkless?'DonutSMP':'<a href="/order/'+ids[current]+'">DonutSMP</a>';
    list.innerHTML=config.empty?'<eld-no-results>You have no sold orders</eld-no-results>':config.cards?'<a href="/order/'+ids[current]+'">'+cells.map((value,i)=>'<div>'+(i===0?'<eld-dashboard-orders-list-game><h6>DonutSMP</h6></eld-dashboard-orders-list-game>':i===4?'<eld-chip>'+value+'</eld-chip>':'<p>'+value+'</p>')+'</div>').join('')+'</a>':'<table><thead><tr>'+headers.map(value=>'<th>'+value+'</th>').join('')+'</tr></thead><tbody><tr>'+cells.map((value,i)=>'<td>'+(i===0?link:value)+'</td>').join('')+'</tr></tbody></table>';
    const last=config.single||config.empty||current===1;
    next.className='pagination-arrow'+(last&&config.disableClass?' disabled':'');next.disabled=last&&!config.disableClass&&!config.ariaDisabled;next.setAttribute('aria-disabled',String(Boolean(last&&config.ariaDisabled)));
    if(config.partial&&!window.completed){window.completed=true;list.querySelector('tbody tr').lastElementChild.remove();setTimeout(render,100);}
  }
  filter.onclick=()=>document.querySelector('#options').hidden=false;
  document.querySelector('[role="option"]').onclick=()=>{filter.textContent='All statuses';document.querySelector('#options').hidden=true;list.innerHTML='';skeleton.style.display='block';setTimeout(render,40)};
  next.onclick=()=>{if(config.repeat)return;skeleton.style.display='block';list.innerHTML='';setTimeout(()=>{current=1;render()},40)};
  setTimeout(render,${config.delay||20});
  </script>`;
}
test('Chrome endpoint discovery preserves the browser path and rejects malformed metadata',()=>{
  assert.equal(parseEndpoint('9222\n/devtools/browser/abc-123\n'),'ws://127.0.0.1:9222/devtools/browser/abc-123');
  assert.equal(parseEndpoint('9222\r\n/devtools/browser\r\n'),'ws://127.0.0.1:9222/devtools/browser');
  assert.equal(parseEndpoint('9222'),'ws://127.0.0.1:9222/devtools/browser');
  for(const value of ['0','65536','abc','9222\nhttps://example.org','9222\n/devtools/browser/../other','9222\n/devtools/browser?token=x','9222\n/devtools/browser\nextra'])assert.throws(()=>parseEndpoint(value),/metadata is invalid/);
});
test('Sold Orders reads real browser DOM without live marketplace requests',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  for(const [name,config,count]of [
    ['waits for delayed rows and seller identity',{delay:160,single:true},1],
    ['waits for all row cells before capturing',{partial:true,single:true},1],
    ['changes the status view and reads both table pages',{filtered:true},2],
    ['finds the status filter alongside a separate game filter',{filtered:true,otherFilter:true},2],
    ['handles disabled CSS class on the last page',{disableClass:true},2],
    ['handles ARIA disabled controls on the last page',{ariaDisabled:true},2],
    ['handles responsive card rows and native disabled controls',{cards:true},2],
    ['supports table history rows without order links',{linkless:true},2],
    ['recognizes an explicitly empty history',{empty:true},0],
  ])await t.test(name,async()=>{
    const page=await browser.newPage();try{
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture(config)}));
      await page.goto(URL_SOLD);const result=await readOrders(page,3000);
      assert.equal(result.orders.length,count);assert.equal(result.sellerHref,'https://www.eldorado.gg/users/FixtureSeller');
      assert.ok(result.orders.every(order=>order.executionEligible===false));
      if(count===2&&!config.linkless)assert.deepEqual(result.orders.map(order=>order.id),ids);
    }finally{await page.close();}
  });
  await t.test('repeated pagination fails instead of reporting an incomplete success',async()=>{
    const page=await browser.newPage();try{
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture({repeat:true})}));
      await page.goto(URL_SOLD);await assert.rejects(readOrders(page,350),error=>error.code==='ELDORADO_ORDERS_LOADING');
    }finally{await page.close();}
  });
});
test('Sold Orders does not accept another origin or unknown table columns',()=>{
  assert.throws(()=>normalize({sellerHref:'https://example.org/users/seller'}),/identity/);
  assert.throws(()=>normalize({sellerHref:'https://www.eldorado.gg/users/seller',filter:'All statuses',headers:['Unknown'],rows:[{}]}),/table layout/);
});
