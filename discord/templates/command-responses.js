'use strict';

module.exports = {
  commands: {
    noPerms: '⛔ You need the admin role to use this command.',
    unknownCmd: 'Unknown command.',
    noPendingCashouts: '✅ No pending cashouts — everyone has been paid.',
    cashoutsTitle: '💸 Pending Manual Cashouts ({count})',
    pauseResumed: '▶️ **Selling resumed.** Sellers can sell again.',
    pausePaused: '⏸️ **Selling paused.** Sellers see a paused message when they click Sell. Resume with `/sell-resume`.',
    mcConnecting: '🔌 Connecting both buyer accounts…',
    mcDisconnecting: '🔌 Disconnecting both buyer accounts…',
    priceSetZero: '❌ Price must be greater than 0.',
    priceSetSuccess: '✅ Price set to **${usd}** per spawner (saved). Stat channels updated.{panelRefreshNote}',
    rateSetZero: '❌ Rate must be greater than 0.',
    rateSetSuccess: '✅ Money rate set to **${usd} / 1,000,000** (**${perB}/B**) (saved). Stat channels updated.{panelRefreshNote}{fakeNote}',
    unlinkNone: 'ℹ️ <@{id}> had no linked account.',
    unlinkSuccess: '✅ Unlinked <@{id}> (was `{old}`). They’ll re-verify on their next sell.',
    resetNone: 'ℹ️ <@{id}> had no saved settings.',
    resetSuccess: '✅ Cleared <@{id}>\'s settings — IGN, LTC address, and verification wiped (balance kept). They’ll re-enter everything on their next sell.',
    zeroNone: 'ℹ️ <@{id}> has no balance to clear (currently {zero}).',
    zeroSuccess: '✅ Cleared <@{id}>\'s balance of **{had}** → now {zero}. (This did **not** pay them — it just zeroed the balance.)'
  },
};
