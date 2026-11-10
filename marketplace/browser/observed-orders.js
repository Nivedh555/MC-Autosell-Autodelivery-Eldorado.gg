'use strict';
const crypto=require('node:crypto');
                                                                              
                                                                             
                                                                       
const URL_SOLD='https://www.eldorado.gg/dashboard/orders/sold';
const HEADERS=['Order name','Type','Buyer','Ordered date','Order status','Quantity','Price ($)'];
function normalize(snapshot){
  const seller=new URL(snapshot.sellerHref);
  if(seller.origin!=='https://www.eldorado.gg'||!/^\/users\/[^/]+$/.test(seller.pathname))throw Error('Logged-in seller identity was not captured');
  if(snapshot.filter!=='All statuses'&&!(snapshot.empty&&!snapshot.rows.length))throw Error('Select All statuses on Sold Orders so cancelled and completed orders are included.');
  if(!snapshot.rows.length&&!snapshot.empty)throw Error('Sold Orders is loading or its layout changed; no empty list was inferred.');
  if(snapshot.rows.length&&!HEADERS.every((label,index)=>snapshot.headers[index]===label))throw Error('UNVERIFIED Sold Orders table layout: the displayed columns need developer review.');
  if(snapshot.rows.length>1000)throw Error('Sold Orders page exceeds the bounded reader.');
  const ids=new Set();
  const orders=snapshot.rows.map(row=>{
    if(row.cells.length!==HEADERS.length||row.cells.some(value=>!value))throw Error('A Sold Orders row is incomplete; refresh after loading.');
                                                                            
                                                                           
    const link=row.orderUrl?new URL(row.orderUrl):null;
    if(link&&(link.origin!==seller.origin||!/^\/order\/[0-9a-f-]{36}$/.test(link.pathname)))throw Error('Captured order link changed; no identifier was inferred.');
    const id=link?link.pathname.split('/').at(-1):'visible:'+crypto.createHash('sha256').update(JSON.stringify([snapshot.sellerHref,row.cells.filter((_,index)=>index!==4),row.orderUrl])).digest('hex');
    if(ids.has(id))throw Error('Identical Sold Orders rows need real order identifiers before they can be recorded separately.');ids.add(id);
    return {id,marketplaceIdCaptured:Boolean(link),sellerHref:snapshot.sellerHref,gameLabel:row.cells[0],typeDisplay:row.cells[1],buyerName:row.cells[2],orderedAt:row.cells[3],status:row.cells[4],quantityDisplay:row.cells[5],priceDisplay:row.cells[6],orderUrl:link?link.origin+link.pathname:null,source:'captured Sold Orders visible DOM',executionEligible:false};
  });
  return {orders,sellerHref:snapshot.sellerHref,scope:'Visible Sold Orders page; captured history does not authorize delivery',empty:snapshot.empty};
}
async function readOrders(page,timeoutMs=15000){
  try{return await readOrdersLoaded(page,timeoutMs);}
  catch(error){
    if(error.name!=='TimeoutError')throw error;
    throw Object.assign(Error('Eldorado Sold Orders did not finish loading or changing pages. Open Sold Orders in the connected Chrome profile, finish any sign-in or verification prompt, then refresh orders again. No payment was sent by this reader.',{cause:error}),{code:'ELDORADO_ORDERS_LOADING'});
  }
}
async function waitReady(page,timeoutMs){
  await page.waitForFunction(()=>{
    const visible=node=>Boolean(node?.getClientRects().length)&&getComputedStyle(node).visibility!=='hidden';
    const list=document.querySelector('eld-dashboard-orders-list');
    if(!visible(list)||![...document.querySelectorAll('eld-dashboard-sidenav-user a[href]')].some(visible))return false;
    if([...document.querySelectorAll('eld-dashboard-orders-page eld-skeleton, eld-dashboard-sidenav-user ngx-skeleton-loader')].some(visible))return false;
    if([...list.querySelectorAll('eld-no-results')].some(node=>visible(node)&&node.textContent.includes('You have no sold orders')))return true;
    const table=[...list.querySelectorAll('table')].find(visible);
    const rows=table?[...table.querySelectorAll('tbody tr')].filter(visible):[...list.querySelectorAll('a[href]')].filter(node=>visible(node)&&new URL(node.href).pathname.startsWith('/order/'));
    return rows.length>0&&rows.every(row=>{
      const cells=table?[...row.querySelectorAll('td')]:[...row.children];
      return cells.length===7&&cells.every(cell=>cell.textContent.trim());
    });
  },null,{timeout:timeoutMs});
}
async function selectAllStatuses(page,timeoutMs){
  // The page also contains unrelated comboboxes (e.g. a "Recent" sort control),
  // and the status label may carry whitespace/markup, so match by trimmed text
  // instead of an anchored CSS text filter.
  const emptyState=await page.locator('eld-no-results:visible').filter({hasText:'You have no sold orders'}).count().catch(()=>0);
  const boxes=page.locator('eld-dashboard-orders-filter [role="combobox"]');
  const total=await boxes.count().catch(()=>0);
  const labelOf=async index=>((await boxes.nth(index).textContent().catch(()=>''))||'').replace(/\s+/g,' ').trim();
  let target=-1,label='';
  for(let index=0;index<total;index++){
    const text=await labelOf(index);
    if(/^(All statuses|Pending delivery|Delivered|Received|Completed|Canceled|Cancelled|Disputed|Pending review)$/i.test(text)){target=index;label=text;break;}
  }
  if(target===-1){
    if(emptyState>0)return;
    let context='';
    try{
      context=JSON.stringify(await page.evaluate(()=>({
        url:location.href,
        title:document.title,
        filterHost:Boolean(document.querySelector('eld-dashboard-orders-filter')),
        comboboxes:[...document.querySelectorAll('eld-dashboard-orders-filter [role="combobox"]')].map(node=>node.textContent.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,8),
        noResults:[...document.querySelectorAll('eld-no-results')].map(node=>node.textContent.trim().replace(/\s+/g,' ').slice(0,80)).slice(0,3),
        list:Boolean(document.querySelector('eld-dashboard-orders-list'))
      })));
    }catch{}
    throw Error('Sold Orders status filter is missing or ambiguous. Open Sold Orders and select All statuses.'+(context?' ['+context+']':''));
  }
  const filter=boxes.nth(target);
  if(/^all statuses$/i.test(label))return;
  await filter.click({timeout:timeoutMs});
  const option=page.getByRole('option',{name:'All statuses',exact:true});
  await option.waitFor({state:'visible',timeout:timeoutMs});
  await option.click({timeout:timeoutMs});
  await page.waitForFunction(()=>{
    const filters=[...document.querySelectorAll('eld-dashboard-orders-filter [role="combobox"]')].filter(node=>node.getClientRects().length&&node.textContent.replace(/\s+/g,' ').trim()==='All statuses');
    return filters.length===1&&filters[0].textContent.replace(/\s+/g,' ').trim()==='All statuses';
  },null,{timeout:timeoutMs});
  await waitReady(page,timeoutMs);
}
function pageSignature(previous){
  const list=document.querySelector('eld-dashboard-orders-list'),visible=node=>Boolean(node?.getClientRects().length);
  if(!list||[...document.querySelectorAll('eld-dashboard-orders-page eld-skeleton')].some(visible))return false;
  const tables=[...list.querySelectorAll('table')].filter(visible);
  const rows=tables.length?[...tables[0].querySelectorAll('tbody tr')].filter(visible):[...list.querySelectorAll('a[href]')].filter(node=>visible(node)&&new URL(node.href).pathname.startsWith('/order/'));
  if(!rows.length)return false;
  const signature=JSON.stringify(rows.map(row=>[row.textContent.trim(),row.matches('a[href]')?row.href:[...row.querySelectorAll('a[href]')].map(node=>node.href)]));
  return previous===undefined?signature:signature!==previous;
}
async function readOrdersLoaded(page,timeoutMs){
  if(page.url()!==URL_SOLD)await page.goto(URL_SOLD,{waitUntil:'domcontentloaded',timeout:timeoutMs});
  else await page.reload({waitUntil:'domcontentloaded',timeout:timeoutMs});
  await page.locator('eld-dashboard-orders-list').waitFor({state:'visible',timeout:timeoutMs});
                                                                            
                                                                        
  await waitReady(page,timeoutMs);
  await selectAllStatuses(page,timeoutMs);
  const all=[],seen=new Set();let sellerHref;
  for(let index=0;index<100;index++){
    const result=await readPage(page);
    if(sellerHref&&sellerHref!==result.sellerHref)throw Error('Seller identity changed during history pagination.');
    sellerHref=result.sellerHref;
    for(const order of result.orders){if(seen.has(order.id))throw Error('Sold Orders pagination repeated a page.');seen.add(order.id);all.push(order);}
    const arrows=page.locator('eld-cursor-based-pagination:visible .pagination-arrow:visible');
    const next=arrows.nth(1);
    if(!await next.count()){
      if(!result.empty)throw Error('Sold Orders pagination is missing; completeness cannot be confirmed.');
      return {...result,orders:all,pages:index+1};
    }
    if(await next.evaluate(node=>node.matches(':disabled,[disabled],[aria-disabled="true"],.disable,.disabled')||Boolean(node.closest('[aria-disabled="true"],button:disabled'))||Boolean(node.querySelector(':disabled,[disabled],[aria-disabled="true"]'))))return {...result,orders:all,pages:index+1};
    const prior=await page.evaluate(pageSignature);
    await next.click({timeout:timeoutMs});
    await page.waitForFunction(pageSignature,prior,{timeout:timeoutMs});
    await waitReady(page,timeoutMs);
  }
  throw Error('Sold Orders history exceeds 100 pages; no partial refresh was claimed complete.');
}
async function readPage(page){
  const snapshot=await page.evaluate(()=>{
    const visible=node=>Boolean(node?.getClientRects().length),list=document.querySelector('eld-dashboard-orders-list');
    const tables=[...list.querySelectorAll('table')].filter(visible);
    if(tables.length>1)throw Error('Ambiguous Sold Orders tables');
    const table=tables[0];
    const links=[...list.querySelectorAll('a[href]')].filter(node=>visible(node)&&new URL(node.href).pathname.startsWith('/order/'));
    const filters=[...document.querySelectorAll('eld-dashboard-orders-filter [role="combobox"]')].filter(node=>visible(node)&&node.textContent.replace(/\s+/g,' ').trim()==='All statuses');
    return {sellerHref:document.querySelector('eld-dashboard-sidenav-user a[href]')?.href,filter:filters[0]?.textContent.trim(),
      empty:[...list.querySelectorAll('eld-no-results')].some(node=>visible(node)&&node.textContent.includes('You have no sold orders')),
      headers:table?[...table.querySelectorAll('thead th')].map(node=>node.textContent.trim()):links.length?['Order name','Type','Buyer','Ordered date','Order status','Quantity','Price ($)']:[],
      rows:table?[...table.querySelectorAll('tbody tr')].filter(visible).map(row=>({cells:[...row.querySelectorAll('td')].map(node=>node.textContent.trim()),orderUrl:[...row.querySelectorAll('a[href]')].map(node=>node.href).find(href=>new URL(href).origin===location.origin&&new URL(href).pathname.startsWith('/order/'))||null})):links.map(row=>{
        const cols=[...row.children];
        if(cols.length!==7||!cols[0].querySelector('eld-dashboard-orders-list-game h6')||!cols[4].querySelector('eld-chip'))throw Error('Captured Sold Orders row structure changed.');
        const value=index=>{const values=[...cols[index].querySelectorAll('p:not(.mobile-label)')];if(values.length!==1)throw Error('Sold Orders column value is ambiguous.');return values[0].textContent.trim();};
        return {orderUrl:row.href,cells:[cols[0].querySelector('h6').textContent.trim(),value(1),value(2),value(3),cols[4].querySelector('eld-chip')?.textContent.trim(),value(5),value(6)]};
      })};
  });
  if(page.url()!==URL_SOLD)throw Error('Seller page changed during Sold Orders capture');
  return normalize(snapshot);
}
module.exports={readOrders,normalize,URL_SOLD,HEADERS};
