'use strict';
const operations = new Set(['listOrders', 'getOrder', 'listOffers', 'getOffer', 'createOffer', 'updateOffer', 'pauseOffer', 'resumeOffer', 'markDelivered', 'cancelOrder', 'getMessages', 'sendMessage']);
const reads = new Set(['listOrders', 'getOrder', 'listOffers', 'getOffer', 'getMessages']);
function missing(profile, name, mode = 'live') {
  const absent = [];
  if (!profile?.verified || !profile.source || !profile.reviewedAt) absent.push('reviewed seller-page observations');
  if (profile?.synthetic && mode !== 'mock') absent.push('real seller pages (fixture profiles cannot unlock live)');
  if (mode !== 'mock' && !profile?.permissionConfirmed) absent.push('owner confirmation of permission for this browser workflow');
  if (mode !== 'mock' && profile?.origin !== 'https://www.eldorado.gg') absent.push('supported Eldorado HTTPS origin');
  if (!profile?.accountIdentity?.selector || !profile.accountIdentity.value) absent.push('observed logged-in seller identity');
  const contract = profile?.contract;
  if (!contract?.fields?.verified || !contract.fields.source) absent.push('observed field mapping');
  if (!contract?.units?.verified || !/^\d+$/.test(String(contract.units.coinsPerUnit)) || BigInt(contract.units.coinsPerUnit) < 1n || !contract.units.priceDescription) absent.push('observed quantity and price units');
  if (!contract?.statuses?.verified || !contract.statuses.paid?.length || !contract.statuses.values?.length) absent.push('observed funded and terminal statuses');
  const op = profile?.operations?.[name];
  if (!operations.has(name) || !op?.verified || !op.source || !op.url || !op.ready?.selector || !op.result || !op.complete?.selector) absent.push('observed operation ' + name);
  if (!reads.has(name) && (!Array.isArray(op?.steps) || !op.steps.length || !op.guard?.selector || !op.after?.selector)) absent.push('observed mutation guards and confirmation for ' + name);
  if (['getOrder','getOffer','updateOffer','pauseOffer','resumeOffer','markDelivered','cancelOrder','getMessages','sendMessage'].includes(name) && !op?.url?.includes('{id}') && op?.guard?.param !== 'id') absent.push('resource-specific observed URL or identity guard for ' + name);
  if (!reads.has(name) && name !== 'createOffer' && op?.guard?.param !== 'id') absent.push('exact resource identity guard for ' + name);
  if (name === 'sendMessage' && op?.newResultId !== true) absent.push('new seller-message identity confirmation');
  for (const key of ['actionMs', 'characterMs', 'timeoutMs']) if (!Number.isSafeInteger(profile?.pacing?.[key]) || profile.pacing[key] < (key === 'timeoutMs' ? 100 : 1) || profile.pacing[key] > 60000) absent.push('bounded pacing.' + key);
  return absent;
}
function requireProfile(profile, operation, mode) {
  const absent = missing(profile, operation, mode);
  if (absent.length) {
    const error = new Error('UNVERIFIED browser workflow: ' + absent.join('; '));
    error.code = 'MARKETPLACE_SETUP_UNVERIFIED';
    throw error;
  }
  return profile.operations[operation];
}
module.exports = { missing, requireProfile, operations, reads };
