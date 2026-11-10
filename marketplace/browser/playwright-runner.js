'use strict';
const { reads, requireProfile } = require('./profile');
const { setTimeout: delay } = require('node:timers/promises');

                                                                                
                                                                          
class PlaywrightRunner {
  constructor(page, options = {}) { this.page = page; this.options = options; }
  alive(profile, url) {
    this.options.check?.();
    if (this.page.isClosed() || this.page.url() !== url || new URL(url).origin !== profile.origin) throw Error('Controlled seller page changed or closed; outcome unknown');
  }
  async node(selector, scope = this.page) {
    if (typeof selector !== 'string' || !selector || selector.length > 500) throw Error('Missing or oversized observed selector');
    const node = scope.locator(selector);
    if (await node.count() !== 1 || !await node.isVisible()) throw Error('Observed selector is missing, hidden or ambiguous');
    const unsafe = await node.evaluate(n => Boolean(n.closest('[hidden],[aria-hidden="true"]') || ['password','hidden','file'].includes(n.type)));
    if (unsafe) throw Error('Hidden/password/file controls cannot be used');
    return node;
  }
  async text(rule, scope = this.page) {
    const node = await this.node(rule.selector, scope);
    if (rule.attribute && !/^(href|title|aria-[a-z-]+|data-[a-z0-9-]+)$/.test(rule.attribute)) throw Error('Sensitive or unsupported field attribute');
    let value = rule.attribute ? await node.getAttribute(rule.attribute) : await node.textContent();
    if (value == null || value.length > 10000) throw Error('Observed field missing or oversized');
    value = value.trim();
    if (rule.transform) {
      const { kind, suffix = '' } = rule.transform;
      if (suffix) { if (!value.endsWith(suffix)) throw Error('Displayed unit suffix changed'); value = value.slice(0,-suffix.length).trim(); }
      if (kind === 'url-id') {
        const url = new URL(value, this.page.url());
        if (url.origin !== new URL(this.page.url()).origin) throw Error('Cross-origin identity link');
        value = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
      } else if (['integer','decimal'].includes(kind)) {
        if (value.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) throw Error('Ambiguous numeric grouping');
        value = value.replaceAll(',','');
        if (!(kind === 'integer' ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(value)) throw Error('Displayed numeric format changed');
      } else if (kind !== 'text') throw Error('Unsupported observed transform');
    }
    return value;
  }
  async check(rule, args = {}) {
    const expected = rule?.param ? args[rule.param] : rule?.value;
    if (expected === undefined || await this.text(rule) !== String(expected)) throw Error('Seller identity, resource or state does not match reviewed guard');
  }
  async ensure(profile, url) { this.alive(profile,url); await this.check(profile.accountIdentity); this.alive(profile,url); }
  async waitFor(profile, url, callback) {
    const deadline = Date.now() + profile.pacing.timeoutMs;
    for (;;) {
      await this.ensure(profile,url);
      try { await callback(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
      await delay(Math.min(150,Math.max(1,deadline-Date.now())));
    }
  }
  async read(result) {
    if (!result || !['object','list'].includes(result.kind) || !result.fields) throw Error('Missing reviewed result mapping');
    const extract = async scope => {
      const data = {};
      for (const [key,rule] of Object.entries(result.fields)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) throw Error('Invalid mapped field');
        data[key] = await this.text(rule,scope);
      }
      return data;
    };
    if (result.kind === 'object') return extract(this.page);
    if (typeof result.rows !== 'string' || !result.rows || result.rows.length > 500) throw Error('Missing observed row selector');
    const rows = this.page.locator(result.rows), count = await rows.count();
    if (count > 500) throw Error('Observed page exceeds bounded row count');
    const output = [];
    for (let i=0;i<count;i++) { this.options.check?.(); output.push(await extract(rows.nth(i))); }
    return output;
  }
  async run(profile, operation, args = {}, preview = false) {
    if (preview && (!reads.has(operation) || profile?.operations?.[operation]?.steps?.length)) throw Error('Preview is read-only');
    const op = requireProfile(profile,operation,this.options.mode || 'live');
    const target = new URL(op.url.replaceAll('{id}',encodeURIComponent(args.id || '')),profile.origin);
    if (target.origin !== profile.origin || target.username || target.password || target.hash || [...target.searchParams.keys()].some(k=>/token|password|secret|auth|code|key/i.test(k))) throw Error('Unsupported operation URL');
    this.options.check?.();
    if (this.page.url() !== target.href) await this.page.goto(target.href,{waitUntil:'domcontentloaded',timeout:profile.pacing.timeoutMs});
                                                                             
    const url = target.href;
    await this.waitFor(profile,url,async()=>{ await this.check(op.ready,args); await this.check(op.complete,args); });
    const before = op.newResultId ? await this.read(op.result) : null;
    for (const rule of op.preconditions || []) await this.check(rule,args);
    if (op.guard) await this.check(op.guard,args);
    for (const step of op.steps || []) {
      await delay(profile.pacing.actionMs);
      await this.ensure(profile,url); await this.check(op.guard,args);
      const node = await this.node(step.selector);
      if (!await node.isEnabled()) throw Error('Reviewed control is disabled');
      if (step.kind === 'fill') {
        const value = args[step.param];
        if (value === undefined || String(value).length > 4000 || !await node.evaluate(n=>['INPUT','TEXTAREA'].includes(n.tagName))) throw Error('Unsupported mapped input');
        await this.ensure(profile,url); await this.check(op.guard,args);
        await node.fill('',{timeout:profile.pacing.timeoutMs});
                                                                                    
        for (const character of String(value)) {
          await this.ensure(profile,url);
          await node.pressSequentially(character,{delay:profile.pacing.characterMs,timeout:profile.pacing.timeoutMs});
        }
        if (await node.inputValue() !== String(value)) throw Error('Input did not retain the exact planned value');
      } else if (step.kind === 'click') {
        if (typeof step.text !== 'string' || (await node.textContent()).trim() !== step.text) throw Error('Reviewed button label changed');
        await this.ensure(profile,url); await this.check(op.guard,args);
                                                                                      
        for (const rule of step.preconditions || op.preconditions || []) await this.check(rule,args);
        this.options.check?.();
        await node.click({timeout:profile.pacing.timeoutMs});
      } else throw Error('Unsupported step; arbitrary scripts are prohibited');
    }
    if (op.steps?.length) {
      try { await this.waitFor(profile,url,()=>this.check(op.after,args)); }
      catch (error) { throw Error('Mutation confirmation unavailable; outcome unknown: '+error.message); }
    }
    const data = await this.read(op.result);
    await this.ensure(profile,url);
    if (op.newResultId && (!data.id || data.id === before.id)) throw Error('No new remote result identifier; outcome unknown');
    return {data,observation:{url,observedMs:Date.now(),operation,identity:profile.accountIdentity.value},...(preview?{verified:false,liveUnlocked:false}:{} )};
  }
}
module.exports = { PlaywrightRunner };
