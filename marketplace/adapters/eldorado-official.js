'use strict';
const { MarketplaceAdapter } = require('../adapter-interface');
const services = require('../../services');
const http = require('../../api/http-client');
const emptyContract = require('../contract/eldorado.json');
const { field, missing, requireContract, normalizeOrder, digest } = require('../contract/runtime');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class EldoradoOfficialAdapter extends MarketplaceAdapter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.contract = structuredClone(options.contract || services.settings?.getSync?.('eldorado.contract') || emptyContract);
    this.mode = options.mode || 'live';
    if (this.mode === 'mock' && !options.transport) throw new Error('Mock mode requires an isolated transport');
    this.transport = options.transport || http;
    this.vault = options.vault || services.vault;
    this.auth = new(require('../seller-auth').SellerAuth)(this.contract,this.vault,this.transport);
    this.tail = Promise.resolve(); this.nextRequest = 0;
    for (const key of Object.keys(this.capabilities)) this.capabilities[key] = !missing(this.contract, key).length && (!this.contract.synthetic || this.mode === 'mock');
    this.capabilities.sendMessage = false;
    this.capabilities.subscribeOrders = false;
  }
  status() {
    return { contractHash: digest(this.contract), synthetic: Boolean(this.contract.synthetic), capabilities: this.capabilities,
      missing: Object.fromEntries(['listOrders','getOrder','createOffer','updateOffer','pauseOffer','markDelivered','cancelOrder'].map(op => [op, missing(this.contract, op)])),
      chat: 'manual-inbox' };
  }
  normalizeOrder(data) { return normalizeOrder(data, this.contract); }
  normalizeObservation(data) { return require('../contract/runtime').normalizeObservation(data,this.contract); }
  async authenticate() {
    requireContract(this.contract, 'listOrders', this.mode);
    const key = await this.auth.credential();
    if (!key) throw new Error('Marketplace credential missing from owner vault');
    return { credentialPresent: true, remotelyValidated: false };
  }
  async refreshAuth() { requireContract(this.contract,'listOrders',this.mode);this.auth.token=null;return {credentialPresent:Boolean(await this.auth.credential())}; }
  async invoke(name, input = {}, cursor) {
    const operation = requireContract(this.contract, name, this.mode);
    const read = ['listOrders', 'getOrder', 'listOffers', 'getOffer','getSellerIdentity','listCompetitorOffers'].includes(name) && operation.method === 'GET';
    if ((this.mode === 'record' || this.mode === 'read-only') && !read) throw new Error('Read-only adapter refuses mutations');
    if (this.mode !== 'mock') {
      const rollout = this.options.rollout || services.rollout;
      if (!rollout) throw new Error('Rollout controller unavailable');
      await rollout.authorize(read ? 'read' : name);
    }
                                                                              
    const execute = async () => {
      const wait = this.nextRequest - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.nextRequest = Date.now() + this.contract.rateLimit.minIntervalMs;
      let endpoint = operation.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
        if (input[key] === undefined) throw new Error('Missing endpoint argument: ' + key);
        return encodeURIComponent(String(input[key]));
      });
      const url = new URL(endpoint, this.contract.baseUrl);
      if (url.origin !== new URL(this.contract.baseUrl).origin) throw new Error('Endpoint escaped documented origin');
      const pagination=operation.pagination || this.contract.pagination;
      if (cursor !== undefined) url.searchParams.set(pagination.queryField, String(cursor));
      if(input.__paginationIndex!==undefined){url.searchParams.set(pagination.queryField,String(input.__paginationIndex));url.searchParams.set(pagination.sizeField,String(input.__paginationSize));}
      for(const [remote,canonical] of Object.entries(operation.query||{})){
        if(input[canonical]===undefined)throw Error('Missing query argument: '+canonical);
        url.searchParams.set(remote,String(input[canonical]));
      }
      const credential = await this.auth.credential();
      if (!credential) throw new Error('Marketplace credential missing from vault');
      if (this.mode !== 'mock') await (this.options.rollout || services.rollout).authorize(read ? 'read' : name);
      const headers = { [this.contract.auth.header]: this.contract.auth.prefix + credential };
      let body;
      if (operation.method !== 'GET') {
        body = { ...(operation.constants || {}) };
        for (const [remote, canonical] of Object.entries(operation.body || {})) {
          if (['__proto__','constructor','prototype'].includes(remote)) throw new Error('Unsafe contract field');
          if (input[canonical] === undefined) throw new Error('Missing request field: ' + canonical);
          body[remote] = input[canonical];
        }
        headers['Content-Type'] = 'application/json';
      }
      let response = await this.transport.request(url.href, { method: operation.method, headers, body: body ? JSON.stringify(body) : undefined });
                                                                              
      if(response.status===401&&read&&this.contract.auth.kind==='clientCredentials'){
        this.auth.invalidate(credential);headers[this.contract.auth.header]=this.contract.auth.prefix+await this.auth.credential();
        response=await this.transport.request(url.href,{method:operation.method,headers});
      }
      if (!operation.successStatuses.includes(response.status)) {
        const error = new Error('Marketplace HTTP ' + response.status + ' for ' + name + '; outcome may require reconciliation');
        error.status = response.status;
        if (response.status === 429) this.nextRequest = Math.max(this.nextRequest, Date.now() + this.contract.rateLimit.minIntervalMs);
        throw error;
      }
      const data = operation.responsePointer === null ? null : await response.json();
      if (this.mode === 'record') {
        if (!this.options.recordDir) throw new Error('Record directory required');
        fs.mkdirSync(this.options.recordDir, { recursive: true, mode: 0o700 });
                                                                                                           
        const scrub = (value, key = '') => /token|secret|password|cookie|authorization/i.test(key) ? '[REDACTED]' :
          typeof value === 'string' ? value.split(credential).join('[REDACTED]') :
          Array.isArray(value) ? value.map(v => scrub(v)) :
          value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,scrub(v,k)])) : value;
        fs.writeFileSync(path.join(this.options.recordDir, crypto.randomUUID() + '.json'), JSON.stringify({
          contractHash: digest(this.contract), operation: name, status: response.status, capturedAt: new Date().toISOString(), response: scrub(data),
        }, null, 2), { mode: 0o600, flag: 'wx' });
      }
      return { data: operation.responsePointer === null ? null : field(data, operation.responsePointer), raw: data };
    };
    const pending = this.tail.then(execute);
    this.tail = pending.catch(() => {});
    return pending;
  }
  async listCollection(name,input={}) {
    const rows = []; let cursor; const seen = new Set();
    const operation=requireContract(this.contract,name,this.mode);
    const pagination=operation.pagination || (name==='listOrders'?this.contract.pagination:{kind:'none',maxPages:1});
    if(!['none','cursor','page','offset'].includes(pagination.kind))throw Error('Unsupported pagination kind');
    const maximum=pagination.maxPages||1;
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>1000)throw Error('Invalid pagination bound');
    if(['page','offset'].includes(pagination.kind) && (!Number.isSafeInteger(pagination.start)||pagination.start<0||!Number.isSafeInteger(pagination.pageSize)||pagination.pageSize<1||!pagination.queryField||!pagination.sizeField))throw Error('Page pagination needs documented query fields, start and page size');
    for (let page = 0; page < maximum; page++) {
      const query={...input};
      if(['page','offset'].includes(pagination.kind)){
        query.__paginationIndex=pagination.start+page*(pagination.kind==='offset'?pagination.pageSize:1);
        query.__paginationSize=pagination.pageSize;
      }
      const result = await this.invoke(name, query, cursor);
      if (!Array.isArray(result.data)) throw new Error('Collection response violates documented array mapping');
      rows.push(...result.data);
      if (pagination.kind === 'none') return rows;
      if(['page','offset'].includes(pagination.kind)){
        if(pagination.totalPointer){const total=field(result.raw,pagination.totalPointer);if(!Number.isSafeInteger(total)||total<0)throw Error('Invalid collection total');if(rows.length>=total)return rows;}
        else if(pagination.hasMorePointer){const more=field(result.raw,pagination.hasMorePointer);if(typeof more!=='boolean')throw Error('Invalid collection continuation');if(!more)return rows;}
        else if(pagination.stopOnShortPage===true){if(result.data.length<pagination.pageSize)return rows;}
        else throw Error('Page pagination needs its documented completion rule');
        if(!result.data.length)throw Error('Empty page before the documented collection end');
        continue;
      }
      cursor = field(result.raw, pagination.nextPointer);
      if (cursor === null || cursor === '') return rows;
      if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('Invalid or repeated pagination cursor');
      seen.add(cursor);
    }
    throw new Error('Pagination bound reached; response incomplete');
  }
  async listOrders() { return this.listCollection('listOrders'); }
  async getOrder(id) { return (await this.invoke('getOrder', { id })).data; }
  async listOffers() { return this.listCollection('listOffers'); }
  async getOffer(id) { return (await this.invoke('getOffer', { id })).data; }
  async createOffer(offer) { return (await this.invoke('createOffer', offer)).data; }
  async updateOffer(id, updates) { return (await this.invoke('updateOffer', { ...updates, id })).data; }
  async pauseOffer(id) { return (await this.invoke('pauseOffer', { id })).data; }
  async resumeOffer(id) { return (await this.invoke('resumeOffer', { id })).data; }
  async setStock(id, quantity) { return this.updateOffer(id, { quantity }); }
  async markDelivered(id) { return (await this.invoke('markDelivered', { id })).data; }
  async cancelOrder(id, reason) { return (await this.invoke('cancelOrder', { id, reason })).data; }
  async deleteOffer(id) { return (await this.invoke('deleteOffer', {id})).data; }
  async listCompetitorOffers(input) { return this.listCollection('listCompetitorOffers',input); }
  async sendMessage() { throw new Error('No documented chat API: use the local operator inbox'); }
  async testConnection() {
    try { await this.listOrders(); return { success: true, operation: 'listOrders', contractHash: digest(this.contract) }; }
    catch (error) { return { success: false, error: error.message }; }
  }
  async healthCheck() { const result = await this.testConnection(); return { ok: result.success, details: result.error || 'Read operation completed' }; }
}
module.exports = { EldoradoOfficialAdapter };
