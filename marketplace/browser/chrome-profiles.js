'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const profileId=id=>typeof id==='string' && /^(Default|Profile \d+)$/.test(id);
function root(){if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw Error('Chrome profile selection currently supports Windows only');return path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data');}
async function inventory(options={}) {
  const attaching=options.mode==='attach';
  const directory=options.root || root();let state;
  try{const file=path.join(directory,'Local State');if(fs.statSync(file).size>8*1024*1024)throw Error();state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Chrome profile metadata is unavailable; no profile can be selected');}
  let processes,known=true;
  try {
    processes=options.processes || JSON.parse((await run(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',"ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { -not $_.CommandLine -or $_.CommandLine -notmatch '--type=' } | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $null } })"],{timeout:5000,windowsHide:true,maxBuffer:256*1024})).stdout);
    if(!Array.isArray(processes)||processes.some(v=>typeof v!=='string'))throw Error();
  }catch{known=false;processes=[];}
  const running=processes.filter(cmd=>!cmd.includes('--user-data-dir='));
  const active=new Set(running.length ? (state.profile?.last_active_profiles || []).filter(profileId) : []);
  for(const command of running){const match=command.match(/--profile-directory=(?:"([^"]+)"|([^\s"]+))/);if(match&&profileId(match[1]||match[2]))active.add(match[1]||match[2]);}
  if(running.length && active.size===0)known=false;
                                                                                
                                                                                   
  const profiles=Object.entries(state.profile?.info_cache || {}).filter(([id])=>profileId(id)&&fs.existsSync(path.join(directory,id))).map(([id,data])=>({id,name:typeof data.name==='string'?data.name.slice(0,120):id,active:active.has(id),selectable:attaching || known&&!active.has(id),launchRequired:known&&!active.has(id),reason:attaching?'':!known?'Could not safely determine profile activity':active.has(id)?'In use or reported active by Chrome; close its windows and refresh':''}));
  return {profiles,activityKnown:known,mode:attaching?'attach':'launch',permissionRequired:true,method:'Chrome consent-based CDP',loginVerified:false};
}
function executable(){for(const base of [process.env.ProgramFiles,process.env.ProgramW6432,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA]){if(!base)continue;const file=path.join(base,'Google','Chrome','Application','chrome.exe');if(fs.existsSync(file))return file;}throw Error('Installed Chrome was not found');}
async function prepare(id,options={}) {
  if(!profileId(id))throw Error('Select a detected Chrome profile');
  const list=await inventory(options),selected=list.profiles.find(p=>p.id===id);
  if(!selected || !selected.selectable)throw Error(selected?.reason || 'Selected Chrome profile was not found');
  return {...selected,expectedPath:path.join(options.root || root(),id),executable:options.executable || executable()};
}
module.exports={inventory,prepare,profileId};
