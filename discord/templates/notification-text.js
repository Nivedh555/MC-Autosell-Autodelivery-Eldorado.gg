'use strict';

module.exports = {
  messages: {},
  balance: {
    restockTitle: '💰 Crypto Restock Detected',
    restockDesc: 'The wallet balance increased by **{addedUsd}** and is now **{totalUsd}**.\n\n{capacity}\n\n**Next step:** Review your buying rate and turn on Autosell in the dashboard when you are ready.',
    lowTitle: '⚠️ Low Wallet Balance — Autosell PAUSED',
    lowDesc: 'The wallet balance is **{totalUsd}**, below your configured minimum. **Buying is paused.**\n\n{capacity}\n\n**Next step:** Top up the wallet, review your buying rate and turn on Autosell in the dashboard.'
  }
};
