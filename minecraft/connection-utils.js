'use strict';

                                                                       
function formatMcReason(reason) {
  if (reason == null || reason === '') return 'unknown';
  if (typeof reason === 'string') {
    try { return formatMcReason(JSON.parse(reason)); } catch { return reason.replace(/§./g, '').slice(0, 600); }
  }
  const seen=new Set();let budget=256;
  const text=value=>{
    if(--budget<0)return '';
    if(typeof value==='string')return value.slice(0,600);
    if(!value||typeof value!=='object'||seen.has(value))return '';
    seen.add(value);
    if(Array.isArray(value))return value.slice(0,256).map(text).join('');
    if(value.type==='compound'||value.type==='list'||value.type==='string')return text(value.value);
    return text(value.text)+text(value.extra)+(value.translate?String(value.translate)+text(value.with):'');
  };
  const readable=text(reason).replace(/§./g, '').trim();
  if(readable)return readable.slice(0,600);
  try {
    return JSON.stringify(reason).slice(0, 600);
  } catch {
    return String(reason).slice(0, 600);
  }
}

                                                                         
function isStaleSessionKick(text) {
  const lower = String(text).toLowerCase();
  return lower.includes('already connected') || lower.includes('already online');
}

                                                                                  
function isRecoverableNetworkError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    code === 'econnreset' ||
    code === 'etimedout' ||
    code === 'epipe' ||
    code === 'enetunreach' ||
    code === 'econnrefused' ||
    msg.includes('socket hang up') ||
    msg.includes('keep alive') ||
    msg.includes('keepalive') ||
    msg.includes('keep-alive') ||
    msg.includes('timed out') ||
    msg.includes('write after end') ||
    msg.includes('connection reset') ||
    msg.includes('forcibly closed') ||
    msg.includes('invalid sequence') ||
    msg.includes('client timed out') ||
    msg.includes('read etimedout')
  );
}

                                                                                   
function neutralizeChatAck(bot) {
  try {
    const client = bot._client;
    if (!client) return;

    const lsm = client._lastSeenMessages;
    if (lsm && !lsm.__neutralized) {
      lsm.push = () => false;
      try {
        Object.defineProperty(lsm, 'pending', {
          configurable: true,
          get: () => 0,
          set: () => {},
        });
      } catch {
        lsm.pending = 0;
      }
      lsm.__neutralized = true;
    }

    if (!client.__chatWriteWrapped) {
      const origWrite = client.write.bind(client);
      client.write = (name, params) => {
        if (name === 'message_acknowledgement') return;
        if (
          params &&
          typeof params === 'object' &&
          'checksum' in params &&
          (name === 'chat_command' || name === 'chat_command_signed' || name === 'chat_message')
        ) {
          params.checksum = 0;
        }
        return origWrite(name, params);
      };
      client.__chatWriteWrapped = true;
    }
  } catch {
                                                 
  }
}

                                                                             
function enableSocketKeepAlive(bot, intervalMs = 30_000) {
  try {
    const socket = bot?._client?.socket;
    if (!socket || socket.__mcKeepAliveSet) return;
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, intervalMs);
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    socket.__mcKeepAliveSet = true;
  } catch {
                
  }
}

                                                                 
function safeQuit(bot, reason = 'reconnect') {
  if (!bot) return;
  try {
    bot.quit(reason);
  } catch {
    try {
      bot.end(reason);
    } catch {
      try {
        bot._client?.end(reason);
      } catch {
                    
      }
    }
  }
}

                                                                              
function quitAndWait(bot, reason, timeoutMs = 5000) {
  if(!bot)return Promise.resolve({closed:true,forced:false});
  const protocol=bot._client;
                                                                              
                                                                             
                                                                           
  if(protocol && typeof protocol.setSocket==='function' && !protocol.__autosellRetired){
    protocol.__autosellRetired=true;
    protocol.setSocket=socket=>{socket.on?.('error',()=>{});socket.destroy?.();};
  }
  const socket=bot._client?.socket;
  if(bot._client?.ended && (!socket || socket.destroyed))return Promise.resolve({closed:true,forced:false});
  return new Promise(resolve=>{
    let timer,done=false;
    const finish=forced=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(protocol?.closeTimer);
      bot.removeListener?.('end',onEnd);socket?.removeListener?.('close',onClose);
      resolve({closed:true,forced});
    };
    const onClose=()=>finish(false);
    const onEnd=()=>{if(!socket || socket.destroyed)finish(false);};
    bot.once?.('end',onEnd);socket?.once?.('close',onClose);
    timer=setTimeout(()=>{try{socket?.destroy();}finally{finish(true);}},timeoutMs);
    safeQuit(bot,reason);
    if(!bot.once)finish(false);
  });
}

module.exports = {
  formatMcReason,
  isStaleSessionKick,
  isRecoverableNetworkError,
  neutralizeChatAck,
  enableSocketKeepAlive,
  safeQuit,
  quitAndWait,
};
