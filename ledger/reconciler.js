'use strict';

class Reconciler {
  constructor(db) {
    this.db = db;
  }

  run() {
    const issues = [];
    
                                                                              
                                                                             
    const salesStmt = this.db.prepare("SELECT id FROM sales WHERE state = 'PAYOUT_INTENT'");
    const stalledSales = salesStmt.all();
    for (const sale of stalledSales) {
      issues.push({
        type: 'payout_intent_without_broadcast',
        referenceId: sale.id,
        details: 'Sale is stuck in PAYOUT_INTENT state without a transaction broadcast.',
        suggestedAction: 'resume_payout'
      });
    }

                                                               
    const transferStmt = this.db.prepare("SELECT id FROM transfers WHERE state = 'SENT'");
    const stalledTransfers = transferStmt.all();
    for (const transfer of stalledTransfers) {
      issues.push({
        type: 'transfer_sent_without_arrived',
        referenceId: transfer.id,
        details: 'Transfer sent but arrival not confirmed.',
        suggestedAction: 'verify_transfer_arrival'
      });
    }

                                             
    const creditedSalesStmt = this.db.prepare("SELECT id FROM sales WHERE state = 'CREDITED'");
    const creditedSales = creditedSalesStmt.all();
    for (const sale of creditedSales) {
      issues.push({
        type: 'sale_credited_without_payout_intent',
        referenceId: sale.id,
        details: 'Sale was credited to the ledger but payout intent was not initiated.',
        suggestedAction: 'initiate_payout'
      });
    }

                                                              
    const ledgerStmt = this.db.prepare("SELECT id, reference_type, reference_id FROM ledger");
    const entries = ledgerStmt.all();
    for (const entry of entries) {
      let valid = true;
      if (entry.reference_type === 'sale') {
        const stmt = this.db.prepare("SELECT id FROM sales WHERE id = ?");
        valid = !!stmt.get(entry.reference_id);
      } else if (entry.reference_type === 'transfer') {
        const stmt = this.db.prepare("SELECT id FROM transfers WHERE id = ?");
        valid = !!stmt.get(entry.reference_id);
      } else if (entry.reference_type === 'marketplace_order') {
        const stmt = this.db.prepare("SELECT id FROM marketplace_orders WHERE id = ?");
        valid = !!stmt.get(entry.reference_id);
      }
      
      if (!valid) {
        issues.push({
          type: 'orphaned_entry',
          referenceId: entry.id.toString(),
          details: `Ledger entry refers to non-existent ${entry.reference_type}: ${entry.reference_id}`,
          suggestedAction: 'investigate_orphaned_entry'
        });
      }
    }

    return {
      ok: issues.length === 0,
      issues
    };
  }
}

module.exports = Reconciler;
