'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {BuildStatus}=require('../../ops/build-status');
test('runtime fingerprint detects edited code while excluding private data and environment files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'autosell-build-'));try{
  fs.mkdirSync(path.join(root,'marketplace'));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'index.js'),'module.exports=1;');
  const build=new BuildStatus(root);assert.equal(build.snapshot(true).restartRequired,false);
  fs.writeFileSync(path.join(root,'data','vault.enc'),'fixture-private-data');fs.writeFileSync(path.join(root,'.env'),'VAULT_PASSPHRASE=fixture');assert.equal(build.snapshot(true).restartRequired,false);
  fs.writeFileSync(path.join(root,'marketplace','changed.js'),'module.exports=2;');const status=build.snapshot(true);assert.equal(status.restartRequired,true);assert.notEqual(status.buildId,status.diskBuildId);
  const migrated=new BuildStatus(root);fs.mkdirSync(path.join(root,'db','migrations'),{recursive:true});fs.writeFileSync(path.join(root,'db','migrations','025-test.sql'),'SELECT 1;');assert.equal(migrated.snapshot(true).restartRequired,true);
 }finally{if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('autosell-build-'))throw Error('Unsafe temporary cleanup path');fs.rmSync(root,{recursive:true,force:true});}
});
