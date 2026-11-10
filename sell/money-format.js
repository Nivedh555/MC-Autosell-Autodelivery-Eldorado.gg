'use strict';

                                                                       

const MAX = 1e15;

                                                                              
function parseDonutAmount(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!raw) return NaN;
  const m = raw.match(/^(\d+(?:\.\d{1,4})?)([kmbt])?$/);
  if (!m) return NaN;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return NaN;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1;
  const amount = base * mult;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX) return NaN;
  return Number.isInteger(amount) ? amount : Math.round(amount * 1e4) / 1e4;
}

                                       
function formatDonut(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const trim = (x) => Number(x.toFixed(2)).toString();
  if (abs >= 1e12) return `${trim(n / 1e12)}t`;
  if (abs >= 1e9) return `${trim(n / 1e9)}b`;
  if (abs >= 1e6) return `${trim(n / 1e6)}m`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return Math.round(n).toLocaleString('en-US');
}

function formatUsd(value, decimals = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(decimals)}` : '$0.00';
}

module.exports = { parseDonutAmount, formatDonut, formatUsd };
