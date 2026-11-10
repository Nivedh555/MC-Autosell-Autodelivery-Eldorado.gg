'use strict';

// Only idle, nonfinancial observations may use this cache. Exact transaction
// pre/post balances continue to call VerifiedPayments.readBalance directly.
class BalanceCoordinator {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.accounts = new WeakMap(); }
  state(bot) {
    let state = this.accounts.get(bot);
    if (!state) {
      state = { generation: 0, pending: null, snapshot: null, closed: false, commands: 0, shared: 0, hits: 0 };
      this.accounts.set(bot, state);
      bot.once('end', () => { state.closed = true; state.generation++; state.snapshot = null; });
    }
    return state;
  }
  invalidate(bot) {
    const state = this.accounts.get(bot);
    if (state) { state.generation++; state.snapshot = null; }
  }
  async read(bot, key, read, { maxAgeMs = 5000, available = () => true } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 5000) throw Error('Idle balance freshness must be between 0 and 5000 milliseconds.');
    const state = this.state(bot);
    if (state.closed) throw Error('Balance observation belongs to a disconnected session.');
    if (state.pending?.key === key) { state.shared++; return { ...await state.pending.task, shared: true }; }
    if (!available()) throw Error('This account is checking or sending a payment. Wait for it to finish before reading the balance.');
    const age = state.snapshot ? this.now() - state.snapshot.observedMs : Infinity;
    if (maxAgeMs > 0 && state.snapshot?.key === key && age >= 0 && age < maxAgeMs) {
      state.hits++; return { ...state.snapshot, cached: true };
    }
    const generation = state.generation;
    const task = Promise.resolve().then(async () => {
      state.commands++;
      const value = await read();
      if (state.closed || state.generation !== generation) throw Error('Account activity changed during the idle balance observation; refresh before using it.');
      const snapshot = Object.freeze({ ...value, key, observedMs: value.observedMs ?? this.now(), cached: false });
      state.snapshot = snapshot;
      return snapshot;
    });
    const pending = { key, task }; state.pending = pending;
    try { return { ...await task }; }
    finally { if (state.pending === pending) state.pending = null; }
  }
  metrics(bot) {
    const state = this.accounts.get(bot);
    return state ? { commands: state.commands, shared: state.shared, cacheHits: state.hits, observedMs: state.snapshot?.observedMs ?? null, pending: Boolean(state.pending), disconnected: state.closed } : null;
  }
}
const idleBalances = new BalanceCoordinator();
module.exports = { BalanceCoordinator, idleBalances };
