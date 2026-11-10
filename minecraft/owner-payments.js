'use strict';
const { VerifiedPayments } = require('./verified-payments');

                                                                            
                                                                           
                                                                                  
class OwnerPayments extends VerifiedPayments {
  constructor(pack, capture) {
    super(pack, capture);
    this.donutReceipt = pack.paymentSource && (pack.serverProfile === 'donutsmp-v1' || pack.success === '^You paid (?<ign>\\.?[A-Za-z0-9_]{3,16}) \\$ (?<amount>[0-9]+)(?<unit>M)$');
    if (this.donutReceipt) this.successPattern = /^You paid (?<ign>\.?[A-Za-z0-9_]{3,16}) \$ (?<amount>[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,4})?)(?<unit>[KMBT])?$/;
  }
  _confirmationAmount(groups) {
    if (!this.donutReceipt || !groups.unit) return super._confirmationAmount(groups);
    const scale = { K: 1000n, M: 1000000n, B: 1000000000n, T: 1000000000000n }[groups.unit];
    const [whole, fraction = ''] = groups.amount.replaceAll(',', '').split('.');
    const divisor = 10n ** BigInt(fraction.length), display = BigInt(whole + fraction) * scale;
    const target = this.nominal * divisor;
                                                                           
                                                                                
    if (target * 2n >= display * 2n - scale && target < display + scale) return this.nominal;
    return display / divisor;
  }
  async pay(bot, ign, chunk, before, onSent, beforeSend) {
    this.nominal = chunk.command;
    const result = await super.pay(bot, ign, chunk, before, onSent, beforeSend);
    if (this.donutReceipt && result.signal) result.signal.scope = 'Recipient-matching system receipt with compatible compact display; exact coins verified by sender balance debit.';
    return result;
  }
}
module.exports = { OwnerPayments };
