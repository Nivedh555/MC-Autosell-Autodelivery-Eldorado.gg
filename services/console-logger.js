'use strict';
const { format } = require('node:util');
const { clean, readableReason } = require('../discord/log-text');
const palette = { muted: '\x1b[90m', component: '\x1b[36m', text: '\x1b[37m', INFO: '\x1b[36m', READY: '\x1b[32m', WAIT: '\x1b[33m', ERROR: '\x1b[31m', ORDER: '\x1b[35m' };
const symbols = { INFO: '·', READY: '✓', WAIT: '!', ERROR: '×', ORDER: '◆' };
const reset = '\x1b[0m';
let installed = false, output, errorOutput;
function colorEnabled(stream = process.stdout, env = process.env) {
  if (Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return Boolean(stream.isTTY);
}
function safe(value, limit = 600) { return clean(value ?? 'not captured', limit).replace(/[\x00-\x1f\x7f]/g, ' '); }
function wrap(text, width) {
  const lines = [];
  let remaining = text;
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(' ', width);
    const split = space > width / 2 ? space : width;
    lines.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines;
}
                                                                              
function render(level, component, message, details = {}, options = {}) {
  level = Object.hasOwn(symbols, level) ? level : 'INFO';
  const colored = options.color ?? colorEnabled();
  const paint = (key, value) => colored ? palette[key] + value + reset : value;
  const stamp = (options.now || new Date()).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const columns = options.columns || process.stdout.columns || 108;
  const prefix = '  ' + stamp + '  ' + symbols[level] + ' ' + level.padEnd(5) + '  ' + safe(component, 16).toUpperCase().padEnd(16) + ' │ ';
  const bodyWidth = Math.max(24, Math.min(columns, 120) - prefix.length);
  const lines = wrap(safe(message, 1600), bodyWidth);
  const header = '  ' + paint('muted', stamp) + '  ' + paint(level, symbols[level] + ' ' + level.padEnd(5)) + '  ' + paint('component', safe(component, 16).toUpperCase().padEnd(16)) + paint('muted', ' │ ');
  const indent = ' '.repeat(prefix.length - 2) + paint('muted', '│ ');
  const result = [header + paint('text', lines[0]), ...lines.slice(1).map(value => indent + paint('text', value))];
  for (const [key, value] of Object.entries(details).filter(([, value]) => value !== undefined && value !== null)) {
    const text = /password|passphrase|secret|token|cookie|authorization|api.?key/i.test(key) ? '[removed]' : safe(value);
    result.push(...wrap(safe(key, 48) + ': ' + text, bodyWidth).map(value => indent + paint('muted', value)));
  }
  return result.join('\n');
}
function line(level, component, message, details = {}) {
  const text = render(level, component, message, details);
  if (level === 'ERROR' || level === 'WAIT') {
    if (errorOutput) errorOutput(text); else console.error(text);
  } else if (output) output(text); else console.log(text);
}
function legacy(level, args) {
  const text = format(...args);
  if (text.startsWith('Chunk size is ')) return;
  if (!text.trim()) return output('');
  const cleaned = clean(text, 2000);
  const match = cleaned.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  line(level, match?.[1] || 'APP', readableReason(match?.[2] || cleaned));
}
const Logger = {
  colorEnabled, render, line,
  install() {
    if (installed) return;
    installed = true;
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    output = original.log.bind(console);
    errorOutput = original.error.bind(console);
    console.log = (...args) => legacy('INFO', args);
    console.info = (...args) => legacy('INFO', args);
    console.warn = (...args) => legacy('WAIT', args);
    console.error = (...args) => legacy('ERROR', args);
    return () => { Object.assign(console, original); output = undefined; errorOutput = undefined; installed = false; };
  },
  banner(text) {
    const value = colorEnabled() ? text : String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (output) output(value); else console.log(value);
  },
  section(title) {
    const width = Math.max(44, Math.min(process.stdout.columns || 108, 108) - 4);
    const text = '\n  ' + '─'.repeat(width) + '\n  ' + safe(title) + '\n  ' + '─'.repeat(width);
    Logger.banner(colorEnabled() ? palette.muted + text + reset : text);
  },
  bootStep(step, total, title) { line('INFO', 'STARTUP', '[' + step + '/' + total + '] ' + title); },
  bootSuccess(message) { line('READY', 'STARTUP', message); },
  bootInfo(message) { line('INFO', 'STARTUP', message); },
  bootWarn(message) { line('WAIT', 'STARTUP', message); },
  readyBanner(port) { line('READY', 'DASHBOARD', 'Dashboard is listening', { Address: 'http://localhost:' + port }); },
  notice(alert) {
    const details = require('../ops/notification-text').notificationDetails(alert);
    line(details.level === 'success' ? 'READY' : details.level === 'error' ? 'ERROR' : 'WAIT', alert.component || 'AUTOSELL', details.title, {
      Detail: details.summary, 'Next step': details.next, Reference: alert.order_id || alert.orderId || undefined,
    });
  },
  attachRuntimeEvents(services) {
    if (!services?.events || services._runtimeEventsAttached) return;
    services._runtimeEventsAttached = true;
    const on = (event, fn) => services.events.on(event, fn);
    on('session:connecting', ({ accountId }) => line('INFO', accountId, 'Connecting to Minecraft'));
    on('session:ready', ({ accountId }) => line('READY', accountId, 'Session ready for jobs'));
    on('session:idle_grace', ({ accountId, graceMs }) => line('WAIT', accountId, 'No active jobs; idle disconnect scheduled', Number.isFinite(graceMs) ? { 'Disconnect in': Math.round(graceMs / 1000) + ' seconds' } : {}));
    on('session:disconnected', ({ accountId }) => line('INFO', accountId, 'Session disconnected'));
    on('session:banned', ({ accountId, evidence }) => line('ERROR', accountId, 'Possible server restriction; review required', { Reason: readableReason(evidence) }));
    on('mc:payment_received', ({ accountId, username, amountText }) => line('INFO', accountId, 'Incoming payment reply captured; awaiting verification', { From: username, Amount: amountText }));
    on('mc:payment_sent', ({ accountId, username, amountText }) => line('INFO', accountId, 'Outgoing payment reply captured; awaiting verification', { To: username, Amount: amountText }));
    on('marketplace:new_order', ({ order }) => line('ORDER', 'ELDORADO', 'Funded order recorded; awaiting delivery checks', { Order: order.id, IGN: order.buyerIgn, Coins: order.amount }));
    on('marketplace:order_observed', ({ order }) => line('ORDER', 'ELDORADO', 'Sold Order captured', { Order: order.id, Buyer: order.buyerName, Quantity: order.quantityDisplay, Status: order.status }));
    on('marketplace:order_delivered', ({ orderId, buyerIgn, amount, mode, isDryRun }) => line(mode === 'mock' || isDryRun ? 'INFO' : 'READY', 'ELDORADO', mode === 'mock' || isDryRun ? 'Non-live record completed' : 'Payment verified; marketplace delivery acknowledged', { Order: orderId, IGN: buyerIgn, Coins: amount }));
  },
};
module.exports = Logger;
