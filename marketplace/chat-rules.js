'use strict';
const normalize = text => String(text).toLowerCase().replace(/[’]/g, "'").replace(/\b(pls|plz)\b/g, 'please').replace(/\bcancle\b/g, 'cancel').replace(/\brefnd\b/g, 'refund').replace(/\brecieve\b/g, 'receive').replace(/\s+/g, ' ').trim();
const rules = {
  keep: ["\\b(?:don'?t|do not|never|no|not|can'?t|stop)\\s+(?:cancel|refund)\\b", '\\b(?:keep|continue|proceed with|still want)\\s+(?:(?:the|my|with)\\s+)?(?:order|delivery)\\b', '\\bwhy (?:did you )?(?:cancel|refund)\\b'],
  automation: ['\\b(?:are you|r u|is this|am i (?:talking|speaking) to)\\b.*\\b(?:bot|human|person|ai|automated)\\b', '\\b(?:bot or human|human or bot|real person)\\b'],
  escalation: ['\\b(?:scam|scammer|dispute|report|police|legal|lawyer|threat|admin|operator|human|staff)\\b', '\\b(?:speak|talk) to someone\\b'],
  missing: ["\\b(?:didn'?t|did not|haven'?t|have not|never|not)\\s+(?:get|got|receive|received|arrive|arrived)\\b", '\\b(?:coins missing|money missing|nothing received|nothing arrived|where (?:is|are) my)\\b'],
  cancel: ['\\b(?:please cancel|cancel please|want to cancel|need to cancel|cancel (?:my |the |this )?order|refund (?:me|please)|please refund|want a refund|request (?:a )?refund|stop (?:my )?order)\\b', '^(?:cancel|refund|cancellation)$'],
  ambiguous_cancel: ['\\b(?:cancel|cancellation|refund|nevermind|nvm|mistake|stop)\\b'],
  ign: ['\\b(?:ign|username|player name|my name|wrong name|change name)\\b'],
  ready: ['\\b(?:ready|online|in game|ingame|logged in|i am here|im here|i.m here)\\b'],
  status: ['\\b(?:eta|when|waiting|wait|delay|delayed|paid|status|again|how long|progress|arrive|arrival)\\b'],
  thanks: ['\\b(?:thanks|thank you|ty|thx|cheers|appreciate)\\b'],
  greeting: ['^(?:hi|hello|hey|yo|hiya|good morning|good evening|greetings)\\b'],
};
function classify(text, configuredRules = rules, options = {}) {
  const normalized = normalize(text);
  let intent = 'off_topic';
  for (const [name, patterns] of Object.entries(configuredRules)) {
    if (patterns.some(pattern => new RegExp(pattern, 'i').test(normalized))) { intent = name; break; }
  }
  const parsed=require('./ign-rules').parseIgn(String(text),options);
  const correction=/^(?:wait[,!]?\s+)?(?:no[,!]?\s+(?:use\s+)?|(?:actually|instead|use)\s+|(?:wrong (?:one|name)|change (?:it|my (?:ign|username)) to)[,:]?\s+)(.+)$/i.exec(String(text).trim());
  const corrected=correction&&require('./ign-rules').parseIgn(correction[1],options);
  const correctionAllowed=!['keep','cancel','escalation','missing','ambiguous_cancel'].includes(intent);
  if(options.expectIgn&&correctionAllowed&&corrected&&!/^(thanks|thankyou|please|cancel|refund|yes|no|wait)$/i.test(corrected.ign))return {intent:'recipient_correction',entities:{ign:corrected.ign,submittedIgn:corrected.submitted,amount:null}};
  if(options.expectIgn&&(/^(?:wait|hold on|hold up|stop|one sec)\b|^(?:wrong one|wrong name|not that one)[.!?]*$/i.test(String(text).trim())||correctionAllowed&&correction))return {intent:'recipient_pause',entities:{ign:null,amount:null}};
  const labeled=/^(?:my\s+)?(?:ign|username|player name|name)\b/i.test(String(text).trim());
  if(parsed&&(intent==='ign'||intent==='off_topic'&&(labeled||options.expectIgn===true)))intent='ign';
  if(options.expectIgn&&/^(?:y|yes|yea|yeah|yep|yup|n|no)$/i.test(String(text).trim()))intent=/^(?:y|yes|yea|yeah|yep|yup)$/i.test(String(text).trim())?'confirm_yes':'confirm_no';
  if(options.expectIgn&&!parsed&&(intent==='ign'||/^(?:\.?[A-Za-z0-9_-]{3,16}[?]+|\.?[A-Za-z0-9_-]{3,16}\s+(?:or|and|\/)\s+\.?[A-Za-z0-9_-]{3,16})$/i.test(String(text).trim())))intent='ambiguous_ign';
  if(/^(?:yo+|ok(?:ay)?|sure|please|perfect|fine|great|nice|done)$/i.test(String(text).trim())&&intent==='ign')intent='off_topic';
  const amount = /\b(\d+(?:[.,]\d+)*(?:[kmb])?)\b/i.exec(normalized);
  return { intent, entities: { ign: intent==='ign'?parsed?.ign||null:null, submittedIgn:intent==='ign'?parsed?.submitted||null:null, amount: amount?.[1] || null } };
}
const templates = {
  ign_accepted: ['Thanks, I have {ign} for this order.', 'Got it — the payment name for this order is {ign}.', 'Thanks! I’ve recorded {ign} as your Minecraft name.', 'Your order is set to {ign}. Thanks for confirming the name.'],
  waiting_ign: ['Please send only your Minecraft scoreboard IGN. Put names with underscores in quotes, e.g. "_Steve". Include the starting dot for Bedrock. I’ll ask you to confirm with Y or N.', 'Reply with your Minecraft scoreboard name. Use quotes around underscores, e.g. "_MS_2", and keep the Bedrock dot. Then confirm with Y or N.', 'I have your order. Send only your scoreboard IGN, with quotes around names containing underscores. Include the dot for Bedrock; I’ll ask you to confirm with Y or N.', 'Please send your exact Minecraft scoreboard name. Quote names containing underscores, include the Bedrock dot, then confirm with Y or N.'],
  opening: [require('./order-chat-flow').DEFAULT_OPENING, 'Thanks for buying! Send only your Minecraft scoreboard IGN. Put names containing underscores in quotes, e.g. "_Steve". Bedrock: include the starting dot. I’ll ask you to confirm with Y or N before sending the coins. Type cancel to request cancellation.', 'Thanks for your order! Reply with just your Minecraft scoreboard name. Quote names with underscores: "_MS_2". Include the dot for Bedrock, e.g. .Steve. I’ll ask you to confirm with Y or N before payment. Type cancel to request cancellation.', 'Thank you for ordering! Send only your Minecraft scoreboard IGN. Use quotes if it contains underscores: "_Steve". Bedrock names need the starting dot. I’ll ask you to confirm with Y or N, then send the coins. Type cancel to request cancellation.'],
  queued: ['Thanks for waiting! Your order is next in line. Please double-check your Minecraft name.', 'Got your order — delivery is queued. Thanks for your patience!', 'Your order is in the queue. I’ll keep you updated here.', 'Your order is waiting for delivery. Thanks for bearing with us!'],
  joining: ['Connecting to DonutSMP to send your coins now.', 'Getting the delivery account into DonutSMP. Thanks for waiting!', 'Joining the server for your delivery. I’ll update you here.', 'The delivery account is connecting to DonutSMP now.'],
  delivering: ['Sending your coins now. Please keep the Minecraft name unchanged.', 'Your payment is underway. I’ll confirm the result here shortly.', 'The coins are being sent to your confirmed Minecraft name.', 'Delivery has started. I’ll share the payment result and proof once confirmed.'],
  delivered: ['All done! {amount} was sent to {ign}. Let me know if you need anything else.', 'Your coins have been sent: {amount} to {ign}. Thanks for buying!', 'Delivery complete — {amount} sent to {ign}. Thanks for your patience!', 'Sent {amount} to {ign}. Thanks for shopping with us!'],
  operator: ['Thanks for letting us know. This needs a closer look before we continue.', 'Your message is saved for the shop team to review. Thanks for your patience.', 'We need to check this before sending anything else. Your message is in the support queue.', 'I’ve saved the issue for review. I can’t confirm a refund until that check is complete.'],
  automation: ['I’m the shop’s assistant. I can help with this order or pass a question to the owner.', 'I handle order support for the shop. What do you need help with?', 'I’m here to help with your order. The shop owner can review anything that needs a closer look.', 'This is the shop’s support assistant. I can help with delivery questions or get the owner to review an issue.'],
  keep: ['Understood; I’m not treating that as a cancellation request. The order is awaiting processing or its recorded next step.', 'Got it. That message does not request cancellation; processing follows the recorded order state.', 'I’ve treated that as a request to keep the order. Its recorded processing status still applies.', 'Thanks for clarifying. I haven’t requested cancellation; check the order’s processing status for progress.'],
  ambiguous_cancel: ['Do you want to cancel this order? Please say “cancel my order” if so.', 'Please confirm whether you’re requesting cancellation of this order.', 'Are you asking to cancel, or asking about its status?', 'If you want cancellation, please confirm it explicitly for this order.'],
  cancelled: ['The marketplace accepted cancellation. Refund timing must be checked with Eldorado.', 'Cancellation was accepted by the marketplace. I can’t confirm a refund from this response.', 'This order’s cancellation is recorded. Please check Eldorado for the funds status.', 'The marketplace cancellation succeeded. Any funds-release question belongs with Eldorado support.'],
  ign: ['Please reply with only your Minecraft IGN.', 'Send the exact name on your Minecraft scoreboard.', 'Please send just your Minecraft name, including the starting dot for Bedrock.', 'Reply with your Minecraft IGN; put the whole name in quotes if it contains underscores.'],
  thanks: ['You’re welcome. Let me know if you need help with this order.', 'Thanks for the message. I’m here for order-status questions.', 'Happy to help with your order questions.', 'You’re welcome; any issue can be flagged here for review.'],
  off_topic: ['I can help with this order’s status, IGN or a support request.', 'For this chat I can help with delivery and order questions.', 'Please tell me what you need help with on this order.', 'I can check the order record or flag a delivery question for review.'],
};
module.exports = { rules, templates, classify, normalize };
