'use strict';

const canceled = new Set(['canceled', 'cancelled', 'order canceled', 'order cancelled', 'refunded']);
const completed = new Set(['delivered', 'order delivered', 'order marked as delivered', 'received', 'order received', 'completed']);
const stoppedStates = new Set(['CANCELLED', 'MARKETPLACE_CLOSED', 'RECONCILIATION_REQUIRED']);

function closure(status) {
  const value = String(status || '').trim().toLowerCase();
  if (canceled.has(value)) return 'canceled';
  if (completed.has(value)) return 'completed';
  return null;
}

// A later stale page may still show Paid. Cancellation takes precedence even if the
// older page reported delivery. Keep the most recent label for a completed order.
function closedStatus(...values) {
  return values.find(value => closure(value) === 'canceled') || values.find(value => closure(value) === 'completed') || null;
}

module.exports = {closure, closedStatus, stoppedStates};
