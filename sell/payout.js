'use strict';
                                                                   
module.exports = {
  payInstant: (discordId, options) => require('../payments/payout-service').payInstant(discordId, options),
  cashout: async () => ({ ok: false, reason: 'operator_reconciliation_required', message: 'Legacy balance cashout is disabled; reconcile sale-specific payout intents first.' }),
};
