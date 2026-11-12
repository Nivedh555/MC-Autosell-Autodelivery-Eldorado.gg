'use strict';
                                                                                         
const defaults = {
  'security.api.host': '127.0.0.1',
  'security.api.remoteEnabled': false,
  'security.api.allowedOrigins': ['http://127.0.0.1:4201', 'http://localhost:4201'],
  'security.commands.allowlist': [],
  'network.allowedHosts': [],
  'delivery.policy': {},
  'delivery.patternPack': {},
  'rollout.caps': {},
  'marketplace.live_requested': true,                                                    
  'eldorado.order.auto_deliver': true,
  'eldorado.browser.runtime_version': 0,
  'listing.policy': {},
  'pricing.policy': {},
  'payout.policy': {},
  'treasury.accountRoles': {},
  'treasury.policy': {},
  'treasury.forwarding': {},
  'eldorado.chat.local': {},
  'eldorado.chat.templates': require('../web/dist/buyer-guides/messages.json'),
  'eldorado.connection': 'browser',
  'eldorado.browser.profile': require('../marketplace/browser/profile.json'),
  'eldorado.browser.options': {...require('../marketplace/browser/playwright-session').DEFAULTS,channel:'chromium',sessionMode:'persistent'},
};
function registerSafetySettings(registry) {
  for (const [id, value] of Object.entries(defaults)) registry.register({ id, retired: id === 'marketplace.live_requested', default: value, type: Array.isArray(value) ? 'stringArray' : typeof value, group: 'Safety', label: id, description: 'Owner configuration; missing facts block live actions', secret: false });
}
module.exports = { defaults, registerSafetySettings };
