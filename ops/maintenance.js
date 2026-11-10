"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
// The fence is committed before replying to the desktop. Existing admitted work
// can finish under its lease; queued/new work cannot acquire one after the fence.
class Maintenance {
  constructor(db) {
    this.db = db;
    this.scope = new AsyncLocalStorage();
    this.leases = new Set();
    this.active = this.row().active === 1;
  }
  row() {
    return this.db
      .prepare("SELECT * FROM desktop_maintenance WHERE id=1")
      .get();
  }
  admitted() {
    const lease = this.scope.getStore();
    return Boolean(lease && this.leases.has(lease));
  }
  blocked() {
    return this.active && !this.admitted();
  }
  assertCanDispatch() {
    if (this.blocked())
      throw Object.assign(
        Error(
          "Application maintenance is waiting for active work; no new payment was sent.",
        ),
        { code: "MAINTENANCE" },
      );
  }
  async run(label, fn) {
    if (this.admitted()) return fn();
    const held = this.hold(label);
    try {
      return await held.run(fn);
    } finally {
      held.release();
    }
  }
  hold(label) {
    this.assertCanDispatch();
    const lease = { label };
    this.leases.add(lease);
    return {
      run: (fn) => {
        if (!this.leases.has(lease)) throw Error('This maintenance admission has already finished');
        return this.scope.run(lease, fn);
      },
      release: () => this.leases.delete(lease),
    };
  }
  begin(targetVersion = null) {
    if (
      targetVersion !== null &&
      (typeof targetVersion !== "string" || !VERSION.test(targetVersion))
    )
      throw Error("Invalid update version");
    if (this.active && this.row().target_version !== targetVersion)
      throw Error(
        "Resolve the existing maintenance request before changing its target",
      );
    this.db
      .prepare(
        "UPDATE desktop_maintenance SET active=1,target_version=?,reason='Desktop maintenance',updated_ms=? WHERE id=1",
      )
      .run(targetVersion, Date.now());
    this.active = true;
    return this.status();
  }
  status() {
    const checks = [
      [
        "Minecraft payment needs reconciliation",
        "SELECT 1 FROM delivery_chunks c JOIN delivery_orders d ON d.id=c.order_id WHERE c.state IN ('PAY_INTENT','PAY_SENT') AND NOT (d.state='TRANSFERRED' AND d.mode='owner-capture' AND d.id LIKE 'owner-spawners:%' AND c.state='PAY_SENT') LIMIT 1",
      ],
      [
        "A Minecraft account is reserved",
        "SELECT 1 FROM delivery_account_locks LIMIT 1",
      ],
      [
        "A Litecoin payout needs reconciliation",
        "SELECT 1 FROM payout_intents WHERE state!='BROADCAST' LIMIT 1",
      ],
      [
        "A Litecoin withdrawal needs reconciliation",
        "SELECT 1 FROM wallet_withdrawals WHERE state!='BROADCAST' LIMIT 1",
      ],
      [
        "A customer intake is active or unresolved",
        "SELECT 1 FROM intake_sales WHERE state IN ('ARMED','CHECKING','RECEIVED','NEEDS_OPERATOR') LIMIT 1",
      ],
      [
        "A game transfer is active or unresolved",
        "SELECT 1 FROM transfer_queue WHERE state IN ('PROCESSING','NEEDS_OPERATOR') LIMIT 1",
      ],
      [
        "A spawner intake needs reconciliation",
        "SELECT 1 FROM orders WHERE status IN ('collecting','payout_failed','needs_operator') LIMIT 1",
      ],
    ];
    const reasons = this.leases.size
      ? ["Waiting for " + this.leases.size + " active operation(s) to finish"]
      : [];
    if (require("../sell/intake-admission").busy)
      reasons.push("A customer intake is being prepared");
    for (const [label, sql] of checks)
      if (this.db.prepare(sql).get()) reasons.push(label);
    // A bridge call can outlive the caller if Minecraft disconnected after dispatch.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='v3_bridge_calls'",
        )
        .get() &&
      this.db
        .prepare(
          "SELECT 1 FROM v3_bridge_calls WHERE state IN ('DISPATCHED','UNKNOWN') AND (operation IN ('store','collect') OR (operation='command' AND json_extract(request,'$.command') LIKE '/pay %')) LIMIT 1",
        )
        .get()
    )
      reasons.push("A game command has an unresolved bridge outcome");
    const row = this.row();
    return {
      active: this.active,
      safe: this.active && reasons.length === 0,
      activeOperations: this.leases.size,
      targetVersion: row.target_version,
      reason: reasons[0] || (!this.active ? "Maintenance is not active" : null),
      reasons,
    };
  }
  resume() {
    if (!this.active) return this.status();
    const status = this.status();
    if (!status.safe) return status;
    this.db
      .prepare(
        "UPDATE desktop_maintenance SET active=0,target_version=NULL,reason=NULL,updated_ms=? WHERE id=1",
      )
      .run(Date.now());
    this.active = false;
    return { ...this.status(), safe: true, resumed: true };
  }
}
function run(context, label, fn) {
  return context.maintenance ? context.maintenance.run(label, fn) : fn();
}
module.exports = { Maintenance, run };
