'use strict';
                                                                            
                                                                           
                                                                        
                                                                                                    
const prepared = new WeakMap();
function boundedSend(session, method, params) {
  let timer;
  return Promise.race([
    session.send(method, params),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Chrome background command timed out: ' + method)), 5000); }),
  ]).finally(() => clearTimeout(timer));
}
async function prepareBackgroundPage(context, page) {
  if (prepared.has(page)) return prepared.get(page);
  const task = (async () => {
    const session = await context.newCDPSession(page);
    try {
      if (typeof page.on === 'function') {
        const window=await boundedSend(session,'Browser.getWindowForTarget');
        if(window.bounds?.windowState==='minimized'){
          await boundedSend(session,'Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});
          await boundedSend(session,'Page.setWebLifecycleState',{state:'active'});
        }
      }
      await boundedSend(session, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      if (typeof page.goto === 'function' && typeof page.on === 'function') {
        const navigate = page.goto.bind(page);
        page.goto = async (...args) => {
          const { windowId } = await boundedSend(session, 'Browser.getWindowForTarget');
                                                                          
                                                                               
          await new Promise(resolve => setTimeout(resolve, 150));
          const { bounds } = await boundedSend(session, 'Browser.getWindowBounds', { windowId });
          if (bounds.windowState === 'minimized') await boundedSend(session, 'Page.setWebLifecycleState', { state: 'active' });
          try { return await navigate(...args); }
          finally {
                                                                            
                                                                                 
            if (bounds.windowState === 'minimized') await boundedSend(session, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
          }
        };
      }
      return { enabled: true, scope: 'Autosell-owned tab' };
    } catch (error) {
      await session.detach().catch(() => {});
      throw new Error('Could not keep the Autosell tab active in the background. Reconnect the seller browser. No foreground requirement was bypassed with a forced click.', { cause: error });
    }
  })();
  prepared.set(page, task);
  try { return await task; } catch (error) { prepared.delete(page); throw error; }
}
module.exports = { prepareBackgroundPage };
