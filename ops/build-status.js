'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const roots=['api','audit','db','discord','ledger','marketplace','minecraft','ops','payments','sell','services','settings','treasury','v3','vault','wallet'];
function fingerprint(root){
 const files=[];
 const visit=relative=>{const file=path.join(root,relative);if(!fs.existsSync(file))return;const stat=fs.lstatSync(file);if(stat.isSymbolicLink())return;if(stat.isDirectory()){for(const name of fs.readdirSync(file))visit(path.join(relative,name));}else if(/\.(?:js|json|sql)$/.test(relative))files.push(relative);};
 for(const name of [...roots,'index.js','config.js','package.json','package-lock.json'])visit(name);
 const hash=crypto.createHash('sha256');for(const file of files.sort()){hash.update(file.replaceAll('\\','/'));hash.update('\0');hash.update(fs.readFileSync(path.join(root,file)));hash.update('\0');}
 return hash.digest('hex').slice(0,16);
}
class BuildStatus{
 constructor(root){this.root=root;this.startedAt=new Date().toISOString();this.buildId=fingerprint(root);this.lastCheck=0;}
 snapshot(force=false){if(force||Date.now()-this.lastCheck>5000){this.diskBuildId=fingerprint(this.root);this.lastCheck=Date.now();}return {buildId:this.buildId,diskBuildId:this.diskBuildId,restartRequired:this.diskBuildId!==this.buildId,startedAt:this.startedAt,pid:process.pid};}
}
module.exports={BuildStatus,fingerprint};
