'use strict';
const {integer,validIgn} = require('../minecraft/verified-payments');
                                                                           
                                                                                 
async function read(verifier,bot) {
  const before = await verifier.readBalance(bot);
  if (verifier.lastBalanceObservation?.exact) return before;
  if (verifier.pack.recipientBalanceCalibrated && validIgn(bot.username)) {
    const own = await verifier.readRecipientBalance(bot,bot.username);
    if (own.exact && own.balance !== null) {
      verifier.lastBalanceObservation={balance:own.balance,display:own.display,exact:true,command:'/bal '+bot.username};
      return integer(own.balance);
    }
  }
  throw Error('The server only returned rounded balances. Do not send money: an exact incoming amount cannot yet be confirmed automatically.');
}
module.exports={read};
