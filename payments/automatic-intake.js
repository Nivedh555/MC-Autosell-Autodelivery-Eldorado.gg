'use strict';
                                                                                 
                                                                          
async function configure(settings) {
  const previous = await settings.get('payout.policy');
  if (previous && Object.keys(previous).length) return false;
  const tx = Number(await settings.get('wallet.maxPerTxUsd'));
  const day = Number(await settings.get('wallet.maxPerDayUsd'));
  const daily = day > 0 ? Math.min(50,day) : 50;
  const transaction = Math.min(daily,tx > 0 ? tx : 10);
  const policy = require('./payout-policy').validate({enabled:true,addressMode:'linked-seller',allowedAddresses:[],
    maxPerTxFiatMicros:String(Math.floor(transaction*1e6)),maxPerDayFiatMicros:String(Math.floor(daily*1e6))});
  await settings.set('payout.policy',policy,'automatic-intake-defaults');
  return true;
}
module.exports={configure};
