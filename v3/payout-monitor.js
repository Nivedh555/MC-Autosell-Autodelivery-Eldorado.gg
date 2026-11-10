"use strict";
class PayoutMonitor {
  constructor(s) {
    this.s = s;
    this.busy = false;
  }
  start() {
    this.s.db
      .raw()
      .exec(
        "CREATE TABLE IF NOT EXISTS v3_payout_status(id TEXT PRIMARY KEY,txid TEXT NOT NULL,confirmations INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,checked_ms INTEGER,reason TEXT)",
      );
    this.timer = setInterval(() => this.tick().catch(() => {}), 60000);
    this.timer.unref();
  }
  async check(row) {
    const wallet = this.s.wallet;
    if (!wallet) throw Error("Wallet unavailable");
    const txid = row.txid || JSON.parse(row.result || "{}").txid;
    if (!/^[a-f0-9]{64}$/.test(txid || ""))
      throw Error("No persisted transaction ID");
    const request = async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Error("Transaction provider returned HTTP " + r.status);
      return r.json();
    };
    const info = await wallet._tryProviders({
      blockcypher: async () => {
        const t = await request(wallet._bcy("/txs/" + txid));
        if (t.hash !== txid) throw Error("Transaction ID mismatch");
        return {
          confirmations: Number(t.confirmations || 0),
          outputs: t.outputs?.map((o) => ({
            addresses: o.addresses || [],
            value: o.value,
          })),
        };
      },
      esplora: async () => {
        const t = await request(this.s.config.wallet.apiBase + "/tx/" + txid);
        if (t.txid !== txid) throw Error("Transaction ID mismatch");
        return {
          confirmations: t.status?.confirmed ? 1 : 0,
          outputs: t.vout?.map((o) => ({
            addresses: [o.scriptpubkey_address],
            value: o.value,
          })),
        };
      },
    });
    if (
      !info.outputs?.some(
        (o) =>
          o.addresses.includes(row.address) && String(o.value) === row.litoshi,
      )
    )
      throw Error("Published transaction does not contain the recorded payout");
    return {
      txid,
      confirmations: info.confirmations,
      status: info.confirmations > 0 ? "CONFIRMED" : "BROADCAST",
    };
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const db = this.s.db.raw();
      const rows = db
        .prepare(
          "SELECT p.* FROM payout_intents p LEFT JOIN v3_payout_status c ON c.id=p.id WHERE p.txid IS NOT NULL AND (c.status IS NULL OR c.status!='CONFIRMED') ORDER BY COALESCE(c.checked_ms,0) LIMIT 20",
        )
        .all();
      for (const row of rows)
        try {
          const result = await this.check(row);
          db.prepare(
            "INSERT INTO v3_payout_status VALUES(?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET confirmations=excluded.confirmations,status=excluded.status,checked_ms=excluded.checked_ms,reason=NULL",
          ).run(
            row.id,
            result.txid,
            result.confirmations,
            result.status,
            Date.now(),
          );
        } catch (error) {
          db.prepare(
            "INSERT INTO v3_payout_status VALUES(?,?,0,'UNKNOWN',?,?) ON CONFLICT(id) DO UPDATE SET status='UNKNOWN',confirmations=0,checked_ms=excluded.checked_ms,reason=excluded.reason",
          ).run(row.id, row.txid, Date.now(), error.message);
        }
    } finally {
      this.busy = false;
    }
  }
  stop() {
    clearInterval(this.timer);
  }
}
module.exports = { PayoutMonitor };
