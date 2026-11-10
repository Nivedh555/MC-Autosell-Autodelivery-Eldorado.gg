'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const WebSocket=require('ws');

                                                                           
                                                                               
                                                                              
                                                          
class OwnedCDPTransport {
  constructor(socket,profileTabs){
    this.profileTabs=profileTabs;this.pageQueue=Promise.resolve();
    this.socket=socket;this.next=-1;this.internal=new Map();this.creating=new Set();this.owned=new Set();this.attached=new Set();this.attachAcknowledged=new Set();this.backgroundReady=new Set();this.focusTimers=new Map();this.replies=new Map();this.closed=false;
    socket.addEventListener('message',event=>{
      try{if(typeof event.data!=='string'||event.data.length>8*1024*1024)throw Error('Invalid CDP message');this.receive(JSON.parse(event.data));}catch{this.close();}
    });
    socket.addEventListener('close',()=>{
      clearTimeout(this.terminateTimer);clearTimeout(this.closeTimer);this.closed=true;
      for(const timer of this.focusTimers.values())clearTimeout(timer);this.focusTimers.clear();
      const callbacks=[...this.internal.values()];this.internal.clear();
      for(const callback of callbacks){try{callback({error:{code:-32000,message:'Chrome debugging connection ended'}});}catch{}}
      this.replies.clear();this.creating.clear();this.owned.clear();this.attached.clear();this.attachAcknowledged.clear();this.backgroundReady.clear();
      this.onclose?.('Chrome debugging connection ended');
    });
    socket.addEventListener('error',()=>this.close());
  }
  open(){}
  transmit(message){if(this.closed)throw Error('Chrome debugging connection ended');this.socket.send(JSON.stringify(message));}
  send(message){
    if(!message.sessionId&&message.method==='Target.setAutoAttach'){
                                                                           
                                                                           
      message={...message,params:{...message.params,autoAttach:false,waitForDebuggerOnStart:false}};
    }
    if(!message.sessionId&&message.method==='Target.createTarget'&&this.profileTabs){
                                                                            
                                                                               
                                                                             
      this.pageQueue=this.pageQueue.then(()=>this.createProfilePage(message)).catch(error=>{
        if(!this.closed)this.onmessage?.({id:message.id,error:{code:-32000,message:String(error.message)}});
      });return;
    }
    if(!message.sessionId&&message.method==='Target.createTarget')this.creating.add(message.id);
    this.transmit(message);
  }
  query(method,params){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.internal.delete(id);reject(Error('Chrome did not answer the profile tab lookup'));},Math.min(this.profileTabs?.timeoutMs || 15000,15000));
    let id;try{id=this.command(method,params,reply=>{clearTimeout(timer);reply.error?reject(Error(reply.error.message)):resolve(reply.result);});}catch(error){clearTimeout(timer);reject(error);}
  });}
  async createProfilePage(message){
    if(this.closed||this.closing)throw Error('Chrome debugging connection ended');
    if(message.params.url!=='about:blank'||message.params.browserContextId)throw Error('Profile attachment only creates blank tabs in the selected regular profile');
    const url='data:text/html,<title>Autosell_connect_'+crypto.randomUUID()+'</title><p>Connecting selected Chrome profile. Trading is paused.</p>';
    const title=url.match(/<title>([^<]+)<\/title>/)[1];
    await this.profileTabs.openTab(url);
    const deadline=Date.now()+this.profileTabs.timeoutMs;let target;
    while(!target){
      if(this.closed||this.closing)throw Error('Chrome debugging connection ended');
      const reply=await this.query('Target.getTargets',{});
      const matches=reply.targetInfos.filter(t=>t.type==='page'&&t.url===url);
      if(matches.length>1)throw Error('Chrome exposed more than one requested profile tab');
                                                                           
                                                                             
                                                                            
      const candidate=reply.targetInfos.find(t=>t.type==='page'&&t.url===url);
      if(candidate && !this.startupActivated){
        this.owned.add(candidate.targetId);
                                                                             
                                                                            
                                                                          
        const window=await this.query('Browser.getWindowForTarget',{targetId:candidate.targetId});
        if(window.bounds?.windowState==='minimized'){
          await this.query('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});
          await new Promise(resolve=>setTimeout(resolve,150));
        }
        await this.query('Target.activateTarget',{targetId:candidate.targetId});
        this.startupActivated=true;
      }
      target=candidate?.title===title?candidate:undefined;
      if(!target){if(Date.now()>=deadline)throw Error('Selected Chrome profile tab did not finish opening in the approved debugging connection (own tab '+(candidate?'present, title '+JSON.stringify(candidate.title||'not rendered'):'not found')+')');await new Promise(resolve=>setTimeout(resolve,100));}
    }
    if(this.closed||this.closing)throw Error('Chrome debugging connection ended');
    this.attachCreated(message.id,target.targetId);
  }
  attachCreated(id,target){
    this.owned.add(target);this.replies.set(target,{id,result:{targetId:target}});
    this.command('Target.attachToTarget',{targetId:target,flatten:true},reply=>{
      if(reply.error){this.replies.delete(target);this.onmessage?.({id,error:reply.error});}
      else {this.attachAcknowledged.add(target);this.release(target);}
    });
  }
  command(method,params,callback,sessionId){const id=this.next--;this.internal.set(id,callback);try{this.transmit({id,method,params,...(sessionId?{sessionId}:{})});}catch(error){this.internal.delete(id);throw error;}return id;}
  prepareBackground(target,sessionId){
                                                                               
                                                                                
    let id;
    const fail=error=>{this.internal.delete(id);const reply=this.replies.get(target);this.replies.delete(target);if(reply)this.onmessage?.({id:reply.id,error});};
    const timer=setTimeout(()=>{this.focusTimers.delete(target);fail({code:-32000,message:'Chrome did not acknowledge background support for the Autosell tab'});},15000);
    this.focusTimers.set(target,timer);
                                                                            
                                                                              
    const prepare=()=>{id=this.command('Page.setWebLifecycleState',{state:'active'},reply=>{
      if(reply.error){clearTimeout(timer);this.focusTimers.delete(target);fail(reply.error);return;}
      id=this.command('Emulation.setFocusEmulationEnabled',{enabled:true},reply=>{
        clearTimeout(timer);this.focusTimers.delete(target);
        if(reply.error){fail(reply.error);return;}
        this.backgroundReady.add(target);this.release(target);
      },sessionId);
    },sessionId);};
    if(this.profileTabs && !this.startupActivated){
                                                                           
                                                                           
                                                                             
      this.startupActivated=true;
      id=this.command('Target.activateTarget',{targetId:target},reply=>{
        if(reply.error){clearTimeout(timer);this.focusTimers.delete(target);fail(reply.error);return;}
        prepare();
      });
    }else prepare();
  }
  release(target){const message=this.replies.get(target);if(message&&this.attached.has(target)&&this.attachAcknowledged.has(target)&&this.backgroundReady.has(target)){this.replies.delete(target);this.onmessage?.(message);}}
  receive(message){
    if(this.internal.has(message.id)){const callback=this.internal.get(message.id);this.internal.delete(message.id);callback(message);return;}
    if(this.creating.delete(message.id)&&message.result?.targetId){
      this.attachCreated(message.id,message.result.targetId);return;
    }
    if(message.method==='Target.attachedToTarget'&&!message.sessionId){
      const target=message.params?.targetInfo?.targetId;
      if(!this.owned.has(target)){this.close();return;}                                     
      if(this.attached.has(target)){this.close();return;}
      this.attached.add(target);this.prepareBackground(target,message.params.sessionId);this.onmessage?.(message);this.release(target);return;
    }
    if(message.method==='Target.targetDestroyed'){const target=message.params?.targetId;this.owned.delete(target);this.attached.delete(target);this.attachAcknowledged.delete(target);this.backgroundReady.delete(target);clearTimeout(this.focusTimers.get(target));this.focusTimers.delete(target);const pending=this.replies.get(target);this.replies.delete(target);if(pending)this.onmessage?.({id:pending.id,error:{code:-32000,message:'The Autosell Chrome tab closed before attachment finished'}});}
    this.onmessage?.(message);
  }
  close(){
    if(this.closed||this.closing)return;this.closing=true;
    for(const timer of this.focusTimers.values())clearTimeout(timer);this.focusTimers.clear();
                                                                                 
    const targets=[...this.owned];let remaining=targets.length;
    const finish=()=>{if(this.closed)return;clearTimeout(this.closeTimer);this.closed=true;this.socket.close();this.terminateTimer=setTimeout(()=>this.socket.terminate?.(),1000);this.terminateTimer.unref?.();};
    if(!remaining){finish();return;}
    this.closeTimer=setTimeout(finish,1000);this.closeTimer.unref?.();
    for(const targetId of targets){try{this.command('Target.closeTarget',{targetId},()=>{if(!--remaining)finish();});}catch{finish();}}
  }
}
function parseEndpoint(metadata){
  const lines=metadata.trim().split(/\r?\n/),port=lines[0],endpoint=lines[1]||'/devtools/browser';
  if(!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535||lines.length>2||!/^\/devtools\/browser(?:\/[A-Za-z0-9_-]{1,128})?$/.test(endpoint))throw Error('Chrome consent listener metadata is invalid');
  return 'ws://127.0.0.1:'+port+endpoint;
}
function consentEndpoint(){
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw Error('Chrome consent attachment currently supports Windows only');
  const file=path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data','DevToolsActivePort');
  let metadata;try{if(fs.statSync(file).size>1024)throw Error();metadata=fs.readFileSync(file,'utf8');}catch{throw Error('Enable Chrome remote debugging at chrome://inspect/#remote-debugging; no consent listener was found');}
                                                                                 
  return parseEndpoint(metadata);
}
async function connectChrome(chromium,options,profileTabs){
  const deadline=Date.now()+options.timeout;
  const socket=new WebSocket(consentEndpoint(),{headers:{'User-Agent':'Autosell/1.0 Chrome debugging client'},handshakeTimeout:60000,maxPayload:8*1024*1024,perMessageDeflate:false});
  const transport=new OwnedCDPTransport(socket,profileTabs);
  try{
    await waitForOpen(socket,Math.max(1,deadline-Date.now()));
    const browser=await chromium.connectOverCDP(transport,{...options,timeout:Math.max(1,deadline-Date.now())});
                                                                                
    browser.autosellOwnedBackground=true;
    browser.autosellDisconnect=()=>transport.close();
    return browser;
  }catch(error){transport.close();throw error;}
}
function waitForOpen(socket,timeoutMs){
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',closed);error?reject(error):resolve();};
    const opened=()=>finish(),failed=()=>finish(Error('Chrome consent listener is unavailable')),closed=()=>finish(Error('Chrome closed or declined the debugging connection. Approve the connection prompt and try again.'));
    const timer=setTimeout(()=>finish(Error('Chrome did not approve/open the consent connection before the connection timeout')),timeoutMs);
    socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',closed,{once:true});
  });
}
module.exports={OwnedCDPTransport,connectChrome,consentEndpoint,parseEndpoint,waitForOpen};
