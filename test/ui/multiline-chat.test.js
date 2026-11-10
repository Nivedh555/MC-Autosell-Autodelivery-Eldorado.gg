'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fillMultiline,readRows}=require('../../marketplace/browser/observed-chat');
test('multiline greeting preserves blank lines and emoji without pressing Send',async()=>{
  const browser=await chromium.launch();try{
    const page=await browser.newPage();
    await page.setContent('<div role="textbox" contenteditable="true" aria-label="Say something..."></div><div class="UserMessage__message-row"><div class="MessageBody__message-text">First<br>Second</div></div>');
    const composer=page.getByRole('textbox');
    const text="Hey Buyer 👋 Thanks for your order!\nI'm the auto-delivery bot.\n\nign: YourName\n📍 Check your name";
    await fillMultiline(composer,text);
    assert.equal((await composer.innerText()).trim(),text);
    const rows=await page.locator('.UserMessage__message-row').evaluateAll(readRows);
    assert.equal(rows[0].text,'First\nSecond');
  }finally{await browser.close();}
});
