'use strict';

   
                                                                              
                                                                               
  
                                                               
                                                                                   
                                                                               
                                                                                
   

const NAME = '(\\.?[A-Za-z0-9_]{2,16})';
                                                                                         
const AMOUNT = '\\$?\\s*([\\d,.]+(?:[kmbtKMBT])?)';

                                                                              
                                                  
const PRE = '(?:[^A-Za-z0-9_.]{0,8}\\s*)?';
                                                                                
const SEP = '\\s*(?:»|>|→|->|:)?\\s*';

const PATTERNS = [
                                                                                
                                                                                 
  { re: new RegExp(`${PRE}${NAME}${SEP}(?:has\\s+)?(?:paid|sent|transferred|gave)\\s+you\\s+${AMOUNT}`, 'i'), name: 1, amount: 2 },
                                                                            
  { re: new RegExp(`${PRE}${NAME}${SEP}(?:has\\s+)?(?:paid|sent|transferred|gave)\\s+${AMOUNT}\\s+to\\s+you`, 'i'), name: 1, amount: 2 },
                                                       
  { re: new RegExp(`you\\s+(?:have\\s+)?(?:received|got|were\\s+paid|gained)\\s+${AMOUNT}\\s+from\\s+${PRE}${NAME}`, 'i'), name: 2, amount: 1 },
                                     
  { re: new RegExp(`you\\s+(?:were\\s+paid|got|have\\s+been\\s+paid)\\s+${AMOUNT}\\s+by\\s+${PRE}${NAME}`, 'i'), name: 2, amount: 1 },
                                  
  { re: new RegExp(`(?:received|got)\\s+${AMOUNT}\\s+from\\s+${PRE}${NAME}`, 'i'), name: 2, amount: 1 },
                                                        
  { re: new RegExp(`${AMOUNT}\\s+(?:has\\s+been\\s+)?(?:received|added|credited)\\s+from\\s+${PRE}${NAME}`, 'i'), name: 2, amount: 1 },
];

                                                                       
const LOOKS_LIKE_PAYMENT = /\b(?:paid|sent|transferred|gave)\b.*\byou\b|\byou\b.*\b(?:received|got|were paid)\b|\breceived\b.*\bfrom\b/i;

                                                                                            
                                                                                   
const OUTGOING_PAYMENT = /^you\s+(?:have\s+)?(?:paid|sent|transferred|gave)\b/i;

function strip(text) {
  return String(text || '')
    .replace(/§./g, '')
    .replace(/§/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

                                                           
function parsePayment(text) {
  const clean = strip(text);
  if (!clean) return null;
  for (const p of PATTERNS) {
    const m = clean.match(p.re);
    if (m) return { username: m[p.name], amountText: m[p.amount] || '' };
  }
  return null;
}

module.exports = { parsePayment, strip, LOOKS_LIKE_PAYMENT, OUTGOING_PAYMENT };
