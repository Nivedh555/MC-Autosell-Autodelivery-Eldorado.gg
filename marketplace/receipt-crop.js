'use strict';

const {PNG} = require('pngjs');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function receiptSpec(order, chunks) {
  const orderId = order.id || order.orderId;
  if (!orderId || !Array.isArray(chunks) || !chunks.length ||
      chunks.reduce((sum, chunk) => sum + BigInt(chunk.amount), 0n) !== BigInt(order.amount))
    throw Error('Payment evidence needs the full verified order amount');
  const ids = new Set();
  const lines = chunks.map(chunk => {
    const result = typeof chunk.result === 'string' ? JSON.parse(chunk.result) : chunk.result;
    const signal = result?.signal;
    const capture = signal?.capture;
    const id = capture?.fabricReceiptId;
    if (chunk.order_id !== orderId || chunk.state !== 'PAY_VERIFIED' || result?.verified !== true ||
        signal?.recipient?.toLowerCase() !== order.buyerIgn?.toLowerCase() ||
        signal?.amount !== chunk.command_amount || !UUID.test(id) || ids.has(id) ||
        capture?.command !== '/pay ' + order.buyerIgn + ' ' + chunk.command_amount ||
        !['system','game_info'].includes(capture?.position) || capture.sender ||
        typeof capture.raw !== 'string' || capture.raw.length > 256)
      throw Error('Verified payment lacks its distinct Fabric receipt identity; manual evidence review required');
    ids.add(id);
    return {id, text:capture.raw};
  });
  return {orderId, lines};
}

// PNG.bitblt is a byte-for-byte rectangle copy from the captured framebuffer.
function cropReceipt(bytes, receipt, spec) {
  if (receipt?.version !== 1 || receipt.orderId !== spec.orderId || !Array.isArray(receipt.lines) ||
      receipt.lines.length !== spec.lines.length ||
      receipt.lines.some((row,i) => row?.id !== spec.lines[i].id || row?.text !== spec.lines[i].text))
    throw Error('Payment screenshot is missing verified render geometry for this order');
  const {frameWidth,frameHeight,x,y,width,height} = receipt;
  if (!bytes || bytes.length < 32 || bytes.length > 5 * 1024 * 1024 ||
      ![frameWidth,frameHeight,x,y,width,height].every(Number.isSafeInteger) ||
      frameWidth !== bytes.readUInt32BE(16) || frameHeight !== bytes.readUInt32BE(20) ||
      frameWidth * frameHeight > 24_000_000 || x < 0 || y < 0 || width < 16 || height < 5 ||
      x + width > frameWidth || y + height > frameHeight)
    throw Error('Receipt bounds do not fit the original framebuffer');
  const original = PNG.sync.read(bytes);
  let left=frameWidth, top=frameHeight, right=0, bottom=0;
  for (const line of receipt.lines) {
    if (!Array.isArray(line.boxes) || !line.boxes.length || line.boxes.length > 100)
      throw Error('Missing visible payment text bounds');
    for (const box of line.boxes) {
      if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isSafeInteger))
        throw Error('Invalid visible payment text bounds');
      const [x0,y0,x1,y1] = box;
      if (x0<x || y0<y || x1>x+width || y1>y+height || x1<=x0 || y1<=y0)
        throw Error('Payment text escapes its receipt crop');
      left=Math.min(left,x0); top=Math.min(top,y0); right=Math.max(right,x1); bottom=Math.max(bottom,y1);
      let dark=0, light=0;
      for (let py=y0; py<y1; py++) {
        for (let px=x0; px<x1; px++) {
          const i=(py*frameWidth+px)*4;
          const peak=Math.max(original.data[i],original.data[i+1],original.data[i+2]);
          if (peak < 110) dark++;
          if (peak > 155) light++;
        }
      }
      if (Math.min(dark,light) < 3) throw Error('Verified payment row has insufficient contrast');
    }
  }
  if (left!==x || top!==y || right!==x+width || bottom!==y+height)
    throw Error('Receipt includes pixels outside the verified text bounds');
  const crop = new PNG({width,height});
  PNG.bitblt(original,crop,x,y,width,height,0,0);
  return PNG.sync.write(crop);
}

function forEvidenceReview(error) {
  error.code='EVIDENCE_REVIEW';
  return error;
}

module.exports = {receiptSpec,cropReceipt,forEvidenceReview};
