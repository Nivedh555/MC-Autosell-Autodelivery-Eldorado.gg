'use strict';
const services = require('../services');
const { VerifiedPayments, integer, validIgn } = require('../minecraft/verified-payments');
class PaymentVerifier {
  constructor(options = {}) { this.options = options; this.armed = new WeakMap(); this.arming = new WeakSet(); }
  async pack() { return this.options.patternPack || await services.settings?.get('delivery.patternPack'); }
  async arm(bot, { saleId, username, amount, context = {}, expiresMs = Date.now() + 300000, accountId = bot.accountId || bot.username }) {
    bot = bot.bot || bot;
    if (this.armed.has(bot) || this.arming.has(bot)) throw new Error('Intake already has an armed sale; finish or reconcile it first');
    this.arming.add(bot);
    try {
      const pack = await this.pack();
      if (!validIgn(username) || !saleId || !integer(amount)) throw new Error('Invalid intake sale identity/amount');
      const db = (this.options.db || services.db)?.raw();
      if (!db) throw new Error('Intake journal unavailable');
      if (db.prepare("SELECT 1 FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get(accountId)) throw Error('This intake account has an unresolved receipt; reconcile it before starting another sale');
      const verifier = new VerifiedPayments(pack, undefined, undefined, {readOnly:true});
      const before = await verifier.exclusive(bot, raw => require('./intake-balance').read(verifier,raw));
      if (db.prepare('SELECT 1 FROM delivery_account_locks WHERE account_id=?').get(accountId)) throw Error('This account is reserved for an outgoing game transfer; do not send coins');
      if (db.prepare("SELECT 1 FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get(accountId)) throw Error('This intake account became reserved during its balance check; do not send coins');
      if (!verifier.lastBalanceObservation?.exact) throw Error('The server returned a rounded balance. Configure an exact balance reply before accepting customer coins');
      db.prepare('INSERT INTO intake_sales(id,account_id,sender,amount,before_balance,state,created_ms,context) VALUES(?,?,?,?,?,?,?,?)')
        .run(saleId, accountId, username, String(amount), String(before), 'ARMED', Date.now(),JSON.stringify({...context,expiresMs}));
      this.armed.set(bot, { saleId, username, amount: String(amount), before, armedMs: Date.now(), expiresMs });
      return before;
    } finally { this.arming.delete(bot); }
  }
  disarm(bot) { this.armed.delete(bot.bot || bot); }
  async verifyPayment(bot, payment) {
    bot = bot.bot || bot;
    const arm = this.armed.get(bot);
    if (!arm) {
      const db = (this.options.db || services.db)?.raw();
      if (payment.saleId && db?.prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason='Live intake session was lost; reconcile the receipt before paying' WHERE id=? AND state IN ('ARMED','CHECKING')").run(payment.saleId).changes) services.events?.emit('operator:alert',{component:'intake',saleId:payment.saleId,reason:'Live intake session was lost; receipt requires reconciliation'});
      return { confirmed: false, error: 'No correlated pre-payment balance; operator reconciliation required' };
    }
    this.armed.delete(bot);                                                                                             
    const db = (this.options.db || services.db).raw();
    db.prepare("UPDATE intake_sales SET state='CHECKING' WHERE id=?").run(arm.saleId);
    try {
      if (Date.now() >= arm.expiresMs) throw Error('Payment arrived after the intake window expired; operator reconciliation required');
      const pack = await this.pack();
      const incoming = require('./payment-patterns').matchCaptured(payment.rawLine, payment.packet, pack);
      if (!incoming || incoming.username.toLowerCase() !== arm.username.toLowerCase() || String(incoming.amountText) !== arm.amount || payment.saleId !== arm.saleId) throw new Error('Captured receipt does not match the armed sale');
      const verifier = new VerifiedPayments(pack, undefined, undefined, {readOnly:true});
      const after = await verifier.exclusive(bot, raw => require('./intake-balance').read(verifier,raw));
      if (!verifier.lastBalanceObservation?.exact) throw Error('The post-payment balance is rounded; exact increase is unknown and needs operator review');
      const expected = integer(arm.amount), delta = after - arm.before;
      if (delta !== expected) throw new Error('Intake balance delta mismatch; expected ' + expected + ', observed ' + delta);
      db.prepare("UPDATE intake_sales SET state='RECEIVED',after_balance=?,capture=? WHERE id=?").run(String(after), JSON.stringify(payment), arm.saleId);
      return { confirmed: true, verifiedAmount: Number(expected), delta: Number(delta), balance: Number(after), before: String(arm.before), after: String(after), saleId: arm.saleId };
    } catch (error) {
      db.prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason=?,capture=? WHERE id=?").run(error.message, JSON.stringify(payment), arm.saleId);
      services.events?.emit('operator:alert', { component: 'intake', saleId: arm.saleId, reason: error.message });
      return { confirmed: false, error: error.message };
    }
  }
}
module.exports = new PaymentVerifier();
module.exports.PaymentVerifier = PaymentVerifier;
