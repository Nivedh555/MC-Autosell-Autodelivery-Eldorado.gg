'use strict';
function createAdapter(options = {}) {
  const settings = options.settings || require('../services').settings;
  const connection = settings?.getSync?.('eldorado.connection') || 'browser';
  if (connection === 'browser') return new (require('./adapters/eldorado-browser').EldoradoBrowserAdapter)(options);
  if (connection === 'hybrid' || connection === 'api') return new (require('./adapters/eldorado-seller').EldoradoSellerAdapter)(options);
  throw new Error('Choose Browser or Browser + API.');
}
module.exports = { createAdapter };
