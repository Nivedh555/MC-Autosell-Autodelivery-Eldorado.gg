'use strict';
const emptyContract = require('./contract/eldorado.json');
const apiSettings = [
  { id: 'eldorado.contract', type: 'object', default: emptyContract, label: 'Documented contract manifest', description: 'UNVERIFIED until actual seller documentation and read-only responses establish the mappings. A credential alone does not verify a contract.' },
  { id: 'eldorado.api.key', type: 'secret', default: '', secret: true, label: 'Seller API credential', description: 'Stored only in the owner vault; contract.auth.vaultKey must reference this setting ID.' },
  { id: 'eldorado.api.clientId', type: 'secret', default: '', secret: true, label: 'Seller API Client ID', description: 'From Eldorado Dashboard → Seller API. Stored in the encrypted vault.' },
  { id: 'eldorado.api.clientSecret', type: 'secret', default: '', secret: true, label: 'Seller API Client secret', description: 'Shown once by Eldorado. Stored in the encrypted vault; never returned by setup.' },
  { id: 'eldorado.poll_interval_seconds', type: 'number', default: 60, label: 'Polling interval (seconds)', description: 'Local scheduling default; actual request spacing is constrained by the supplied contract rate limit.' },
  { id: 'eldorado.order.notification_channel', type: 'string', default: '', label: 'Order alert channel', description: 'Discord channel ID selected by the owner.' },
  { id: 'eldorado.order.auto_deliver', type: 'boolean', default: true, label: 'Automatic delivery', description: 'Processes eligible funded orders using verified account, balance and payment replies.' },
  { id: 'marketplace.kill_switch', retired: true, type: 'boolean', default: false, label: 'Retired setting', description: 'Ignored legacy value; Global Autosell controls trading.' },
].map(setting => ({ group: 'Eldorado', secret: false, dangerLevel: 'danger', restartRequired: true, hotReload: false, ...setting }));
function registerEldoradoSettings(registry) { for (const setting of apiSettings) registry.register(setting); }
module.exports = { apiSettings, registerEldoradoSettings };
