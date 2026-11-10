'use strict';

module.exports = {
  skelly: {
    successTitle: '✅ Skellys bought',
    failedTitle: '❌ Sale failed',
    paidLine: '**Paid:** {ltc} LTC (${usd}) to your address.\n🔗 {txLink}',
    paidLineNoTx: '**Paid:** {ltc} LTC (${usd}) to your address.',
    successDesc: 'Bought **{count}** skeleton spawner(s).\n{paidLine}{vouchLine}',
    failedDesc: '{reason}.\n\n⚠️ I collected **{collected}** spawner(s) but couldn\'t credit you — staff will resolve this manually.',
    failedDescNoCollected: '{reason}.',
    stepPrefix: '🔄 {content}'
  }
};
