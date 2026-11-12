'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PNG}=require('pngjs');
const messages=require('../../marketplace/customer-messages');

test('seller can edit buyer messages while recipient confirmation keeps its amount and IGN',()=>{
  const custom={...messages.templates,confirm:'DonutSMP tax is deducted. Send {amount} to {ign}? Reply yes or no',proof:'Paid {ign}. Receipt follows.'};
  assert.equal(messages.validateTemplates(custom),custom);
  assert.equal(messages.render('confirm',{amount:'9803922',ign:'14him'},custom),'DonutSMP tax is deducted. Send 9.803922M to 14him? Reply yes or no');
  assert.throws(()=>messages.validateTemplates({...custom,confirm:'Send it to them?'}),/must include/);
  assert.throws(()=>messages.validateTemplates({...custom,proof:'{secret}'}),/Unknown/);
});

test('seller guide upload accepts a real bounded PNG and rejects malformed data',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'autosell-guide-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const image=PNG.sync.write(new PNG({width:32,height:16})),dataUrl='data:image/png;base64,'+image.toString('base64');
  assert.equal(messages.saveGuide('username',dataUrl,directory),dataUrl);
  assert.deepEqual(fs.readFileSync(path.join(directory,'username.png')),image);
  assert.throws(()=>messages.saveGuide('wrong',dataUrl,directory),/Unknown/);
  assert.throws(()=>messages.saveGuide('confirm','data:image/png;base64,aGVsbG8=',directory),/PNG must/);
});
