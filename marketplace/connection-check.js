'use strict';
// A read-only probe deliberately gets its own token cache. Saving credentials must
// never make a successful check refer to the previous credential pair.
async function checkSavedConnection(services, options = {}) {
  const configured = await services.settings.get('eldorado.connection');
  const state = require('./connection-state').connectionState(configured, services);
  if (!['api', 'hybrid'].includes(configured)) {
    return {success:false,error:'Choose Browser + API and save the connection first.'};
  }
  const Adapter = options.Adapter || require('./adapters/eldorado-seller').EldoradoSellerAdapter;
  const probe = new Adapter({services, vault:services.vault, mode:'read-only', ...(options.transport ? {transport:options.transport} : {})});
  const result = await probe.testConnection();
  return {...result, checkedAt:new Date().toISOString(), restartRequired:state.restartRequired,
    workerMessage:state.reason,
    message:result.success ? 'Saved API credentials accepted. Sold Orders can be read.' : undefined};
}
module.exports = {checkSavedConnection};
