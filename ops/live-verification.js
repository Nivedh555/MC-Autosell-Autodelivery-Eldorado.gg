'use strict';
const {missing} = require('../marketplace/browser/profile');
const {validIgn} = require('../minecraft/verified-payments');
const {deliveryAccount} = require('../treasury/trading-controls');
const positive = value => /^\d+$/.test(String(value)) && BigInt(value) > 0n;
const anchored = value => typeof value === 'string' && value.startsWith('^') && value.endsWith('$');

                                                                            
                                                                               
async function inspectLiveSetup(services, {now = Date.now(), runtimeObserved = true} = {}) {
  const get = async (id, fallback) => { try { return (await services.settings.get(id)) ?? fallback; } catch { return fallback; } };
  const [connection,profile,policy,pack,listing,chat,intakePaused,autoDeliver] = await Promise.all([
    get('eldorado.connection','browser'),get('eldorado.browser.profile',{}),get('delivery.policy',{}),get('delivery.patternPack',{}),
    get('listing.policy',{}),get('eldorado.chat.local',{}),get('general.bot.paused',false),get('eldorado.order.auto_deliver',true),
  ]);
  const db = services.db.raw(), checks = [];
  const add = (id,label,passed,reason,required=true) => checks.push({id,label,passed:Boolean(passed),reason:passed?null:reason,required});
  const browser = runtimeObserved ? services.browserBridge?.status() : null;
  const documentedHybrid=['hybrid','api'].includes(connection)&&services.marketplace?.documentedSellerApi===true;
  const connectionState = require('../marketplace/connection-state').connectionState(connection, services);
  const capturedWorkflow=(connection==='browser'||documentedHybrid)&&policy.commandCapacityObserved===true&&pack.calibrated&&pack.paymentSource&&listing.observedSellerHref;
  if (connection === 'browser') {
    add('browser','Seller Chrome connection',browser?.connected,'Open the selected seller Chrome profile and approve its debugging prompt. An old captured page is not a live connection.');
    add('offer','Selected existing offer',Boolean(listing.offerId && listing.observedSellerHref),'Find and select the existing offer from the correct seller account.');
    for (const operation of ['listOrders','getOrder','markDelivered']) {
      const gaps = capturedWorkflow ? [] : missing(profile,operation);
      add(operation,({listOrders:'Funded order reader',getOrder:'Order, offer and recipient binding',markDelivered:'Delivered-action receipt'})[operation],!gaps.length,gaps.join('; '));
    }
  } else if(['hybrid','api'].includes(connection)){
    add('worker','Browser + API worker loaded',!connectionState.restartRequired,connectionState.reason);
    add('browser','Seller Chrome connection for chat and proof',browser?.connected,'Open the Chrome profile signed into the same seller as the API credentials.');
    const bound=Boolean((listing.automatic?.enabled&&listing.apiBinding?.source==='direct'||listing.offerId&&listing.apiBinding?.templateId)&&listing.apiBinding?.unitCoins&&listing.apiBinding?.sellerHref===listing.observedSellerHref);
    add('offer','API and browser seller link',bound,'Connect the matching seller Chrome profile and save automatic-offer settings. The first offer is created when an enabled pair reaches its threshold; no manually created offer is needed.');
    for(const operation of ['listOrders','getOrder','markDelivered'])add(operation,({listOrders:'Seller API funded order reader',getOrder:'API order and browser recipient binding',markDelivered:'Seller API delivered acknowledgement'})[operation],documentedHybrid&&!connectionState.restartRequired&&services.marketplace.capabilities?.[operation]===true,connectionState.reason||'The Seller API operation is unavailable. Update to the latest client ZIP and restart Autosell.');
  } else {
    const contract = await get('eldorado.contract',{});
    for (const operation of ['listOrders','getOrder','markDelivered']) {
      const gaps = require('../marketplace/contract/runtime').missing(contract,operation);
      add(operation,operation,!gaps.length,gaps.join('; '));
    }
  }
  add('balance','Sender balance reader',Boolean((pack.balanceCalibrated||pack.calibrated)&&pack.source&&anchored(pack.balance)&&pack.systemPositions?.length),'DonutSMP uses its built-in reply profile. Start the account to read its balance; manual capture is only needed for an unrecognized server format.');
  add('recipientBalance','Recipient /bal IGN evidence',Boolean(pack.recipientBalanceCalibrated&&pack.recipientBalanceSource&&anchored(pack.recipientBalance)),'DonutSMP recipient replies are configured automatically. Use manual capture only if the server changes its reply.');
  add('pay','Payment confirmation reader',Boolean(pack.calibrated&&pack.source&&anchored(pack.success)),'Load the DonutSMP reply profile or configure a custom server format. Actual deliveries still require a matching server confirmation and precise sender debit.');
  add('policy','Exact order amount and captured command size',Boolean((capturedWorkflow||policy.calibrated)&&policy.source&&positive(policy.minOrder)&&positive(policy.maxOrder)&&positive(policy.maxPay)&&positive(policy.unitSize)&&Number.isSafeInteger(policy.cooldownMs)&&policy.cooldownMs>=0&&policy.orderAmountMode==='command'),'Use captured command size and exact amount units. Nominal command amounts must equal the order amount.');
  const pairs = services.pairManager?.getPairs() || [];
  const pairChecks = pairs.map(pair => {
    const account = deliveryAccount(pair), snapshot = db.prepare('SELECT balance,observed_ms,reason FROM balance_observations WHERE account_id=?').get(account);
    const ageMs = snapshot ? Math.max(0,now-snapshot.observed_ms) : null;
    const fresh = ageMs !== null && ageMs <= 30000 && !snapshot.reason;
    const available = snapshot && /^\d+$/.test(snapshot.balance) ? BigInt(snapshot.balance) : null;
    const locks = db.prepare('SELECT order_id,reserved_amount FROM delivery_account_locks WHERE account_id=?').all(account);
    const reserved = locks.reduce((sum,row)=>sum+BigInt(row.reserved_amount),0n) + BigInt(listing.reserve || 0);
    return {pair:pair.pairIndex,account,enabled:!pair.disabled,ign:pair.sellerIgn||pair.buyerIgn||null,balance:snapshot?.balance||null,ageMs,fresh,threshold:String(pair.threshold),available:available===null?null:(available>reserved?available-reserved:0n).toString(),thresholdMet:fresh&&available!==null&&available-reserved>=BigInt(pair.threshold),locks:locks.map(row=>row.order_id),connected:runtimeObserved?Boolean(services.sessions?.clients?.get(account)?.isOnline?.()):null};
  });
  add('pair','Enabled delivery account',pairChecks.some(pair=>pair.enabled&&validIgn(pair.ign)), 'Configure and enable a pair with the actual sending account IGN.');
  add('global','Global Autosell',runtimeObserved&&!intakePaused&&services.store?.autosellPaused?.()===false,runtimeObserved?'Turn on Global Autosell in Controls & Console.':'The saved-config report does not observe the runtime Global Autosell switch.');
  add('deliveryEnabled','Automatic order processing',autoDeliver===true,'Enable automatic order processing in Eldorado Setup. Production actions are real; no separate stage or kill switch is required.');
  const holds = db.prepare('SELECT order_id,reason FROM owner_delivery_holds WHERE released_ms IS NULL').all();
  const unresolved = db.prepare("SELECT id,operation,resource_id,reason FROM browser_actions WHERE state IN ('INTENT','NEEDS_OPERATOR') AND operation!='uploadOwnerRecord'").all();
  add('browserActions','Browser action journal',unresolved.length===0,'Review the listed unresolved browser actions before repeating them.');
  const observedChatSends = db.prepare("SELECT count(*) n FROM browser_actions WHERE operation='sendMessageObserved' AND state='CONFIRMED'").get().n;
  const payments = db.prepare("SELECT count(*) n FROM delivery_chunks c JOIN delivery_orders o ON o.id=c.order_id WHERE o.mode='live' AND c.state='PAY_VERIFIED'").get().n;
  const uploads=db.prepare("SELECT count(*) n FROM browser_actions WHERE operation IN ('uploadOwnerRecord','uploadEvidenceObserved') AND state='CONFIRMED'").get().n;
  const acknowledgements=db.prepare("SELECT count(*) n FROM browser_actions WHERE operation='markDeliveredObserved' AND state='CONFIRMED'").get().n+db.prepare("SELECT count(*) n FROM seller_api_actions WHERE operation='markDelivered' AND state='CONFIRMED'").get().n;
  let openingValid = true;
  try { if(chat.openingMessage)require('../marketplace/ai-chat-agent').validateOpening(chat.openingMessage); } catch { openingValid=false; }
  add('chat','Local buyer chat enabled',chat.autoSend===true&&openingValid,'Enable local replies and use an honest first message. Chat sends do not authorize money movement.',false);
  return {capturedAt:new Date(now).toISOString(),scope:runtimeObserved?'Current configuration and local runtime; not a completed live trade':'Read-only saved configuration and journals; process/browser connectivity not observed',
    setupChecksPassed:checks.filter(check=>check.required).every(check=>check.passed),endToEndLiveProven:false,
    ltc:{scope:'Excluded from this verification by owner request; owner reports payouts working',independentlyTested:false},
    checks,pairs:pairChecks,ownerHolds:holds,unresolvedBrowserActions:unresolved,
    history:{confirmedOutgoingBubbles:observedChatSends,verifiedLivePaymentChunks:payments,confirmedEvidenceUploads:uploads,confirmedDeliveryAcknowledgements:acknowledgements,scope:'Historical journal records, not a fresh live test'},
    remainingLiveAcceptance:[...(!pack.paymentSource?['controlled nominal payment with captured matching confirmation and exact sender debit']:[]),...(!uploads?['actual evidence attachment upload and resulting receipt']:[]),...(!acknowledgements?['funded order processed automatically from detection through payment, evidence upload and delivered receipt']:[])],
    paymentSentByInspection:false,configurationChanged:false};
}
module.exports = {inspectLiveSetup};
