'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

                                                                                              
const FONT_MAP = {
  ' ': [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00],
  '!': [0x18,0x18,0x18,0x18,0x18,0x00,0x18,0x00],
  '"': [0x66,0x66,0x24,0x00,0x00,0x00,0x00,0x00],
  '#': [0x6c,0x6c,0xfe,0x6c,0xfe,0x6c,0x6c,0x00],
  '$': [0x18,0x3e,0x58,0x3c,0x1a,0x7c,0x18,0x00],
  '%': [0x62,0x66,0x0c,0x18,0x30,0x66,0x46,0x00],
  '&': [0x38,0x6c,0x38,0x76,0xdc,0xcc,0x76,0x00],
  '\'': [0x18,0x18,0x30,0x00,0x00,0x00,0x00,0x00],
  '(': [0x0c,0x18,0x30,0x30,0x30,0x18,0x0c,0x00],
  ')': [0x30,0x18,0x0c,0x0c,0x0c,0x18,0x30,0x00],
  '*': [0x00,0x66,0x3c,0xff,0x3c,0x66,0x00,0x00],
  '+': [0x00,0x18,0x18,0x7e,0x18,0x18,0x00,0x00],
  ',': [0x00,0x00,0x00,0x00,0x18,0x18,0x30,0x00],
  '-': [0x00,0x00,0x00,0x7e,0x00,0x00,0x00,0x00],
  '.': [0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x00],
  '/': [0x06,0x0c,0x18,0x30,0x60,0xc0,0x80,0x00],
  '0': [0x3c,0x66,0x6e,0x76,0x66,0x66,0x3c,0x00],
  '1': [0x18,0x38,0x18,0x18,0x18,0x18,0x7e,0x00],
  '2': [0x3c,0x66,0x06,0x0c,0x18,0x30,0x7e,0x00],
  '3': [0x3c,0x66,0x06,0x1c,0x06,0x66,0x3c,0x00],
  '4': [0x0c,0x1c,0x34,0x64,0x7e,0x0c,0x0c,0x00],
  '5': [0x7e,0x60,0x7c,0x06,0x06,0x66,0x3c,0x00],
  '6': [0x3c,0x66,0x60,0x7c,0x66,0x66,0x3c,0x00],
  '7': [0x7e,0x06,0x0c,0x18,0x30,0x30,0x30,0x00],
  '8': [0x3c,0x66,0x66,0x3c,0x66,0x66,0x3c,0x00],
  '9': [0x3c,0x66,0x66,0x3e,0x06,0x66,0x3c,0x00],
  ':': [0x00,0x18,0x18,0x00,0x18,0x18,0x00,0x00],
  ';': [0x00,0x18,0x18,0x00,0x18,0x18,0x30,0x00],
  '<': [0x0c,0x18,0x30,0x60,0x30,0x18,0x0c,0x00],
  '=': [0x00,0x7e,0x00,0x7e,0x00,0x00,0x00,0x00],
  '>': [0x30,0x18,0x0c,0x06,0x0c,0x18,0x30,0x00],
  '?': [0x3c,0x66,0x06,0x0c,0x18,0x00,0x18,0x00],
  '@': [0x3c,0x66,0x6e,0x6a,0x6e,0x60,0x3e,0x00],
  'A': [0x18,0x3c,0x66,0x7e,0x66,0x66,0x66,0x00],
  'B': [0x7c,0x66,0x66,0x7c,0x66,0x66,0x7c,0x00],
  'C': [0x3c,0x66,0x60,0x60,0x60,0x66,0x3c,0x00],
  'D': [0x78,0x6c,0x66,0x66,0x66,0x6c,0x78,0x00],
  'E': [0x7e,0x60,0x60,0x78,0x60,0x60,0x7e,0x00],
  'F': [0x7e,0x60,0x60,0x78,0x60,0x60,0x60,0x00],
  'G': [0x3c,0x66,0x60,0x6e,0x66,0x66,0x3a,0x00],
  'H': [0x66,0x66,0x66,0x7e,0x66,0x66,0x66,0x00],
  'I': [0x3c,0x18,0x18,0x18,0x18,0x18,0x3c,0x00],
  'J': [0x0e,0x06,0x06,0x06,0x06,0x66,0x3c,0x00],
  'K': [0x66,0x6c,0x78,0x70,0x78,0x6c,0x66,0x00],
  'L': [0x60,0x60,0x60,0x60,0x60,0x60,0x7e,0x00],
  'M': [0x63,0x77,0x7f,0x6b,0x63,0x63,0x63,0x00],
  'N': [0x66,0x76,0x7e,0x7e,0x6e,0x66,0x66,0x00],
  'O': [0x3c,0x66,0x66,0x66,0x66,0x66,0x3c,0x00],
  'P': [0x7c,0x66,0x66,0x7c,0x60,0x60,0x60,0x00],
  'Q': [0x3c,0x66,0x66,0x66,0x6a,0x6c,0x36,0x00],
  'R': [0x7c,0x66,0x66,0x7c,0x6c,0x66,0x66,0x00],
  'S': [0x3c,0x66,0x60,0x3c,0x06,0x66,0x3c,0x00],
  'T': [0x7e,0x18,0x18,0x18,0x18,0x18,0x18,0x00],
  'U': [0x66,0x66,0x66,0x66,0x66,0x66,0x3c,0x00],
  'V': [0x66,0x66,0x66,0x66,0x66,0x3c,0x18,0x00],
  'W': [0x63,0x63,0x63,0x6b,0x7f,0x77,0x63,0x00],
  'X': [0x66,0x66,0x3c,0x18,0x3c,0x66,0x66,0x00],
  'Y': [0x66,0x66,0x66,0x3c,0x18,0x18,0x18,0x00],
  'Z': [0x7e,0x06,0x0c,0x18,0x30,0x60,0x7e,0x00],
  '[': [0x3c,0x30,0x30,0x30,0x30,0x30,0x3c,0x00],
  '\\': [0xc0,0x60,0x30,0x18,0x0c,0x06,0x02,0x00],
  ']': [0x3c,0x0c,0x0c,0x0c,0x0c,0x0c,0x3c,0x00],
  '^': [0x18,0x3c,0x66,0x00,0x00,0x00,0x00,0x00],
  '_': [0x00,0x00,0x00,0x00,0x00,0x00,0xff,0x00],
  '`': [0x30,0x18,0x0c,0x00,0x00,0x00,0x00,0x00],
  'a': [0x00,0x00,0x3c,0x06,0x3e,0x66,0x3e,0x00],
  'b': [0x60,0x60,0x7c,0x66,0x66,0x66,0x7c,0x00],
  'c': [0x00,0x00,0x3c,0x66,0x60,0x66,0x3c,0x00],
  'd': [0x06,0x06,0x3e,0x66,0x66,0x66,0x3e,0x00],
  'e': [0x00,0x00,0x3c,0x66,0x7e,0x60,0x3c,0x00],
  'f': [0x0e,0x18,0x3e,0x18,0x18,0x18,0x18,0x00],
  'g': [0x00,0x00,0x3e,0x66,0x66,0x3e,0x06,0x3c],
  'h': [0x60,0x60,0x7c,0x66,0x66,0x66,0x66,0x00],
  'i': [0x18,0x00,0x38,0x18,0x18,0x18,0x3c,0x00],
  'j': [0x06,0x00,0x06,0x06,0x06,0x66,0x3c,0x00],
  'k': [0x60,0x60,0x66,0x6c,0x78,0x6c,0x66,0x00],
  'l': [0x38,0x18,0x18,0x18,0x18,0x18,0x3c,0x00],
  'm': [0x00,0x00,0x66,0x7f,0x7f,0x6b,0x63,0x00],
  'n': [0x00,0x00,0x7c,0x66,0x66,0x66,0x66,0x00],
  'o': [0x00,0x00,0x3c,0x66,0x66,0x66,0x3c,0x00],
  'p': [0x00,0x00,0x7c,0x66,0x66,0x7c,0x60,0x60],
  'q': [0x00,0x00,0x3e,0x66,0x66,0x3e,0x06,0x07],
  'r': [0x00,0x00,0x7c,0x66,0x60,0x60,0x60,0x00],
  's': [0x00,0x00,0x3e,0x60,0x3c,0x06,0x7c,0x00],
  't': [0x18,0x18,0x7e,0x18,0x18,0x18,0x0e,0x00],
  'u': [0x00,0x00,0x66,0x66,0x66,0x66,0x3e,0x00],
  'v': [0x00,0x00,0x66,0x66,0x66,0x3c,0x18,0x00],
  'w': [0x00,0x00,0x63,0x6b,0x7f,0x77,0x36,0x00],
  'x': [0x00,0x00,0x66,0x3c,0x18,0x3c,0x66,0x00],
  'y': [0x00,0x00,0x66,0x66,0x66,0x3e,0x06,0x3c],
  'z': [0x00,0x00,0x7e,0x0c,0x18,0x30,0x7e,0x00],
  '{': [0x0e,0x18,0x18,0x70,0x18,0x18,0x0e,0x00],
  '|': [0x18,0x18,0x18,0x18,0x18,0x18,0x18,0x00],
  '}': [0x70,0x18,0x18,0x0e,0x18,0x18,0x70,0x00],
  '~': [0x3b,0x6e,0x00,0x00,0x00,0x00,0x00,0x00]
};

   
                                                    
   
class BitmapCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.buffer = Buffer.alloc(width * height * 4, 0);
  }

  fill(r, g, b, a = 255) {
    for (let i = 0; i < this.buffer.length; i += 4) {
      this.buffer[i] = r;
      this.buffer[i + 1] = g;
      this.buffer[i + 2] = b;
      this.buffer[i + 3] = a;
    }
  }

  setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = (y * this.width + x) * 4;
    this.buffer[idx] = r;
    this.buffer[idx + 1] = g;
    this.buffer[idx + 2] = b;
    this.buffer[idx + 3] = a;
  }

  fillRect(x, y, w, h, r, g, b, a = 255) {
    for (let cy = y; cy < y + h; cy++) {
      for (let cx = x; cx < x + w; cx++) {
        this.setPixel(cx, cy, r, g, b, a);
      }
    }
  }

  drawBorder(x, y, w, h, r, g, b, thickness = 1) {
    for (let t = 0; t < thickness; t++) {
                       
      for (let cx = x; cx < x + w; cx++) {
        this.setPixel(cx, y + t, r, g, b, 255);
        this.setPixel(cx, y + h - 1 - t, r, g, b, 255);
      }
                       
      for (let cy = y; cy < y + h; cy++) {
        this.setPixel(x + t, cy, r, g, b, 255);
        this.setPixel(x + w - 1 - t, cy, r, g, b, 255);
      }
    }
  }

  drawText(text, x, y, color = [255, 255, 255], scale = 1) {
    const [r, g, b] = color;
    let curX = x;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const glyph = FONT_MAP[char] || FONT_MAP['?'] || [0,0,0,0,0,0,0,0];
      for (let row = 0; row < 8; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 8; col++) {
          if ((bits >> (7 - col)) & 1) {
            if (scale === 1) {
              this.setPixel(curX + col, y + row, r, g, b, 255);
            } else {
              this.fillRect(curX + col * scale, y + row * scale, scale, scale, r, g, b, 255);
            }
          }
        }
      }
      curX += 8 * scale;
    }
  }

  toPngBuffer() {
                                                          
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

           
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr.writeUInt8(8, 8);                      
    ihdr.writeUInt8(6, 9);        
    ihdr.writeUInt8(0, 10);               
    ihdr.writeUInt8(0, 11);          
    ihdr.writeUInt8(0, 12);                

    const ihdrChunk = createChunk('IHDR', ihdr);

                                                
    const scanlineLength = 1 + this.width * 4;
    const rawData = Buffer.alloc(this.height * scanlineLength);

    for (let y = 0; y < this.height; y++) {
      const rowOffset = y * scanlineLength;
      rawData[rowOffset] = 0;                    
      const srcOffset = y * this.width * 4;
      this.buffer.copy(rawData, rowOffset + 1, srcOffset, srcOffset + this.width * 4);
    }

    const compressed = zlib.deflateSync(rawData);
    const idatChunk = createChunk('IDAT', compressed);

           
    const iendChunk = createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  }
}

function createChunk(type, data) {
  const length = data.length;
  const chunk = Buffer.alloc(8 + length + 4);
  chunk.writeUInt32BE(length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);

  const crcTarget = chunk.subarray(4, 8 + length);
  const crc = crc32(crcTarget);
  chunk.writeInt32BE(crc, 8 + length);

  return chunk;
}

                                           
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

                                                                                      
const previewSecret = crypto.randomBytes(32);
function generateProofToken(orderId, secret = previewSecret) {
  return crypto.createHmac('sha256', secret).update(String(orderId)).digest('hex');
}
function verifyProofToken(orderId, token, secret = previewSecret) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(generateProofToken(orderId, secret), 'hex'));
}
const keyLoads = new WeakMap();
async function ownerKey(vault) {
  if (!vault) return null;
  if (!keyLoads.has(vault)) keyLoads.set(vault, (async () => {
    let pem = await vault.retrieve('evidence.signing.privateKey');
    if (!pem) {
      pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
      await vault.store('evidence.signing.privateKey', pem);
    }
    return crypto.createPrivateKey(pem);
  })().catch(error => { keyLoads.delete(vault); throw error; }));
  return keyLoads.get(vault);
}
function clean(value, secrets, key = '') {
  if (/^(password|authorization|cookie|privateKey|apiKey|accessToken|refreshToken|secret)$/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (typeof secret === 'string' && secret.length) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]');
  }
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(item => clean(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, secrets, k)]));
  return value ?? 'not captured';
}
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function safeArtifact(directory, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name)) throw new Error('Invalid artifact name');
  const file = path.join(directory, name);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Evidence symlink refused');
  return file;
}
function verifyPack(directory, trustedPublicKey) {
                                                                                                    
  if (!trustedPublicKey) throw new Error('Owner public key required');
  const bytes = fs.readFileSync(safeArtifact(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  const signature = fs.readFileSync(safeArtifact(directory, 'manifest.sig'));
  if (!crypto.verify(null, bytes, trustedPublicKey, signature)) throw new Error('Manifest signature mismatch');
  for (const [name, hash] of Object.entries(manifest.artifacts)) {
    if (sha256(fs.readFileSync(safeArtifact(directory, name))) !== hash) throw new Error('Artifact hash mismatch: ' + name);
  }
  return manifest;
}
class ProofGenerator {
  constructor(outputDir, options = {}) {
    this.outputDir = path.resolve(outputDir || path.join(process.cwd(), 'data', 'proofs'));
    this.options = options;
  }
  async generateDeliveryProof(data) {
    const key = this.options.signingKey || await ownerKey(this.options.vault);
    const captures = [];
    try {
      for (const capture of data.screenshots || []) {
        const file = path.resolve(capture.file);
        const root = path.resolve('data/captures') + path.sep;
        if (capture.reference !== data.orderId || !file.startsWith(root) || fs.lstatSync(file).isSymbolicLink())
          throw Error('Screenshot source or order reference does not match');
        const bytes = fs.readFileSync(file);
        if (bytes.length > 5*1024*1024 || sha256(bytes) !== capture.sha256 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a')
          throw Error('Screenshot integrity check failed');
        const {cropReceipt,receiptSpec}=require('./receipt-crop');
        captures.push({bytes, crop:cropReceipt(bytes,capture.receipt,receiptSpec(data,data.chunks))});
      }
    } catch (error) {
      throw require('./receipt-crop').forEvidenceReview(error);
    }
    const artifactId = crypto.randomUUID();
    const directory = path.join(this.outputDir, artifactId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const title = 'Delivery record generated by Autosell from captured messages';
    const scope = 'Internal record; no third-party attestation; not a screenshot.';
    const record = clean({
      schemaVersion: 1, title, scope, generatedAt: new Date().toISOString(),
      signatureStatus: key ? 'owner signed' : 'unsigned preview',
      orderId: data.orderId, buyerIgn: data.buyerIgn, amount: data.amount,
      amountMeaning: data.amountMeaning, recipientNet: data.recipientNet,
      holderIgn: data.sellerIgn, state: data.state, mode: data.mode,
      connection: data.connection?.length ? data.connection : 'not captured',
      preBalance: data.preBalance, postBalance: data.postBalance,
      capturedMessages: data.capturedChatLines?.length ? data.capturedChatLines : 'not captured',
      commands: data.commands?.length ? data.commands : 'not captured',
      chunks: data.chunks?.length ? data.chunks : 'not captured',
      ledgerRows: data.ledgerRows?.length ? data.ledgerRows : 'not captured',
      marketplaceTranscript: data.transcript?.length ? data.transcript : 'not captured',
      stateHistory: data.history?.length ? data.history : 'not captured',
      screenshot: data.screenshots?.length ? data.screenshots.map(({file,...capture})=>capture) : 'not captured',
      redaction: 'Known secret values and credential fields are replaced with [REDACTED]. Other captured text is preserved.',
    }, this.options.secrets || []);
    const artifacts = {};
    const write = (name, bytes) => {
      fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
      artifacts[name] = sha256(bytes);
    };
    for (const [index,{bytes,crop}] of captures.entries()) {
      write(index === 0 ? 'delivery-'+artifactId+'.png' : 'delivery-'+index+'-'+artifactId+'.png', bytes);
      if(index===0)write('receipt-'+artifactId+'.png',crop);
    }
    const json = JSON.stringify(record, null, 2);
    write('evidence.json', json);
                                                                            
                                                                               
    const events = Array.isArray(record.stateHistory) ? record.stateHistory : [];
    const log = [title, scope, 'Order: ' + record.orderId,
      'Recipient: ' + record.buyerIgn + ' | Ordered command amount: ' + record.amount,
      'Connection observations: ' + JSON.stringify(record.connection),
      'Integrity signature protects our records; it does not establish server authenticity.',
      ...events.filter(e => ['command','chat','CONNECTION','RECIPIENT_BALANCE','STATE','PAY_UNCERTAIN'].includes(e.kind)).map(e => {
        const parsed = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const stamp = Number.isFinite(e.wall_ms) ? new Date(e.wall_ms).toISOString() : 'not captured';
        return JSON.stringify({time:stamp,monotonicNs:e.monotonic_ns ?? 'not captured',kind:e.kind,data:parsed});
      })];
    write('console.txt', log.join('\n') + '\n');
                                                                              
                                                                    
    const customer = require('./customer-delivery-record').build(record, key);
    write('delivery-logs.txt', customer.text);
    write('delivery-record.json', customer.json);
    const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    write('record.html', '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Autosell delivery record</title><style>body{font:16px system-ui;margin:32px;color:#18202d}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>' + escape(title) + '</h1><p>' + escape(scope) + '</p><pre>' + escape(json) + '</pre>');
                                                                                                  
    const lines = json.replace(/[^\x20-\x7e\n]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
      .split('\n').flatMap(line => line.match(/.{1,110}/g) || ['']);
    const pages = Math.ceil(lines.length / 55);
    for (let page = 0; this.options.renderPages !== false && page < pages; page++) {
      const canvas = new BitmapCanvas(928, 1024);
      canvas.fill(248, 250, 252);
      canvas.drawText('AUTOSELL INTERNAL DELIVERY RECORD', 24, 24, [20, 35, 55], 2);
      canvas.drawText(scope, 24, 56, [50, 60, 75]);
      canvas.drawText('Page ' + (page + 1) + '/' + pages + ' | ' + record.signatureStatus, 24, 76, [50, 60, 75]);
      lines.slice(page * 55, (page + 1) * 55).forEach((line, i) => canvas.drawText(line, 24, 108 + i * 16, [20, 35, 55]));
      write('record-' + (page + 1) + '.png', canvas.toPngBuffer());
    }
    const publicKey = key ? crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) : null;
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1, artifactId, scope: 'Signature covers the integrity of owner records, not server authenticity or marketplace acceptance.',
      signed: Boolean(key), algorithm: key ? 'Ed25519' : null, publicKey, artifacts,
    }, null, 2));
    fs.writeFileSync(path.join(directory, 'manifest.json'), manifest, { mode: 0o600, flag: 'wx' });
    if (key) fs.writeFileSync(path.join(directory, 'manifest.sig'), crypto.sign(null, manifest, key), { mode: 0o600, flag: 'wx' });
    return { artifactId, directory, filePath: path.join(directory, this.options.renderPages === false ? 'delivery-logs.txt' : 'record-1.png'), signed: Boolean(key),
      publicKey, manifestHash: sha256(manifest), files: [...Object.keys(artifacts), 'manifest.json', ...(key ? ['manifest.sig'] : [])],
      screenshotCaptured: Boolean(data.screenshots?.length), chatImage:data.screenshots?.length?'receipt-'+artifactId+'.png':null, screenshotName:data.screenshots?.length?'delivery-'+artifactId+'.png':null, publicUrl: null };
  }
}
module.exports = { ProofGenerator, BitmapCanvas, generateProofToken, verifyProofToken, verifyPack, safeArtifact };
