'use strict';

async function resolveBind(settings) {
  const port = settings.getSync('security.api.port') ?? 4201;
  let host = settings.getSync('security.api.host') || '127.0.0.1';
  const remoteEnabled = settings.getSync('security.api.remoteEnabled') === true;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Dashboard port must be an integer from 1 to 65535');
                                                                            
                                                                               
  if (['0.0.0.0', '::'].includes(host) && !remoteEnabled) {
    host = '127.0.0.1';
    await settings.set('security.api.host', host, 'startup-loopback-migration');
  }
  if (!['127.0.0.1', '::1'].includes(host) && !remoteEnabled) {
    throw Error('Remote API bind requires explicit opt-in; use security.api.host=127.0.0.1 for local access');
  }
  return { host, port, remoteEnabled };
}

function listen(app, { host, port }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { resolveBind, listen };
