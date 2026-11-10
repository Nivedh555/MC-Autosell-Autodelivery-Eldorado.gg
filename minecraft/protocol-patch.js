'use strict';

   
                            
  
                                                                                
                                                                           
                                                                             
                                                                              
                                                                          
                                                                          
  
                                                                              
                                                                           
                                                                           
  
                                                                               
                                   
   

let applied = false;
let skippedCount = 0;
let dumped = false;

                                                                                 
                                                                                 
function maybeDump(chunk, err) {
  if (dumped || !chunk || !chunk.length) return;
  if (chunk[0] !== 0x13) return;                
  try {
    const fs = require('fs');
    const path = require('path');
    const out = path.join(process.cwd(), 'data', 'bad-packet.hex');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `# ${err.message}\n${chunk.toString('hex')}\n`);
    dumped = true;
                                          
    console.warn(`[mc-protocol] dumped failing window_items packet to ${out}`);
  } catch {
                     
  }
}

function apply() {
  if (applied) return;
  let FullPacketParser;
  try {
    ({ FullPacketParser } = require('protodef'));
  } catch {
    return;                                                   
  }
  if (!FullPacketParser || !FullPacketParser.prototype) return;

  const proto = FullPacketParser.prototype;
  if (proto.__resilientPatched) {
    applied = true;
    return;
  }

  proto._transform = function _transform(chunk, enc, cb) {
    let packet;
    try {
      packet = this.parsePacketBuffer(chunk);
    } catch (e) {
                                                                                  
      if (!e.partialReadError) {
        skippedCount += 1;
        if (skippedCount <= 40 || skippedCount % 100 === 0) {
          const idByte = chunk && chunk.length ? '0x' + chunk[0].toString(16) : '?';
          const field = e.field || '?';
                                                
          console.warn(`[mc-protocol] skipped packet (#${skippedCount}) id=${idByte} len=${chunk ? chunk.length : 0} field=${field}: ${e.message}`);
        }
                                                                                  
                                                                        
        maybeDump(chunk, e);
      }
      return cb();                                               
    }
    this.push(packet);
    cb();
  };

  proto.__resilientPatched = true;
  applied = true;
}

module.exports = { apply, skipped: () => skippedCount };
