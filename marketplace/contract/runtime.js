'use strict';
const crypto = require('node:crypto');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function field(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('Contract requires JSON Pointer');
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (forbidden.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('Response missing documented field: ' + pointer);
    value = value[part];
  }
  return value;
}
function missing(contract, operation) {
  const absent = [];
  if (!contract?.verified || !contract.source || !contract.reviewedAt) absent.push('reviewed contract source');
  if (!contract?.baseUrl) absent.push('base URL');
  const auth = contract?.auth;
  const supportedAuth=auth?.kind==='apiKey'?Boolean(auth.vaultKey):auth?.kind==='clientCredentials'&&Boolean(auth.tokenPath?.startsWith('/')&&!auth.tokenPath.startsWith('//')&&auth.tokenPointer&&auth.body&&['json','form'].includes(auth.requestFormat));
  if (!auth?.verified || !auth.source || !supportedAuth || !auth.header || typeof auth.prefix !== 'string') absent.push('documented Seller API authentication');
  if (!contract?.rateLimit?.verified || !Number.isSafeInteger(contract.rateLimit.minIntervalMs) || contract.rateLimit.minIntervalMs < 0) absent.push('documented request interval');
  if (!contract?.units?.verified || !/^\d+$/.test(String(contract.units.coinsPerUnit)) || BigInt(contract.units.coinsPerUnit) <= 0n || !contract.units.priceDescription) absent.push('amount and price units');
  if (!contract?.statuses?.verified || !Array.isArray(contract.statuses.values) || !Array.isArray(contract.statuses.paid) || !contract.statuses.paid.length) absent.push('order status enumeration');
  if (!contract?.errorModel?.verified || !contract.errorModel.source) absent.push('documented error model');
  if (!contract?.pagination?.verified || !['none', 'cursor','page','offset'].includes(contract.pagination.kind)) absent.push('documented pagination');
  const op = contract?.operations?.[operation];
  if (!op?.verified || !op.source || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method) || !op.path?.startsWith('/') || op.path.startsWith('//') || !Array.isArray(op.successStatuses) || !op.successStatuses.length) absent.push('operation ' + operation);
  return absent;
}
function requireContract(contract, operation, mode) {
  const absent = missing(contract, operation);
  if (contract?.synthetic && mode !== 'mock') absent.push('real documentation (synthetic contracts cannot unlock live)');
  if (absent.length) {
    const error = new Error('UNVERIFIED: ' + absent.join('; '));
    error.code = 'MARKETPLACE_SETUP_UNVERIFIED';
    throw error;
  }
  return contract.operations[operation];
}
function digest(contract) { return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'); }
function normalizeOrder(data, contract) {
  if (!contract.fields?.verified || !contract.fields.source) throw new Error('UNVERIFIED order field mapping');
  const output = {};
  for (const key of ['id', 'buyerIgn', 'amount', 'offerId', 'gameId', 'serverId', 'status']) output[key] = field(data, contract.fields.order[key]);
  for (const key of ['id', 'buyerIgn', 'offerId', 'gameId', 'serverId', 'status']) if (typeof output[key] !== 'string' || !output[key]) throw new Error('Order field type mismatch: ' + key);
  if (!contract.statuses.values.includes(output.status)) throw new Error('Unexpected marketplace order status');
  if (typeof output.amount === 'number' && !Number.isSafeInteger(output.amount) || !/^\d+$/.test(String(output.amount))) throw new Error('Order quantity is not an exact integer');
  const amount = BigInt(output.amount) * BigInt(contract.units.coinsPerUnit);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Order exceeds supported exact ledger range');
  output.amount = Number(amount); output.unitSize = contract.units.coinsPerUnit;
  if (contract.fields.order.price) output.price = field(data, contract.fields.order.price);
  for (const key of ['buyerName','orderedAt','quantityDisplay','priceDisplay','gameLabel','orderUrl']) {
    if (contract.fields.order[key]) output[key] = field(data, contract.fields.order[key]);
  }
  if (contract.fields.order.buyerMarketplaceId) {
    output.buyerMarketplaceId = field(data, contract.fields.order.buyerMarketplaceId);
    if (typeof output.buyerMarketplaceId !== 'string' || !output.buyerMarketplaceId) throw new Error('Observed buyer marketplace identity missing');
  }
  return output;
}
function normalizeObservation(data, contract) {
  if (!contract.fields?.verified || !contract.fields.source) throw Error('UNVERIFIED order field mapping');
  const output = {};
  for (const [key,pointer] of Object.entries(contract.fields.order || {})) {
    try { output[key]=field(data,pointer); } catch(error) { if (['id','status'].includes(key)) throw error; }
  }
  if (typeof output.id !== 'string' || !output.id || typeof output.status !== 'string') throw Error('Captured order identity/status is missing');
  if (contract.units?.verified && /^\d+$/.test(String(output.amount)) && /^\d+$/.test(String(contract.units.coinsPerUnit))) {
    if (typeof output.amount === 'number' && !Number.isSafeInteger(output.amount)) throw Error('Captured quantity exceeds exact integer range');
    output.amount=(BigInt(output.amount)*BigInt(contract.units.coinsPerUnit)).toString();
  }
  return output;
}
function normalizeOffer(data, contract) {
  if (!contract.fields?.verified || !contract.fields.source || !contract.fields.offer || !contract.offerStatuses?.verified) throw new Error('UNVERIFIED offer field mapping and active/paused states');
  const output = {};
  for (const key of ['id','gameId','serverId','status','quantity','price','minOrder']) output[key] = field(data, contract.fields.offer[key]);
  for (const key of ['id','gameId','serverId','status','price']) if (typeof output[key] !== 'string' || !output[key]) throw new Error('Offer field type mismatch: ' + key);
  const states = contract.offerStatuses;
  if (states.active?.includes(output.status)) output.paused = false;
  else if (states.paused?.includes(output.status)) output.paused = true;
  else throw new Error('Offer is expired, restricted or has an unrecognized state');
  for (const key of ['quantity','minOrder']) {
    if (!/^\d+$/.test(String(output[key]))) throw new Error('Offer ' + key + ' is not an exact integer');
    output[key + 'Coins'] = (BigInt(output[key]) * BigInt(contract.units.coinsPerUnit)).toString();
  }
  const scale = BigInt(contract.units.priceScale || 0);
  if (contract.units.priceWireFormat === 'minor-integer' && /^\d+$/.test(output.price)) output.priceMinor = output.price;
  else if (contract.units.priceWireFormat === 'decimal' && /^10*$/.test(String(scale)) && /^\d+(?:\.\d+)?$/.test(output.price)) {
    const [whole, fraction = ''] = output.price.split('.'), decimals = String(scale).length - 1;
    if (fraction.length > decimals) throw new Error('Offer price exceeds configured precision');
    output.priceMinor = (BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
  } else throw new Error('UNVERIFIED displayed price unit or format');
  if (BigInt(output.quantityCoins) < 1n || BigInt(output.minOrderCoins) < 1n || BigInt(output.priceMinor) < 1n) throw new Error('Offer quantities and price must be positive');
  return output;
}
module.exports = { field, missing, requireContract, digest, normalizeOrder, normalizeObservation, normalizeOffer };
