'use strict';
const {validIgn}=require('../minecraft/verified-payments');

                                                                         
                                                                         
function parseIgn(text,{dashToUnderscore=true,bedrockPrefix='.'}={}){
  if(typeof text!=='string'||text.length>100)return null;
  // A label may occur in a sentence, but the entire value after it must be
  // one exact name. Never truncate punctuation, a second name, or a long IGN.
  const labels=[...text.matchAll(/\b(?:ign|username|player name)\b/gi)];
  if(labels.length>1)return null;
  let raw=text.trim();
  if(labels.length===1)raw=text.slice(labels[0].index+labels[0][0].length).trim().replace(/^(?:is\s+|[:=]\s*)/i,'');
  else raw=raw.replace(/^(?:my\s+)?name(?:\s+is\s+|\s*[:=]\s*|\s+)(?=\S)/i,'');
  if(/^"[^"\r\n]+"$/.test(raw)||/^“[^“”\r\n]+”$/.test(raw))raw=raw.slice(1,-1);
  const match=/^(\.?[A-Za-z0-9_-]{3,16})$/.exec(raw);
  if(!match)return null;
  const submitted=match[1],ign=dashToUnderscore?submitted.replaceAll('-','_'):submitted;
  if(!validIgn(ign,bedrockPrefix))return null;
  return {ign,submitted,converted:ign!==submitted,bedrock:ign.startsWith('.'),source:'owner-configured dash-to-underscore chat rule'};
}
function recipientCandidates(messages,options={}){
  if(!Array.isArray(messages)||messages.length>500)throw Error('Bounded captured message list required');
  const {classify}=require('./chat-rules');
  const candidates=[];
  for(const message of messages){
    if(message.peer!==true||message.kind==='attachment')continue;
    const result=classify(message.text,undefined,{expectIgn:true,...options});
    if(result.intent!=='ign'||!result.entities.ign)continue;
    candidates.push({messageId:message.id,submitted:result.entities.submittedIgn,ign:result.entities.ign,displayedTime:message.displayedTime,authorVerified:false,moneyActionsAllowed:false});
  }
  const names=[...new Set(candidates.map(candidate=>candidate.ign.toLowerCase()))];
  return {candidates,latest:candidates.at(-1)||null,requiresClarification:names.length>1,moneyActionsAllowed:false};
}
module.exports={parseIgn,recipientCandidates};
