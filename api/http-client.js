'use strict';
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');

class HttpClient {
  constructor() {
    this.defaultAllowed = ['eldorado.gg','www.eldorado.gg','discord.com', 'discordapp.com', 'api.blockcypher.com', 'litecoinspace.org', 'api.coingecko.com', 'api.coinbase.com', 'login.live.com', 'user.auth.xboxlive.com', 'xsts.auth.xboxlive.com', 'api.minecraftservices.com'];
  }
  getAllowedHosts() {
    const services = require('../services');
    const custom = services.settings?.getSync?.('network.allowedHosts') || [];
    return [...this.defaultAllowed, ...(Array.isArray(custom) ? custom : [])];
  }
  isPrivateIP(ip) {
    if (net.isIP(ip) === 4) {
      const [a,b] = ip.split('.').map(Number);
      return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && [0,168].includes(b)) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0);
    }
                                                                                        
    return net.isIP(ip) !== 6 || !/^[23][0-9a-f]{3}:/i.test(ip) || /^2001:(db8|0):/i.test(ip);
  }
  async resolveAllowed(urlString) {
    const url = new URL(urlString);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !this.getAllowedHosts().includes(url.hostname)) throw new Error('URL is not explicitly allow-listed HTTPS');
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => this.isPrivateIP(a.address))) throw new Error('Host resolves to prohibited address');
    return { url, address: addresses[0], addresses };
  }
  async isAllowed(url) { try { await this.resolveAllowed(url); return true; } catch { return false; } }
  async request(urlString, options = {}) {
    const timeout = options.timeout ?? 10000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('HTTP timeout must be positive');
    const started = Date.now();
    const method = (options.method || 'GET').toUpperCase();
    const readOnly = ['GET', 'HEAD'].includes(method);
    let dnsTimer;
    let target;
    try {
      target = await Promise.race([
        this.resolveAllowed(urlString),
        new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS resolution timed out; request was not sent')), timeout); }),
      ]);
    } finally { clearTimeout(dnsTimer); }
    const { url, addresses } = target;
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0) throw new Error('DNS resolution timed out; request was not sent');
    return new Promise((resolve, reject) => {
                                                                                          
      const req = https.request(url, {
        method, headers: options.headers || {}, agent: false,
        autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
        lookup: (_host, opts, cb) => opts.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family),
      }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > (options.maxResponseBytes ?? 2 * 1024 * 1024)) return req.destroy(new Error('Response exceeds limit'));
          chunks.push(chunk);
        });
        res.on('error', error => { clearTimeout(timer); reject(error); });
        res.on('aborted', () => { clearTimeout(timer); reject(new Error(readOnly ? 'HTTP read interrupted' : 'HTTP response interrupted: outcome may be unknown')); });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode >= 300 && res.statusCode < 400) return reject(new Error('Redirects are prohibited'));
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
            headers: new Headers(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)])),
            text: async () => body, json: async () => JSON.parse(body) });
        });
      });
      const timer = setTimeout(() => req.destroy(new Error(readOnly ? 'HTTP read timed out' : 'HTTP timeout: outcome may be unknown')), remaining);
      req.once('error', error => { clearTimeout(timer); reject(error); });
                                                       
      if (options.body) req.write(options.body);
      req.end();
    });
  }
  get(url, options) { return this.request(url, { ...options, method: 'GET' }); }
  post(url, body, options) { return this.request(url, { ...options, method: 'POST', body: JSON.stringify(body), headers: { ...options?.headers, 'Content-Type': 'application/json' } }); }
  put(url, body, options) { return this.request(url, { ...options, method: 'PUT', body: JSON.stringify(body), headers: { ...options?.headers, 'Content-Type': 'application/json' } }); }
}
module.exports = new HttpClient();
module.exports.HttpClient = HttpClient;
