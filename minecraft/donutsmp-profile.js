'use strict';
                                                                             
                                                                              
                                                                    
const source = 'Bundled DonutSMP reply profile v1; actual system replies and payment debit are checked at command time.';
const legacySuccess = '^You paid (?<ign>\\.?[A-Za-z0-9_]{3,16}) \\$ (?<amount>[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)(?<unit>[KkMmBbTt])?$';
const taxedSuccess = '^You paid (?<ign>\\.?[A-Za-z0-9_]{3,16}) \\$ (?<amount>[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)(?<unit>[KkMmBbTt])?(?: \\(\\+\\$ (?<taxAmount>[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)(?<taxUnit>[KkMmBbTt])? tax\\))?$';
function incomingDefaults() {
  const ign = '(?<ign>\\.?[A-Za-z0-9_]{3,16})';
  const value = '\\$\\s*(?<amount>[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)(?<unit>[KkMmBbTt])?';
  const prefix = '(?:\\[[A-Za-z0-9+ _-]{1,24}\\]\\s+)?';
                                                                        
                                                                               
                                                                                
  return {incomingMode:'donutsmp-builtin',incomingSource:'Bundled legacy DonutSMP incoming receipt formats; verified against each armed sale',incomingPatterns:[
    '^'+prefix+ign+'\\s+(?:has\\s+)?(?:paid|sent|transferred|gave)\\s+you\\s+'+value+'[.!]?$',
    '^'+prefix+ign+'\\s+(?:has\\s+)?(?:paid|sent|transferred|gave)\\s+'+value+'\\s+to\\s+you[.!]?$',
    '^You\\s+(?:have\\s+)?(?:received|got|were\\s+paid|gained)\\s+'+value+'\\s+from\\s+'+prefix+ign+'[.!]?$',
    '^You\\s+(?:were\\s+paid|got|have\\s+been\\s+paid)\\s+'+value+'\\s+by\\s+'+prefix+ign+'[.!]?$',
    '^(?:Received|Got)\\s+'+value+'\\s+from\\s+'+prefix+ign+'[.!]?$',
    '^'+value+'\\s+(?:has\\s+been\\s+)?(?:received|added|credited)\\s+from\\s+'+prefix+ign+'[.!]?$',
  ]};
}
function profile() {
  const learned = require('../ops/balance-pattern').balancePattern({ raw: 'You have $ 1K', position: 'system', sender: null }, '1K');
  return {
    ...incomingDefaults(),
    serverProfile: 'donutsmp-v1', source, balanceSource: source,
    balance: learned.balance, balanceDisplay: { compact: true, source },
    balanceCalibrated: true, calibrated: true, systemPositions: ['system'], timeoutMs: 10000,
    recipientBalance: '^' + '(?<ign>\\.?[A-Za-z0-9_]{3,16}) has \\$ (?<amount>[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)? ?[KkMmBbTt]?)' + '$',
    recipientBalanceCalibrated: true, recipientBalanceSource: source,
    success: taxedSuccess,
    confirmationUnits: { K: '1000', M: '1000000', B: '1000000000', T: '1000000000000', k: '1000', m: '1000000', b: '1000000000', t: '1000000000000' },
    confirmationUnitsSource: source, paymentSource: source,
  };
}
function isDonutHost(host) { return typeof host === 'string' && /^(?:[a-z0-9-]+\.)*donutsmp\.net$/i.test(host.trim()); }
async function configure(settings) {
  if (!isDonutHost(await settings.get('mc.server.host'))) return false;
  const previous = await settings.get('delivery.patternPack') || {};
                                                                                
  if (previous.balance && !previous.balance.startsWith('^You have \\$ ')) {
    if (!previous.incoming && !previous.incomingPatterns) await settings.set('delivery.patternPack',{...incomingDefaults(),...previous,serverProfile:'donutsmp-v1'},'donutsmp-incoming-defaults');
    return false;
  }
  const defaults = profile();
  const pack = { ...defaults, ...previous, serverProfile: 'donutsmp-v1' };
  if (!previous.calibrated) for (const key of ['calibrated', 'success', 'confirmationUnits', 'confirmationUnitsSource', 'paymentSource']) pack[key] = defaults[key];
  // Only migrate the exact bundled expression. A seller's reviewed pattern stays intact.
  if (previous.success === legacySuccess && previous.paymentSource === source) pack.success = taxedSuccess;
  if (JSON.stringify(pack) !== JSON.stringify(previous)) await settings.set('delivery.patternPack', pack, 'donutsmp-profile');
  const policy = await settings.get('delivery.policy') || {};
  if(policy.source===source&&policy.taxMode==='buyer'&&String(policy.taxBasisPoints)==='0')
    await settings.set('delivery.policy',{...policy,taxMode:'sender_budget'},'donutsmp-tax-budget-upgrade');
  if (!policy.source) await settings.set('delivery.policy', {
    orderAmountMode: 'command', unitSize: '1000000', minOrder: '1000000', maxOrder: String(Number.MAX_SAFE_INTEGER),
    maxPay: '100000000', maxChunks: 1000, taxMode: 'sender_budget', taxBasisPoints: '0', reserve: '0',
    gameId: 'DonutSMP', serverId: 'DonutSMP', paidStatuses: ['Pending delivery'], bedrockPrefix: '.',
    cooldownMs: 0, markRetryMs: 30000, markEscalateMs: 600000, ...policy,
    source, calibrated: true, commandCapacityObserved: true,
  }, 'donutsmp-profile');
  return true;
}
module.exports = { profile, configure, isDonutHost };
