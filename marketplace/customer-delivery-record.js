'use strict';
const crypto = require('node:crypto');
const IGN = /^\.?[A-Za-z0-9_]{3,16}$/;
const amountText = '(?:[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?[KMB]?)';
const scope = 'DonutFlip record integrity only; no server attestation.';
function parsed(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
function stamp(value) { return Number.isFinite(value) && value >= 0 && value < 8640000000000000 ? new Date(value).toISOString() : 'not captured'; }
function build(record, signingKey) {
  const recipient = IGN.test(record.buyerIgn || '') ? record.buyerIgn : null;
  const escaped = recipient ? recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '(?!)';
                                                                               
                                                                          
  const balance = new RegExp('^' + escaped + ' has \\$ ' + amountText + '$', 'i');
  const paid = new RegExp('^You paid ' + escaped + ' \\$ ' + amountText + '$', 'i');
  const events = [], history = Array.isArray(record.stateHistory) ? record.stateHistory : [];
  let awaiting = null;
  for (const event of history) {
    const data = parsed(event.data); if (!data) continue;
    if (event.kind === 'command') {
      const command = String(data.command || '');
      const isBalance = recipient && command.toLowerCase() === '/bal ' + recipient.toLowerCase();
      const isPay = new RegExp('^/pay ' + escaped + ' [1-9][0-9]*$', 'i').test(command);
      awaiting = isBalance ? 'balance' : isPay ? 'payment' : null;
      if (awaiting) events.push({ time: stamp(event.wall_ms ?? data.wallMs), kind: 'command', text: command });
    } else if (event.kind === 'chat' && awaiting && data.sender === null && data.position === 'system' && typeof data.raw === 'string') {
      if ((awaiting === 'balance' ? balance : paid).test(data.raw)) {
        events.push({ time: stamp(event.wall_ms ?? data.wallMs), kind: 'server reply', text: data.raw }); awaiting = null;
      }
    }
  }
  const chunks = Array.isArray(record.chunks) ? record.chunks : [];
  const verified = chunks.length > 0 && chunks.every(c => c.state === 'PAY_VERIFIED' && /^[1-9][0-9]*$/.test(String(c.amount))) &&
    /^[1-9][0-9]*$/.test(String(record.amount)) && chunks.reduce((n,c) => n + BigInt(c.amount), 0n) === BigInt(record.amount);
  const connections = Array.isArray(record.connection) ? record.connection : [];
  const server = connections.find(c => String(c.requestedHost).toLowerCase() === 'donutsmp.net');
  const orderId = /^[a-f0-9-]{36}$/i.test(record.orderId || '') ? record.orderId : null;
  const publicRecord = {
    schemaVersion: 1, title: 'DonutFlip Delivery Logs', scope,
    type: record.mode === 'owner-capture' ? 'Owner repayment capture' : 'Order delivery record',
    orderId, recipient: recipient || 'not captured', nominalCoins: /^[1-9][0-9]*$/.test(String(record.amount)) ? String(record.amount) : 'not captured',
    connectedHost: server ? 'donutsmp.net' : 'not captured',
    connectionTime: server ? stamp(Date.parse(server.capturedAt)) : 'not captured',
    paymentStatus: verified ? 'Matching payment confirmation and exact sender debit recorded for all chunks' : 'Captured payment replies; verification not recorded in this artifact',
    events,
  };
  const bytes = Buffer.from(JSON.stringify(publicRecord, null, 2));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const publicKey = signingKey ? crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }) : null;
  const signature = signingKey ? crypto.sign(null, bytes, signingKey).toString('base64') : null;
  const body = [publicRecord.title, '='.repeat(54), publicRecord.type,
    ...(orderId ? ['Order: ' + orderId] : []), 'Recipient: ' + publicRecord.recipient,
    'Command amount: ' + publicRecord.nominalCoins + ' coins',
    'Connected host: ' + publicRecord.connectedHost + ' (client observation)',
    'Connection captured: ' + publicRecord.connectionTime,
    'Payment: ' + publicRecord.paymentStatus, '', 'CAPTURED COMMANDS & REPLIES  |  UTC', '-'.repeat(54),
    ...events.map(e => e.time + '  ' + (e.kind === 'command' ? 'COMMAND  ' : 'REPLY    ') + e.text),
    ...(events.length ? [] : ['No correlated recipient command/reply captured.']),
    ''].join('\n');
  const bodyBytes = Buffer.from(body, 'utf8');
  const textDigest = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  const textSignature = signingKey ? crypto.sign(null, bodyBytes, signingKey).toString('base64') : null;
  const text = body + ['\nINTEGRITY', 'Content SHA-256: ' + textDigest,
    'Integrity: ' + (signature ? 'DonutFlip signed (Ed25519)' : 'Unsigned preview'),
    'Signature scope: File integrity; not an official server receipt.',
    ...(textSignature ? ['Signature: ' + textSignature, publicKey.trim(), 'Signature covers UTF-8 content before the INTEGRITY divider (including its preceding newline).'] : []),
    'Private diagnostics are not included.', ''].join('\n');
  return { text, json: JSON.stringify({ record: publicRecord, sha256: digest, signature, publicKey }, null, 2) };
}
module.exports = { build };
