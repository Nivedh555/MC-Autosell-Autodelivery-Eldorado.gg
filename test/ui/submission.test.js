'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {submit}=require('../../marketplace/browser/submission');

test('a delayed TalkJS preview and bubble create exactly one activation',async()=>{
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();
    await page.setContent(`<div id="preview">proof.png</div><button onclick="
      window.clicks=(window.clicks||0)+1;
      setTimeout(()=>{document.querySelector('#preview')?.remove();document.body.insertAdjacentHTML('beforeend','<p>Outgoing proof.png</p>')},1100)">Send</button>`);
    let dispatches=0;
    await submit(page.getByRole('button',{name:'Send'}),{beforeActivate:()=>dispatches++});
    await page.getByText('Outgoing proof.png',{exact:true}).waitFor();
    assert.equal(dispatches,1);
    assert.equal(await page.evaluate(()=>window.clicks),1);
    assert.equal(await page.getByText('Outgoing proof.png',{exact:true}).count(),1);
  } finally {await browser.close();}
});
