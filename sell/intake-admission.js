'use strict';
const { EventEmitter } = require('events');

                                                                             
                                                                           
class IntakeAdmission extends EventEmitter {
  constructor() { super(); this.active = null; this.accepted = 0; this.rejected = 0; }
  acquire(discordId) {
    if (this.active) { this.rejected++; throw Error('Intake is busy with another sale. Do not send money or items; try again after it finishes.'); }
    const token = { discordId };
    this.active = token;
    this.accepted++;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      if (this.active === token) this.active = null;
      queueMicrotask(() => this.emit('available'));
    } };
  }
  get busy() { return Boolean(this.active); }
  status() { return {busy:this.busy,concurrency:1,accepted:this.accepted,rejected:this.rejected}; }
}
module.exports = new IntakeAdmission();
module.exports.IntakeAdmission = IntakeAdmission;
