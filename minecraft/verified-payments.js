'use strict';
const channels = new WeakSet();
const { idleBalances } = require('./balance-coordinator');
function reserveCommandChannel(bot, { invalidate = true } = {}) {
  bot = bot.bot || bot;
  if (channels.has(bot)) throw new Error('This account is checking or sending a payment. Wait for it to finish before reading the balance.');
  if (invalidate) idleBalances.invalidate(bot);
  channels.add(bot);
  let released = false;
  return () => { if (!released) { released = true; channels.delete(bot); if (invalidate) idleBalances.invalidate(bot); } };
}
async function commandChannel(bot, fn, options) {
  const release = reserveCommandChannel(bot, options);
  try { return await fn(bot.bot || bot); } finally { release(); }
}
function balanceCommand(command) {
  if(typeof command!=='string'||/[\r\n]/.test(command))return null;
  const match=/^\/bal(?: (\.?[A-Za-z0-9_]{3,16}))?$/.exec(command.trim());
  return match?{command:command.trim(),target:match[1]||null}:null;
}
async function observeBalanceRecord(bot, timeoutMs = 1500, command = '/bal') {
  const request=balanceCommand(command);
  if(!request)throw Error('A balance read requires /bal or /bal followed by one valid Minecraft IGN.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('A bounded balance observation timeout is required.');
  return commandChannel(bot, rawBot => require('./command-pacer').paceCommand(rawBot,()=>new Promise((resolve, reject) => {
    const lines = [];
    const sentAt = Date.now(), sentMonotonicNs = process.hrtime.bigint().toString();
    const listener = (raw, position, _original, sender) => { if (!sender && position !== 'chat' && lines.length<250) lines.push({raw:String(raw).slice(0,4000),position:position ?? null,sender:sender ?? null,wallMs:Date.now(),monotonicNs:process.hrtime.bigint().toString()}); };
    const finish = error => { clearTimeout(timer); rawBot.removeListener('messagestr', listener); rawBot.removeListener('end', disconnected); error ? reject(error) : resolve({command:request.command,commandWallMs:sentAt,commandMonotonicNs:sentMonotonicNs,lines,verified:false}); };
    const disconnected = () => finish(new Error('Account disconnected while reading /bal. Reconnect and try again.'));
    const timer = setTimeout(() => finish(), timeoutMs);
    rawBot.on('messagestr', listener); rawBot.once('end', disconnected);
    try { require('./command-pacer').markDispatched(rawBot);rawBot.chat(request.command); } catch (error) { finish(error); }
  })));
}
async function observeBalance(bot, timeoutMs = 1500, command = '/bal') {
  const result = await observeBalanceRecord(bot, timeoutMs, command);
  return result.lines.map(line => line.raw);
}
function integer(value, label = 'amount') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer or decimal string`);
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a nonnegative integer`);
  return BigInt(value);
}
function validIgn(ign, prefix = '.') {
  if (typeof ign !== 'string' || !['', '.'].includes(prefix)) return false;
  return (prefix === '.' ? /^\.?[A-Za-z0-9_]{3,16}$/ : /^[A-Za-z0-9_]{3,16}$/).test(ign);
}
function amounts(net, policy) {
  net = integer(net);
  const tax = integer(policy.taxBasisPoints, 'tax');
  if (tax >= 10000n) throw new Error('Tax must be below 100%');
  let command = net, debit = net;
  if (policy.taxMode === 'recipient') {
    command = (net * 10000n + (10000n - tax) - 1n) / (10000n - tax);
    if (command * (10000n - tax) / 10000n !== net) throw new Error('Cannot deliver exact amount with this tax rounding');
    debit = command;
  } else if (policy.taxMode === 'buyer') {
                                                                          
                                                                               
  } else if (policy.taxMode === 'sender') debit = command + command * tax / 10000n;
  else if (policy.taxMode !== 'none' || tax !== 0n) throw new Error('Invalid tax policy');
  return { net, command, debit };
}
function splitAmount(total, policy) {
  let remaining = integer(total); const cap = integer(policy.maxPay); const result = [];
  if (!remaining || !cap) throw new Error('Positive amount and cap required');
  const maxNet = policy.taxMode === 'recipient' ? cap * (10000n - integer(policy.taxBasisPoints)) / 10000n : cap;
  if (!maxNet) throw new Error('Cap too small after tax');
  while (remaining > 0n) {
    if (result.length >= (policy.maxChunks || 1000)) throw new Error('Chunk count limit exceeded');
    const net = remaining < maxNet ? remaining : maxNet;
    result.push(amounts(net, policy)); remaining -= net;
  }
  return result;
}
function deliveryPolicy(policy){return policy.orderAmountMode==='command'&&policy.taxMode==='recipient'?{...policy,taxMode:'buyer'}:policy;}
class VerifiedPayments {
  constructor(pack, capture = () => {}, step = (_name, fn) => fn(), { readOnly = false } = {}) {
    if (!pack || !(pack.calibrated || (readOnly && pack.balanceCalibrated)) || !pack.source) throw new Error(readOnly ? 'The server balance reply has not been reviewed. Open this bot’s Settings → Set up balance reading, capture /bal and confirm the exact reply. No payment was sent.' : 'UNVERIFIED payment reply and server limits. Capture a controlled payment before automatic delivery can send coins.');
    for (const key of readOnly ? ['balance'] : ['balance', 'success']) {
      if (typeof pack[key] !== 'string' || !pack[key].startsWith('^') || !pack[key].endsWith('$')) throw new Error(`${key} pattern must be anchored`);
    }
    if (!Number.isInteger(pack.timeoutMs) || pack.timeoutMs < 1) throw new Error('Pattern timeout required');
    if (!Array.isArray(pack.systemPositions) || !pack.systemPositions.length) throw new Error('Trusted packet positions required');
    this.pack = pack; this.capture = capture; this.step = step; this.readOnly = readOnly;
    this.balancePattern = new RegExp(pack.balance);
    this.successPattern = readOnly ? null : new RegExp(pack.success);
  }
  async exclusive(bot, fn) {
    bot = bot.bot || bot;
    const capture = (raw, position, _original, sender) => this.capture('chat', {
      raw: String(raw), position: position ?? null, sender: sender ?? null,
      wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(),
    });
    return commandChannel(bot, async raw => {
      raw.on('messagestr', capture);
      try { return await fn(raw); } finally { raw.removeListener('messagestr', capture); }
    });
  }
  _number(text) {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text || '')) throw new Error('Balance/amount is rounded or malformed');
    return integer(text.replace(/,/g, ''));
  }
  _confirmationAmount(groups) {
    if (!groups?.unit) return this._number(groups?.amount);
                                                                          
                                                                            
                                                                               
    const scale=this.pack.confirmationUnits?.[groups.unit];
    if (!scale || !this.pack.confirmationUnitsSource) throw Error('Unreviewed payment confirmation unit');
    if (/[.]/.test(groups.amount || '')) {
      const decimal = /^(\d+)\.(\d+)$/.exec(groups.amount);
      if (!decimal) throw Error('Malformed payment confirmation amount');
      const numerator = BigInt(decimal[1] + decimal[2]) * integer(scale, 'confirmation unit'), divisor = 10n ** BigInt(decimal[2].length);
      if (numerator % divisor) throw Error('Payment confirmation contains a fraction of one coin');
      return numerator / divisor;
    }
    return this._number(groups.amount)*integer(scale,'confirmation unit');
  }
  _exchange(bot, command, match, onSent, beforeSend, timeoutMs = this.pack.timeoutMs) {
    return require('./command-pacer').paceCommand(bot,async()=>{
      await beforeSend?.();
      return this._exchangeNow(bot,command,match,onSent,undefined,timeoutMs);
    });
  }
  _exchangeNow(bot, command, match, onSent, beforeSend, timeoutMs = this.pack.timeoutMs) {
    return new Promise((resolve, reject) => {
      let sent = false;
      const finish = (error, value) => { clearTimeout(timer); bot.removeListener('messagestr', listener); bot.removeListener('end', disconnected); error ? reject(error) : resolve(value); };
      const disconnected = () => finish(new Error('Session disconnected: command outcome unknown'));
      const listener = (raw, position, original, sender) => {
        if (!sent) return;
        const capture = { raw: String(raw), position: position ?? null, sender: sender ?? null, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), command };
        if (bot.transport === 'fabric' && typeof original?.fabricReceiptId === 'string')
          capture.fabricReceiptId = original.fabricReceiptId;
        try {
          if (sender || !this.pack.systemPositions.includes(position)) return;
          const text = String(raw).replace(/§./g, '');
          if (/^\s*(?:<|\[[^\]]*\]\s*[^:]+:)|\bwhispers?\b/i.test(text)) return;
          if(/^You need to wait another [0-9.]+ seconds? to execute a command[.!]?$/i.test(text.trim()))throw Object.assign(Error('Server command cooldown rejected the command; reconcile before any payment retry'),{code:'SERVER_COMMAND_COOLDOWN'});
          const value = match(text, original);
          if (value !== null) finish(null, { ...value, capture });
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('Command reply timeout; outcome unknown')), timeoutMs);
      bot.on('messagestr', listener); bot.once('end', disconnected);
      try {
        beforeSend?.();
        if(/^\/pay /.test(command))require('../services').maintenance?.assertCanDispatch();
        this.capture('command', { command, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() });
        sent = true;
        require('./command-pacer').markDispatched(bot);
        bot.chat(command);
        onSent?.();
      } catch (error) { finish(error); }
    });
  }
  async readBalance(bot) {
    const result = await this._exchange(bot, '/bal', (text,original) => {
      const m = this.balancePattern.exec(text);
      if (!m) return null;
      if (this.pack.balanceDisplay?.compact && this.pack.balanceDisplay.source) {
        const parsed = require('./balance-display').balanceDisplay(m.groups?.amount);
        // Some servers put the full integer in a hover tooltip on the same system balance message.
        const hover=bot.transport==='fabric' && original?.fabricBalanceHover;
        if(!parsed.exact && typeof hover==='string' && /^(?:0|[1-9][0-9]{0,17})$/.test(hover)){
          const unit={K:1000n,M:1000000n,B:1000000000n,T:1000000000000n}[parsed.display.trim().slice(-1).toUpperCase()];
          const fractional=(parsed.display.match(/\.(\d+)/)||[])[1]?.length||0;
          const quantum=unit/(10n**BigInt(fractional));
          const difference=BigInt(hover)-BigInt(parsed.amount);
          if((difference===0n)||(difference<quantum && difference> -quantum))return {balance:hover,display:parsed.display,exact:true,balanceSource:'server balance component hover'};
        }
        if (!parsed.exact && !this.readOnly) throw Error('The server returned an abbreviated sender balance (' + parsed.display + '). It can be displayed, but cannot confirm an exact payment debit. No payment is sent by this balance read.');
        return { balance: parsed.amount, display: parsed.display, exact: parsed.exact };
      }
      return { balance: this._number(m.groups?.amount).toString(), display: m.groups.amount, exact: true };
    });
    this.lastBalanceObservation = { balance: result.balance, display: result.display, exact: result.exact, observedMs: result.capture.wallMs, ...(result.balanceSource?{source:result.balanceSource}:{}) };
    this.capture('BALANCE_DISPLAY', this.lastBalanceObservation);
    return integer(result.balance);
  }
  async readIdleBalance(bot, { maxAgeMs = 5000 } = {}) {
    if (!this.readOnly) throw Error('Only a read-only verifier may request a cached idle balance.');
    bot = bot.bot || bot;
    const key = JSON.stringify([this.pack.source, this.pack.balance, this.pack.balanceDisplay, this.pack.systemPositions, this.pack.timeoutMs]);
    const observation = await idleBalances.read(bot, key, () => commandChannel(bot, async raw => {
      await this.readBalance(raw);
      return this.lastBalanceObservation;
    }, { invalidate: false }), { maxAgeMs, available: () => !channels.has(bot) });
    this.lastBalanceObservation = { balance: observation.balance, display: observation.display, exact: observation.exact, observedMs: observation.observedMs, ...(observation.source ? { source: observation.source } : {}), cached: observation.cached, shared: observation.shared === true };
    return integer(observation.balance);
  }
  async readRecipientBalance(bot, ign, {timeoutMs=this.pack.timeoutMs}={}) {
    if (!validIgn(ign)) throw Error('Invalid recipient for balance evidence');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>this.pack.timeoutMs)throw Error('Recipient balance timeout must fit the configured reply window');
    const pattern = this.pack.recipientBalance;
    if (!this.pack.recipientBalanceCalibrated || typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) {
      throw Error('Recipient balance evidence needs a captured, reviewed /bal IGN reply. No recipient balance was inferred.');
    }
    const regex = new RegExp(pattern);
    const result = await this._exchange(bot, '/bal ' + ign, text => {
      const match = regex.exec(text);
      if (!match || match.groups?.ign?.toLowerCase() !== ign.toLowerCase()) return null;
      const display=match.groups?.amount;
      if(typeof display!=='string'||!display||display.length>32)throw Error('Missing bounded recipient balance display');
      const exact=/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(display);
      return {balance:exact?this._number(display).toString():null,display,exact,recipient:match.groups.ign,
        scope:'Captured recipient balance display; only the sender balance delta and matching payment confirmation verify the payment.'};
    }, undefined, undefined, timeoutMs);
    this.capture('RECIPIENT_BALANCE', result);
    return result;
  }
  async pay(bot, ign, chunk, before, onSent, beforeSend) {
    if (this.readOnly) throw new Error('Read-only balance verifier cannot send payments');
    idleBalances.invalidate(bot);
    let signal = null, signalError = null;
    try {
      signal = await this.step('confirmation', () => this._exchange(bot, `/pay ${ign} ${chunk.command}`, text => {
        const m = this.successPattern.exec(text);
        if (!m || m.groups?.ign?.toLowerCase() !== ign.toLowerCase() || this._confirmationAmount(m.groups) !== chunk.command) return null;
        return { recipient: ign, amount: chunk.command.toString(), display:m.groups.amount+(m.groups.unit||''),
          scope:'Matching recipient and confirmation display; exact payment requires independent sender balance debit' };
      }, onSent, beforeSend));
    } catch (error) { if (error.simulatedCrash) throw error; signalError = error.message; }
                                                                                                
    let after;
    try { after = await this.step('post_balance', () => this.readBalance(bot)); }
    catch (error) {
      if (error.simulatedCrash) throw error;
      return { before: String(before), after: null, delta: null, possibleDebit: String(chunk.debit), signal, signalError,
        verified: false, reason: 'Post-payment balance unavailable; debit unknown, do not resend: ' + error.message };
    }
    const delta = before - after;
    return { before: before.toString(), after: after.toString(), delta: delta.toString(), signal, signalError,
      verified: Boolean(signal) && delta === chunk.debit,
      reason: !signal ? `Missing anchored confirmation; observed debit ${delta}; never resend automatically` : delta !== chunk.debit ? `Balance mismatch: expected debit ${chunk.debit}, observed ${delta}` : null };
  }
}
module.exports = { VerifiedPayments, integer, validIgn, amounts, splitAmount, deliveryPolicy, observeBalance, observeBalanceRecord, balanceCommand, reserveCommandChannel, isChannelBusy: bot => channels.has(bot.bot || bot) };
