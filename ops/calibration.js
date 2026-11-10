'use strict';
const crypto = require('node:crypto');
const { reserveCommandChannel } = require('../minecraft/verified-payments');
const { balancePattern } = require('./balance-pattern');
class CalibrationRecorder {
  constructor(services) { this.services = services; this.active = new Map(); this.starting = false; }
  async start(accountId, confirmation, recipient = null) {
    if (this.starting || this.active.size) throw new Error('Finish the current balance capture first.');
    this.starting = true;
    try { return await this._start(accountId, confirmation, recipient); } finally { this.starting = false; }
  }
  async capturePayment(request) {
    if(this.starting||this.active.size)throw Error('Finish the active balance capture first.');
    this.starting=true;
    try{return await require('./controlled-payment-capture').captureOneCoin(this,request);}finally{this.starting=false;}
  }
  async _start(accountId, confirmation, recipient) {
    if (recipient !== null && !require('../minecraft/verified-payments').validIgn(recipient)) throw Error('Use one valid Minecraft IGN for recipient balance capture.');
    const roles = await this.services.settings.get('treasury.accountRoles');
    if (!Object.hasOwn(roles, accountId) || confirmation !== 'CAPTURE ' + accountId) throw new Error('Configured account and typed CAPTURE confirmation required');
    if (this.active.size) throw new Error('Finish the current calibration first');
    if (await require('../treasury/trading-controls').globallyEnabled(this.services.settings)) throw new Error('Stop trading before calibration');
    await this.assertAvailable(accountId);
    const lease = await this.services.sessions.acquire(accountId, 'owner-calibration', { ttlMs: 120000 });
    let releaseChannel, id;
    try {
      await lease.ready(); const bot = lease.getBot(), db = this.services.db.raw(); id = crypto.randomUUID();
      await this.assertAvailable(accountId);
      releaseChannel = reserveCommandChannel(bot);
      db.prepare("INSERT INTO calibration_runs VALUES(?,?,?,NULL,'CAPTURING')").run(id, accountId, Date.now());
      const record = (kind, data) => db.prepare('INSERT INTO calibration_events(run_id,kind,data,wall_ms,monotonic_ns) VALUES(?,?,?,?,?)').run(id, kind, JSON.stringify(data), Date.now(), process.hrtime.bigint().toString());
      const listener = (raw, position, _original, sender) => record('chat', { raw: String(raw), position: position ?? null, sender: sender ?? null });
      bot.on('messagestr', listener);
      const timer = setTimeout(() => this.stop(id), 60000); timer.unref?.();
      this.active.set(id, { bot, lease, listener, timer, releaseChannel });
      const command = recipient === null ? '/bal' : '/bal ' + recipient;
      record('command', { command }); bot.chat(command);
      return { id, state: 'CAPTURING', automaticPayment: false, message: 'Recording packet metadata and raw replies for up to 60 seconds. Owner-controlled test transfers require a separate Minecraft client. Captures do not automatically verify a pattern pack.' };
    } catch (error) { if (id && this.active.has(id)) this.stop(id); else { releaseChannel?.(); lease.release(); } throw error; }
  }
  async reviewIncoming(id, eventId, ign, amountText, confirmation) {
    if (confirmation !== 'USE CAPTURED INCOMING RECEIPT') throw Error('Confirm the selected captured incoming server receipt');
    if (await require('../treasury/trading-controls').globallyEnabled(this.services.settings)) throw Error('Pause intake before reviewing receipt setup');
    const db = this.services.db.raw();
    const run = db.prepare('SELECT * FROM calibration_runs WHERE id=?').get(id);
    const event = db.prepare("SELECT * FROM calibration_events WHERE run_id=? AND id=? AND kind='chat'").get(id,eventId);
    if (!run || !event) throw Error('Choose a receipt from the saved capture');
    const roles = await this.services.settings.get('treasury.accountRoles');
    if (roles[run.account_id]?.role !== 'intake') throw Error('Choose a Buyer intake account');
    if (this.active.size && !this.active.has(id)) throw Error('Finish the other active capture first');
    const learned = require('./incoming-payment-pattern').incomingPattern(JSON.parse(event.data),ign,amountText);
    await this.assertAvailable(run.account_id);
    this.stop(id);
    const previous = await this.services.settings.get('delivery.patternPack');
    const source = `Owner reviewed incoming receipt capture ${id}, event ${event.id}, account ${run.account_id}; exact /bal delta remains required`;
    await this.services.settings.set('delivery.patternPack',{...previous,incoming:learned.incoming,incomingCalibrated:true,incomingSource:source,systemPositions:[...new Set([...(previous.systemPositions||[]),learned.systemPosition])]},'owner');
    db.prepare("UPDATE calibration_runs SET state='INCOMING_REVIEWED' WHERE id=?").run(id);
    return {success:true,accountId:run.account_id,capturedAmount:learned.capturedAmount,message:'Receipt format saved. Every sale still needs its own matching sender, amount and exact balance increase.'};
  }

  async reviewRecipientBalance(id, eventId, amountText, confirmation) {
    if (confirmation !== 'USE CAPTURED RECIPIENT BALANCE') throw Error('Confirm the captured recipient balance reply.');
    const db = this.services.db.raw(), run = db.prepare('SELECT * FROM calibration_runs WHERE id=?').get(id);
    if (!run) throw Error('Recipient balance capture not found.');
    if (this.active.size && !this.active.has(id)) throw Error('Finish the other active capture first.');
    await this.assertAvailable(run.account_id);
    const event = db.prepare("SELECT * FROM calibration_events WHERE run_id=? AND id=? AND kind='chat'").get(id,eventId);
    const command = db.prepare("SELECT * FROM calibration_events WHERE run_id=? AND kind='command' ORDER BY id LIMIT 1").get(id);
    const request = command && require('../minecraft/verified-payments').balanceCommand(JSON.parse(command.data).command);
    if (!event || !request?.target || event.id <= command.id) throw Error('Choose a reply captured after this run sent /bal IGN.');
    const learned = require('./recipient-balance-pattern').recipientBalancePattern(JSON.parse(event.data),request.target,amountText);
    const previous = await this.services.settings.get('delivery.patternPack');
    if (!previous?.systemPositions?.includes(learned.systemPosition)) throw Error('Review the sender balance packet position first; recipient capture cannot widen trusted payment sources.');
    this.stop(id);
    const source = `Owner reviewed captured ${request.command} run ${id}, event ${event.id}, account ${run.account_id}`;
    await this.services.settings.set('delivery.patternPack', {...previous,recipientBalance:learned.recipientBalance,recipientBalanceCalibrated:true,recipientBalanceSource:source},'owner');
    db.prepare("UPDATE calibration_runs SET state='RECIPIENT_BALANCE_REVIEWED' WHERE id=?").run(id);
    return {accountId:run.account_id,recipient:request.target,patternSaved:true,paymentCalibrated:previous.calibrated===true,...learned};
  }
  async assertAvailable(accountId) {
    if (await require('../treasury/trading-controls').globallyEnabled(this.services.settings)) throw new Error('Turn Global Autosell off before capturing or reviewing a balance format.');
    const db = this.services.db.raw();
    if (require('../sell/intake-admission').busy || db.prepare('SELECT account_id FROM delivery_account_locks WHERE account_id=?').get(accountId) || db.prepare("SELECT id FROM intake_sales WHERE account_id=? AND state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR')").get(accountId)) throw new Error('This account has an active or unresolved trade. Finish its review before calibration.');
  }
  async reviewBalance(id, eventId, amountText, confirmation) {
    if (confirmation !== 'USE CAPTURED BALANCE') throw new Error('Confirm the selected captured server balance reply.');
    const db = this.services.db.raw(), run = db.prepare('SELECT * FROM calibration_runs WHERE id=?').get(id);
    if (!run) throw new Error('Capture not found. Capture /bal again.');
    if (this.active.size && !this.active.has(id)) throw new Error('Finish the other active capture before reviewing this reply.');
    await this.assertAvailable(run.account_id);
    const event = db.prepare("SELECT * FROM calibration_events WHERE run_id=? AND id=? AND kind='chat'").get(id, eventId);
    const command = db.prepare("SELECT * FROM calibration_events WHERE run_id=? AND kind='command' ORDER BY id LIMIT 1").get(id);
    if (!event || !command || event.id <= command.id || JSON.parse(command.data).command !== '/bal') throw new Error('Choose a reply captured after this run sent /bal.');
    const learned = balancePattern(JSON.parse(event.data), amountText);
    this.stop(id);
    const previous = await this.services.settings.get('delivery.patternPack');
    const source = `Owner reviewed captured /bal run ${id}, event ${event.id}, account ${run.account_id}`;
    await this.services.settings.set('delivery.patternPack', { ...previous, balance: learned.balance, balanceDisplay: { ...learned.balanceDisplay, source }, systemPositions: learned.systemPositions, balanceCalibrated: true, calibrated: false, source, balanceSource: source, timeoutMs: Number.isInteger(previous?.timeoutMs) && previous.timeoutMs > 0 ? previous.timeoutMs : 10000 }, 'owner');
    db.prepare("UPDATE calibration_runs SET state='BALANCE_REVIEWED' WHERE id=?").run(id);
                                                                             
    let result;
    try { result = await this.services.treasury.reconcile(run.account_id); }
    catch (error) { result = { ok: false, reason: error.message }; }
    return { accountId: run.account_id, patternSaved: true, paymentCalibrated: false, balanceRead: result, message: result.ok ? 'Balance format saved and a fresh balance stored. Payment formats still need review before live delivery.' : 'Balance format saved. Fresh balance check needs attention: ' + result.reason };
  }
  stop(id) {
    const run = this.active.get(id);
    if (!run) return false;
    clearTimeout(run.timer); run.bot.removeListener('messagestr', run.listener); run.releaseChannel?.(); run.lease.release(); this.active.delete(id);
    this.services.db.raw().prepare("UPDATE calibration_runs SET ended_ms=?,state='CAPTURED_UNREVIEWED' WHERE id=?").run(Date.now(), id);
    return true;
  }
  close() { for (const id of this.active.keys()) this.stop(id); }
  get(id) { const db = this.services.db.raw(); return { run: db.prepare('SELECT * FROM calibration_runs WHERE id=?').get(id), events: db.prepare('SELECT * FROM calibration_events WHERE run_id=? ORDER BY id').all(id), verified: false }; }
}
module.exports = { CalibrationRecorder };
