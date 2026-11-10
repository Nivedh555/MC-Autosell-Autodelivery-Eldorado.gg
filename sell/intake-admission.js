'use strict';
const { EventEmitter } = require('events');

                                                                             
                                                                           
class IntakeAdmission extends EventEmitter {
  constructor() { super(); this.active = null; this.accepted = 0; this.rejected = 0; }
  acquire(discordId) {
    require('../services').maintenance?.assertCanDispatch();
    if (this.active) { this.rejected++; throw Error('Intake is busy with another sale. Do not send money or items; try again after it finishes.'); }
    const token = { discordId, maintenance: require('../services').maintenance?.hold('customer-intake') };
    this.active = token;
    this.accepted++;
    let released = false;
    return { bindSale: saleId => {
      if(token.saleId&&token.saleId!==saleId)throw Error('Intake admission is already bound to a different sale');
      token.saleId=saleId;
    }, run: fn => token.maintenance ? token.maintenance.run(fn) : fn(), release: () => {
      if (released) return;
      released = true;
      if (this.active === token) this.active = null;
      token.maintenance?.release();
      queueMicrotask(() => this.emit('available'));
    } };
  }
  runSale(discordId, saleId, fn) {
    const token=this.active;
    return token?.discordId===discordId&&token.saleId===saleId&&token.maintenance ? token.maintenance.run(fn) : fn();
  }
  get busy() { return Boolean(this.active); }
  status() { return {busy:this.busy,concurrency:1,accepted:this.accepted,rejected:this.rejected}; }
}
module.exports = new IntakeAdmission();
module.exports.IntakeAdmission = IntakeAdmission;
