'use strict';
                                                                                 
                                                                                  
async function configure(settings) {
  if (!['browser','hybrid','api'].includes(await settings.get('eldorado.connection')))return false;
  const version=await settings.get('eldorado.browser.runtime_version')||0;
  if(version>=4)return false;
  if(version===3){
    await settings.set('eldorado.chat.local',{...await settings.get('eldorado.chat.local'),minimalChat:true},'browser-runtime-upgrade');
    await settings.set('eldorado.browser.runtime_version',4,'browser-runtime-upgrade');return true;
  }
  if(version<1)await settings.set('eldorado.order.auto_deliver', true, 'browser-runtime-upgrade');
  const previous = await settings.get('eldorado.chat.local');
  await settings.set('eldorado.chat.local', {
    pollMs: 2000, minIntervalMs: 1000, typingMinMs: 0, typingMaxMs: 0,
    ...previous, ...(version<1?{autoSend:true,openingEnabled:true}:{}), fastReplies:true,
    confirmIgn:true, minimalChat:true, openingMessage:require('../order-chat-flow').DEFAULT_OPENING,
  }, 'browser-runtime-upgrade');
  const policy=await settings.get('delivery.policy');
  if(policy)await settings.set('delivery.policy',{...policy,...(policy.cooldownMs===10000&&!policy.cooldownSource?{cooldownMs:0}:{}),...(policy.markRetryMs===30000?{markRetryMs:2000}:{})},'browser-runtime-upgrade');
  const interval=await settings.get('eldorado.poll_interval_seconds');
  if(!interval||interval===60)await settings.set('eldorado.poll_interval_seconds',5,'browser-runtime-upgrade');
  await settings.set('eldorado.browser.runtime_version', 4, 'browser-runtime-upgrade');
  return true;
}
module.exports = { configure };
