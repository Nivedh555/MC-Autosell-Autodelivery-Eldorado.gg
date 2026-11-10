'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {submitPreview}=require('../../marketplace/browser/evidence-upload');
test('attachment uploader waits for delayed preview and sends exactly once',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();await page.setContent('<div id="preview"></div>');
  await page.evaluate(()=>{window.sent=0;setTimeout(()=>{document.querySelector('#preview').innerHTML='<span>which-name.jpg</span><button disabled>Send</button>';const b=document.querySelector('button');b.onclick=()=>{window.sent++;document.querySelector('#preview').replaceChildren();};setTimeout(()=>b.disabled=false,200);},200);});
  let authorized=0;await submitPreview(page,'which-name.jpg',{timeoutMs:2500,beforeClick:async()=>authorized++});
  assert.equal(authorized,1);assert.equal(await page.evaluate(()=>window.sent),1);
  await page.setContent('<div>No preview</div>');
  await assert.rejects(submitPreview(page,'which-name.jpg',{timeoutMs:150}),/Send was not clicked/);
 }finally{await browser.close();}
});
