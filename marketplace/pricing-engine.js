'use strict';
const { integer } = require('../minecraft/verified-payments');
const ceil = (n, d) => (n + d - 1n) / d;
class PricingEngine {
  constructor(settingsRegistry) { this.settingsRegistry = settingsRegistry; }
  async calculatePrice(cost, suppliedPolicy, units) {
    const policy = suppliedPolicy || await this.settingsRegistry.get('pricing.policy');
    if (!cost?.source || !Number.isSafeInteger(cost.timestamp) || !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0 ||
        cost.timestamp > Date.now() || Date.now() - cost.timestamp > policy.maxAgeMs) throw new Error('Cost/price data missing, future dated or stale');
    if (!units?.verified || !units.priceCurrency || cost.currency !== units.priceCurrency) throw new Error('Cost and documented listing currency mismatch');
    const coins = integer(cost.coins), spent = integer(cost.fiatMicros) + integer(cost.feeFiatMicros);
    const scale = integer(units.priceScale), unit = integer(units.coinsPerUnit);
    if (!coins || !scale || !unit) throw new Error('Positive cost quantity, price scale and coin unit required');
    const commission = integer(policy.commissionBasisPoints), margin = integer(policy.minMarginBasisPoints), tax = integer(policy.payTaxBasisPoints);
    if (commission + margin >= 10000n || tax >= 10000n) throw new Error('Invalid commission/margin/tax bounds');
                                                                                                                                
    const numerator = spent * unit * scale * 10000n * 10000n;
    const denominator = coins * 1000000n * (10000n - tax) * (10000n - commission - margin);
    const minimum = ceil(numerator, denominator);
    let price;
    if (policy.strategy === 'cost_plus_margin') price = minimum;
    else if (policy.strategy === 'fixed_per_million') {
      price = ceil(integer(policy.fixedMinorPerMillion) * unit, 1000000n);
      if (price < minimum) throw new Error('Fixed price violates minimum margin');
    } else throw new Error('Pricing strategy unsupported; competitor access has no supplied permission/contract');
    if (!price) throw new Error('Zero listing price refused');
    let wirePrice;
    if (units.priceWireFormat === 'minor-integer') wirePrice = String(price);
    else if (units.priceWireFormat === 'decimal' && /^10*$/.test(String(scale))) {
      const decimals = String(scale).length - 1;
      wirePrice = String(price / scale) + (decimals ? '.' + String(price % scale).padStart(decimals, '0') : '');
    } else throw new Error('UNVERIFIED price wire format');
    return { price: wirePrice, priceMinor: String(price), minimumMinor: String(minimum), scale: String(scale), currency: cost.currency,
      math: { purchasedNetCoins: String(coins), purchaseFiatMicros: String(cost.fiatMicros), feeFiatMicros: String(cost.feeFiatMicros),
        commissionBasisPoints: String(commission), minMarginBasisPoints: String(margin), payTaxBasisPoints: String(tax), unitCoins: String(unit),
        minimumNumerator: String(numerator), minimumDenominator: String(denominator), rounding: 'up' },
    };
  }
}
module.exports = { PricingEngine };
