'use strict';

   
                          
  
                                                                  
                                                                                
                        
                                                                                  
                                                                                 
                                               
  
                                                                                
                                                                                 
                                                                               
                                                                                
   

const services = require('../services');

                                                                           
                                                                            
                                                                             
const NON_PAYMENT_NOISE = /teleport|\btpa\b|\btpahere\b|\/tpaccept|\/tpahere|\/tpadeny|request to teleport|wants to teleport/i;

                                                                                
                                                             
const recentUnparsed = new Map();                     

                                                                              
function notifyUnparsed(text,account) {
  try {
    const key = account+':'+String(text).slice(0, 200);
    const now = Date.now();
    for (const [k, exp] of recentUnparsed) if (exp < now) recentUnparsed.delete(k);
    if (recentUnparsed.has(key)) return;                            
    recentUnparsed.set(key, now + 10 * 60 * 1000);                          
    services.events?.emit('operator:alert',{component:'intake-format',reason:`An incoming payment-like server message on ${account} did not match the configured receipt format. No sale or payout was recorded by this listener. Observed line: ${String(text).slice(0,400)}`});
  } catch {
                
  }
}

                                                                               

const TPA_ACCEPTED = [
  /accepted (your )?(teleport|tpa)( request)?/i,
  /teleporting (you )?to/i,
  /is teleporting to you/i,
];
const TPA_DENIED = [
  /denied (your )?(teleport|tpa)( request)?/i,
  /(teleport|tpa)( request)? (was )?(denied|cancelled|declined)/i,
];
                                                                     
const TPA_FAILED = [
  /(couldn't|could not|cannot) find( the)? player/i,
  /player .* (is )?(not online|offline)/i,
];

                                                                         
                                                                               
                                                                                    
const PAY_SUCCESS = [
  /you (have )?(sent|paid)\s+\$[\d,.]+[kmbt]?/i,
  /\$[\d,.]+[kmbt]? (has been )?(sent|paid) to/i,
];
const PAY_FAILED = [
  /(not enough|insufficient|don'?t have enough|cannot afford|can'?t afford)/i,
  /(couldn't|could not|cannot) find( the)? player/i,
  /invalid (amount|player)/i,
];

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

   
                                             
                                        
                                                               
   
function attach(bot, mcBot) {
  const { logger, config } = services;
                                                                                
                                                                        
  const ownEmail = (services.store && typeof services.store.getBuyerEmail === 'function' ? services.store.getBuyerEmail(0) : '') || config.mc.email || '';
  const ownName = ((bot && bot.username) || ownEmail.split('@')[0] || '').toLowerCase();

  const paymentPatterns = require('../payments/payment-patterns');
  const OUTGOING_PAYMENT = /^you\s+(?:have\s+)?(?:paid|sent|transferred|gave)\b/i;

                                                             
  bot.on('messagestr', (message, position, original, sender) => {
    const text = String(message);
    const lower = text.toLowerCase();

                                                             
                                                                             
                                                                      
    if (config.mc.debugChat) {
      logger.info('🐛 chat', '`' + text.slice(0, 300) + '`', undefined, 'system');
    }

                                                                              
    const incoming = paymentPatterns.match(text, { position, sender, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() });
    if (incoming) {
      incoming.rawLine = text;
      logger.minecraft('Incoming payment', `> ${text}`, undefined, 'sales');
      mcBot.emit('chat:payment', incoming);
      return;
    }
                                                                               
                                                                           
    
                                                     
    const looksLikePayment = /\b(?:paid|sent|transferred|gave)\b.*\byou\b|\byou\b.*\b(?:received|got|were paid)\b|\breceived\b.*\bfrom\b/i;
    const positions=services.settings?.getSync?.('delivery.patternPack')?.systemPositions||[];
    if (!sender && positions.includes(position) && !/^\s*<|\bwhispers?\b/i.test(text) && !NON_PAYMENT_NOISE.test(text) && !OUTGOING_PAYMENT.test(text) && looksLikePayment.test(text)) {
      notifyUnparsed(text,mcBot.accountId||bot.username||'Minecraft account');
    }

                           
    if (matchesAny(text, TPA_ACCEPTED)) {
      logger.minecraft('TPA accepted', `> ${text}`);
      mcBot.emit('chat:tpa-accepted', text);
      return;
    }
    if (matchesAny(text, TPA_DENIED)) {
      logger.minecraft('TPA denied', `> ${text}`);
      mcBot.emit('chat:tpa-denied', text);
      return;
    }
    if (matchesAny(text, TPA_FAILED)) {
      logger.warn('TPA failed', `> ${text}`);
      mcBot.emit('chat:tpa-failed', text);
      return;
    }

                                           
    if (matchesAny(text, PAY_FAILED)) {
      logger.warn('Payment failed', `> ${text}`);
      mcBot.emit('chat:payment-observation', { text, kind: 'possible-failure' });
      return;
    }
    if (matchesAny(text, PAY_SUCCESS)) {
      logger.minecraft('Payment-like message observed', `> ${text}`);
      mcBot.emit('chat:payment-observation', { text, kind: 'possible-success' });
      return;
    }

                             
                                                                                 
    if (
      ownName &&
      lower.includes(ownName) &&
      /(was slain|was shot|drowned|blew up|fell|burned|died|was killed|suffocat|starved|withered)/i.test(text)
    ) {
      mcBot.noteDeathMessage(text);
      logger.minecraft('Death message detected', `> ${text}`);
      return;
    }

                             
    if (ownName && lower.includes(ownName)) {
      logger.info('Mentioned in chat', `> ${text}`);
      return;
    }

                                                         
    if (/(you (have )?been (kicked|banned)|connection throttled)/i.test(text)) {
      logger.warn('Server notice', `> ${text}`);
    }
  });
}

module.exports = { attach, TPA_ACCEPTED, TPA_DENIED, TPA_FAILED, PAY_SUCCESS, PAY_FAILED };
