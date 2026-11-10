'use strict';

const crypto = require('crypto');
const services = require('../services');
const { parseDonutAmount, formatDonut, formatUsd } = require('./money-format');
const paymentPatterns = require('../payments/payment-patterns');
const paymentVerifier = require('../payments/payment-verifier');
const payoutService = require('../payments/payout-service');
const sessionManager = require('../minecraft/session-manager');
const admission = require('./intake-admission');

const verifySessions = new Map();
const paySessions = new Map();
const dedup = new Map();
const paymentSeqMap = new Map();                                           
function releaseSession(session) {
  if (session.rawBot) paymentVerifier.disarm(session.rawBot);
  try { session.lease?.release(); } finally { session.admission?.release(); }
}

function dmUser(discordId, payload) {
  if (!services.discordClient?.users) return Promise.resolve();
  return services.discordClient.users
    .fetch(discordId)
    .then((u) => u.send(payload))
    .catch(() => {});
}

function isDuplicate(key, ttl = 30_000) {
  const now = Date.now();
  for (const [k, exp] of dedup) if (exp <= now) dedup.delete(k);
  if (dedup.has(key)) return true;
  dedup.set(key, now + ttl);
  return false;
}

function cleanupExpired() {
  const ttl = services.config?.verify?.ttlMs || 300000;
  const now = Date.now();
  for (const [k, s] of verifySessions) if (now - s.createdAt > ttl) {
    services.db?.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason='Identity payment window expired; reconcile late receipts before rearming' WHERE id=? AND state='ARMED'").run(s.saleId);
    services.events?.emit('operator:alert', { component: 'intake', orderId: s.saleId, reason: 'Identity payment expired; reconcile any late receipt' });
    releaseSession(s);
    verifySessions.delete(k);
  }
  for (const [k, s] of paySessions) {
    if (now - s.createdAt > ttl) {
      services.db?.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason='Intake window expired; reconcile any late receipt before rearming' WHERE id=? AND state='ARMED'").run(s.saleId);
      services.events?.emit('operator:alert', { component: 'intake', orderId: s.saleId, reason: 'Intake window expired; check for late payment before rearming' });
                                                
      releaseSession(s);
      paySessions.delete(k);
    }
  }
}
function onAccountDisconnected(accountId) {
  for (const sessions of [verifySessions,paySessions]) for (const [key,session] of sessions) {
    if (session.accountId !== accountId) continue;
    services.db.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason='Minecraft disconnected during the payment window; reconcile any missed receipt' WHERE id=? AND state='ARMED'").run(session.saleId);
    sessions.delete(key);
    releaseSession(session);
    services.events?.emit('operator:alert',{component:'intake',saleId:session.saleId,reason:'Minecraft disconnected during intake; check for missed or late receipts before accepting more money'});
    session.interaction?.editReply({content:'The intake account disconnected. Do not send money or retry the sale. The owner must check for any payment already sent.'}).catch(()=>{});
  }
}
setInterval(cleanupExpired, 60_000).unref?.();

async function startVerify(discordId, ign, interaction) {
  const ticket = admission.acquire(discordId);
  let lease;
  try {
  await services.rollout.authorize('intake');
  const roles = await services.settings.get('treasury.accountRoles');
  const accountId = Object.keys(roles).find(id => roles[id].role === 'intake');
  const pack = await services.settings.get('delivery.patternPack');
  if (!accountId) throw new Error('Configure Buyer1 in AutoSell Pairs before linking sellers');
  if (!(pack.balanceCalibrated || pack.calibrated) || !paymentPatterns.canMatch(pack)) throw new Error('Incoming payment detection is unavailable for this server. Do not send coins; the owner should check the activity feed.');
  await require('../payments/automatic-intake').configure(services.settings);
  const policy = require('../payments/payout-policy').validate(await services.settings.get('payout.policy'));
  if (!policy.enabled || !require('../payments/payout-policy').recipientAllowed(policy, discordId, services.store.getSeller(discordId)?.ltcAddress, services)) throw Error('Seller payouts are disabled or your saved Litecoin address is not permitted');
  const min = services.config?.verify?.min || 1;
  const max = services.config?.verify?.max || 100;
  const amount = crypto.randomInt(min, max + 1);
  const saleId = 'link:' + crypto.randomUUID();
  const ttl = services.config?.verify?.ttlMs || 300000;
  lease = await services.sessions.acquire(accountId, saleId, {ttlMs:ttl + 60000});
  try {
    await lease.ready();
    await paymentVerifier.arm(lease.getBot(), { saleId, username: ign, amount, accountId, expiresMs:Date.now()+ttl, context:{kind:'identity',discordId} });
    verifySessions.set(ign.toLowerCase(), { discordId, ign, amount, interaction, accountId, saleId, lease, admission:ticket, rawBot:lease.getBot(), createdAt: Date.now() });
    return { amount, intakeIgn: lease.getBot().username };
  } catch (error) { lease.release(); throw error; }
  } catch (error) { ticket.release(); throw error; }
}

function hasVerifyPending(ign) {
  return verifySessions.has(String(ign || '').toLowerCase());
}

async function armMoneySell(discordId, ign, requested, interaction, selectedAccount) {
  let ticket;
  try {
    if (services.sellManager?.queue?.length) throw Error('Spawner customers are queued. Do not send money; try again after their sales finish.');
    ticket = admission.acquire(discordId);
  } catch (error) { return {ready:false,error:error.message}; }
  let lease;
  try {
  const saleId = crypto.randomUUID();
  const roles = await services.settings.get('treasury.accountRoles');
  const accountId = selectedAccount || Object.keys(roles).find(id => roles[id].role === 'intake');
  if (!accountId || roles[accountId]?.role !== 'intake') throw Error('Intake account role is not configured');
  if (!await require('../treasury/trading-controls').globallyEnabled()) throw Error('Global Autosell is off. Ask the owner to enable it in Controls & Console before sending coins.');
    await services.rollout.authorize('intake');
    const pack = await services.settings.get('delivery.patternPack');
    if (!Number.isSafeInteger(requested) || requested <= 0) throw Error('Enter a positive, exact whole-coin amount');
    if (!(pack.balanceCalibrated || pack.calibrated) || !paymentPatterns.canMatch(pack)) throw new Error('Incoming payment detection is unavailable for this server. The owner should check the activity feed.');
    const ratePerMillion = services.store.getRate();
    const payoutUsd = +((requested / 1000000) * ratePerMillion).toFixed(6);
    const quote = await require('../payments/payout-policy').preflight(services, discordId, payoutUsd);
    const forwarding = await require('../treasury/trading-controls').forwarding(accountId);
    if (forwarding.enabled && (!forwarding.destination || !roles[forwarding.destination])) throw new Error('Intake holder destination is missing');
    const ttl = services.config?.verify?.ttlMs || 300000;
    const session = { discordId, ign, requested, payoutUsd, payoutAddress:quote.address, interaction, state: 'ARMED', saleId, accountId, admission:ticket, createdAt: Date.now() };
    lease = await (services.sessions || sessionManager).acquire(accountId, 'sale:' + saleId, {ttlMs:ttl+60000});
    await lease.ready();
    await paymentVerifier.arm(lease.getBot(), { saleId, username: ign, amount: requested, accountId, expiresMs:Date.now()+ttl, context:{kind:'money',discordId,payoutAddress:quote.address,fiatMicros:String(Math.round(payoutUsd*1e6)),ratePerMillion} });
    session.lease = lease;
    session.rawBot = lease.getBot();
    session.createdAt = Date.now();
    paySessions.set(ign.toLowerCase(), session);
    return { ready: true, accountId, saleId, intakeIgn: lease.getBot().username };
  } catch (error) {
    lease?.release();
    ticket.release();
    return { ready: false, error: error.message };
  }
}

async function onVerifyPayment({ username, rawLine, packet }, receivingBot) {
  const { store, logger } = services;
  const key = String(username || '').toLowerCase();
  const session = verifySessions.get(key);
  if (!session || receivingBot?.accountId !== session.accountId) return;
  const receipt = paymentPatterns.matchCaptured(rawLine, packet);
  if (!receipt || receipt.username.toLowerCase() !== session.ign.toLowerCase()) return;
  if (Number(receipt.amountText) !== session.amount) {
    verifySessions.delete(key);
    return holdMismatchedReceipt(session,receipt,receivingBot,session.amount);
  }
  if (isDuplicate(`verify:${key}`)) return;

  verifySessions.delete(key);
  try {
  const result = await paymentVerifier.verifyPayment(receivingBot, { saleId: session.saleId, username, rawLine, packet });
  if (!result.confirmed) return;
  services.ledger.append({ idempotencyKey: session.saleId, entryType: 'credit', currency: 'donut', amount: session.amount,
    referenceType: 'identity-check', referenceId: session.saleId, accountId: session.accountId });
  store.setVerified(session.discordId, session.ign);
  services.db.raw().prepare("UPDATE intake_sales SET state='COMPLETED' WHERE id=? AND state='RECEIVED'").run(session.saleId);
  await logger.success('Account linked', `<@${session.discordId}> linked to \`${session.ign}\`.`, undefined, 'verify');

  const verifiedEmbed = orangeEmbed(
    '✅ Account Linked',
    `Your account **${session.ign}** is now linked and verified — you won't need to do this again.\n\nClick **Sell Money** or **Sell Skellys** to continue.`
  );

  await dmUser(session.discordId, { embeds: [verifiedEmbed] });
  if (session.interaction) {
    try {
      await session.interaction.editReply({ embeds: [verifiedEmbed] });
    } catch {}
  }
  } finally { releaseSession(session); }
}

const paymentQueue = [];
let paymentBusy = false;

async function holdMismatchedReceipt(session, receipt, receivingBot, expected) {
  const reason = `Server receipt amount ${receipt.amountText} differs from the armed amount ${expected}. Review any server tax, partial payment or extra transfer before paying; no automatic payout was sent.`;
  services.db.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason=?,capture=? WHERE id=? AND state='ARMED'").run(reason,JSON.stringify(receipt),session.saleId);
  releaseSession(session);
  services.events?.emit('operator:alert',{component:'intake',saleId:session.saleId,reason});
  try { await session.interaction?.editReply({content:'A server payment receipt was detected, but its amount differs from this sale. Do not send more coins. The owner must review it before an LTC payout.'}); } catch {}
}

function drainPayments() {
  if (paymentBusy) return;
  paymentBusy = true;
  (async () => {
    while (paymentQueue.length) {
      const job = paymentQueue.shift();
      job.session.lease?.extend?.(60000);
      const keepAlive = setInterval(() => job.session.lease?.extend?.(60000), 30000);
      keepAlive.unref?.();
      try {
        await processMoneyPayment(job);
      } catch (err) {
        services.db?.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason=? WHERE id=? AND state!='COMPLETED'").run('Processing interrupted: ' + err.message, job.session.saleId);
        services.events?.emit('operator:alert', { component: 'intake', orderId: job.session.saleId, reason: 'Processing interrupted: ' + err.message });
      } finally { clearInterval(keepAlive); releaseSession(job.session); }
    }
    paymentBusy = false;
  })();
}

async function onBuyPayment(payment, receivingBot) {
  const { username, amountText, rawLine, packet } = payment;
  receivingBot = receivingBot || services.mcBot;
  const key = String(username || '').toLowerCase();
  const session = paySessions.get(key);
  if (!session || session.state !== 'ARMED' || receivingBot.accountId !== session.accountId) {
    services.events?.emit('operator:alert', { component: 'intake', reason: 'Receipt without matching armed account/sale; no credit or payout' });
    return;
  }
  const matched = paymentPatterns.matchCaptured(rawLine, packet);
  if (!matched || matched.username.toLowerCase() !== session.ign.toLowerCase()) return;
  if (matched.amountText !== String(session.requested)) {
    paySessions.delete(key);
    return holdMismatchedReceipt(session,matched,receivingBot,session.requested);
  }
  session.state = 'PAYMENT_SEEN';
  paySessions.delete(key);
  paymentQueue.push({ session, donut: Number(matched.amountText), receivingBot, rawLine, packet, idempotencyKey: 'sale:credit:' + session.saleId });
  drainPayments();
}

async function processMoneyPayment({ session, donut, receivingBot, rawLine, packet, idempotencyKey }) {
  const { store, logger, ledger } = services;
  
                     
  session.state = 'VERIFYING';
  const usd = session.payoutUsd;
  
                                 
  const verification = await paymentVerifier.verifyPayment(receivingBot, { username: session.ign, amountText: donut, rawLine, packet, saleId: session.saleId });
  if (!verification.confirmed) {
     logger.warn('Payment not confirmed', `Payment from ${session.ign} failed balance verification: ${verification.error}`);
     return;
  }

                    
  session.state = 'CREDITED';
  ledger.append({
    idempotencyKey: idempotencyKey || `sale:credit:${session.saleId}`,
    entryType: 'credit',
    currency: 'donut',
    amount: donut,
    referenceType: 'sale',
    referenceId: session.saleId,
    accountId: session.accountId,
    metadata: { discordId: session.discordId, ign: session.ign }
  });

  store.recordSale(session.discordId, { kind: 'money', donut, usd });
  require('../discord/roles').grantSoldRole(session.discordId).catch(() => {});
  await logger.success('💰 Money sell received', `<@${session.discordId}> sold **${formatDonut(donut)}** → **${formatUsd(usd)}**.`, undefined, 'sales');

                                                                                                    
  let transferResult = null;
  const roles = await services.settings.get('treasury.accountRoles');
  const holderId = roles[session.accountId]?.holderAccount;
  if (holderId && holderId !== session.accountId && roles[holderId]?.role === 'holder' &&
      (await require('../treasury/trading-controls').forwarding(session.accountId)).enabled) {
    try { transferResult = await services.treasury.acceptSale(session.accountId, donut, session.saleId); }
    catch (error) { services.events?.emit('operator:alert', { component: 'transfer', saleId: session.saleId, reason: 'Intake verified, but optional forwarding needs review: ' + error.message }); }
  }


                                                              
  const res = await payoutService.payInstant(session.discordId, { ltcAddress: session.payoutAddress, usd, kind: 'money', donut, saleId: session.saleId });
  if (res.ok) {
    services.db.raw().prepare('INSERT OR IGNORE INTO inventory_cost_lots VALUES(?,?,?,?,?,?,?,?)')
      .run(session.saleId, transferResult?.ok ? holderId : session.accountId, String(donut), res.fiatMicros, res.feeFiatMicros, 'USD', res.quotedMs, 'Captured seller payout ' + res.txid);
    services.events?.emit('treasury:ready', { accountId: transferResult?.ok ? holderId : session.accountId, saleId: session.saleId });
  }

  let embed;
  if (res.ok) {
    embed = orangeEmbed('✅ Paid in Litecoin', `**Sent ${res.ltc} LTC** (${formatUsd(usd)}) to your address.` + (res.txid ? `\n🔗 https://litecoinspace.org/tx/${res.txid}` : ''));
    session.state = 'DONE';
  } else {
    session.state = 'PARKED';
    await logger.error('Money payout needs review', `Sale ${session.saleId}: ${res.reason}. Do not retry until the wallet outcome is reconciled.`);
    embed = orangeEmbed('Payout needs review', 'The owner needs to check this payout before another payment is attempted.');
  }

  await dmUser(session.discordId, { embeds: [embed] });
  if (session.interaction) {
    try { await session.interaction.editReply({ embeds: [embed] }); } catch {}
  }
  if (res.ok) require('../discord/identity').promptAfterSale({
    discordId:session.discordId,what:'money',interaction:session.interaction,
    feed:{ltc:res.ltc,usd,txid:res.txid,pending:res.pending},
  }).catch(()=>{});

                                                        
}

async function onPayment(payment, receivingBot) {
  if (services.store.verifyEnabled() && hasVerifyPending(payment && payment.username)) {
    return onVerifyPayment(payment, receivingBot);
  }
  return onBuyPayment(payment, receivingBot);
}

function orangeEmbed(title, description) {
  const { EmbedBuilder } = require('discord.js');
  return new EmbedBuilder().setColor(0xdc143c).setTitle(title).setDescription(description).setTimestamp();
}

module.exports = { startVerify, hasVerifyPending, armMoneySell, onVerifyPayment, onBuyPayment, onPayment, onAccountDisconnected, orangeEmbed };
