'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {acquire}=require('../../ops/instance-lock');
test('a second backend cannot enter the same data directory while its owner is alive',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autosell-instance-'));
 try{const release=acquire(dir);assert.throws(()=>acquire(dir),/Another Autosell process/);release();const next=acquire(dir);next();assert.equal(fs.existsSync(path.join(dir,'process.lock')),false);}
 finally{if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('autosell-instance-'))throw Error('Unsafe temporary cleanup path');fs.rmSync(dir,{recursive:true,force:true});}
});
