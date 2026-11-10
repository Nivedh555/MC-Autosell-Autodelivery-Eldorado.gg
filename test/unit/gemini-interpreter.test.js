'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../db/database');
const {ChatInterpreter, configuration, requestModel, suggestion, SCHEMA} = require('../../marketplace/chat-interpreter');

const input = {orderId:'gemini-order',messageId:'gemini-message',text:'the account u need is BuyerOne pls',ruleIntent:'off_topic'};
const candidate = {intent:'PROVIDE_IGN',username:'BuyerOne',confidence:'high'};
const config = (provider = 'gemini') => ({mode:'suggest',provider,model:'fixture-model',key:'fixture-secret'});
const complete = (value = candidate) => ({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:JSON.stringify(value)}]}}]});
const response = body => new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json'}});

async function fixture(t, fetchImpl, options = {}) {
  const db = await Database.open(':memory:');
  t.after(() => db.close());
  const engine = new ChatInterpreter({db:db.raw(),config:() => config(),request:args => requestModel({...args,fetchImpl}),...options});
  return {db,engine};
}

test('Gemini generateContent uses header authentication and a single bounded schema-only request', async () => {
  let sent;
  const controller = new AbortController();
  const result = await requestModel({text:input.text,config:config(),signal:controller.signal,fetchImpl:async (url, options) => {
    sent = {url,options,body:JSON.parse(options.body)};
    return response(complete());
  }});
  assert.deepEqual(result,candidate);
  const url = new URL(sent.url);
  assert.equal(url.origin,'https://generativelanguage.googleapis.com');
  assert.equal(url.pathname,'/v1beta/models/fixture-model:generateContent');
  assert.equal(url.search,'');
  assert.equal(sent.options.method,'POST');
  assert.equal(sent.options.redirect,'error');
  assert.equal(sent.options.signal,controller.signal);
  const headers = new Headers(sent.options.headers);
  assert.equal(headers.get('x-goog-api-key'),'fixture-secret');
  assert.equal(headers.get('Authorization'),null);
  assert.equal(headers.get('Content-Type'),'application/json');
  assert.equal(sent.body.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(sent.body.generationConfig.responseJsonSchema,SCHEMA);
  assert.equal(sent.body.generationConfig.responseJsonSchema.additionalProperties,false);
  assert.equal(sent.body.tools,undefined);
  assert.equal(sent.body.toolConfig,undefined);
  assert.equal(sent.body.contents.length,1);
  assert.equal(sent.body.contents[0].role,'user');
  assert.equal(sent.body.contents[0].parts.length,1);
  assert.deepEqual(JSON.parse(sent.body.contents[0].parts[0].text),{buyer_message:input.text});
  assert.ok(sent.body.systemInstruction.parts[0].text.length > 0);
  const serialized = JSON.stringify(sent.body);
  assert.equal(serialized.includes(input.orderId),false);
  assert.equal(serialized.includes(input.messageId),false);
  assert.equal(serialized.includes('fixture-secret'),false);
});

test('Gemini configuration validates provider explicitly and preserves legacy OpenAI selection', () => {
  const gemini = configuration({AUTOSELL_CHAT_AI_MODE:'shadow',AUTOSELL_CHAT_AI_PROVIDER:'gemini',AUTOSELL_CHAT_AI_MODEL:'fixture-model',AUTOSELL_CHAT_AI_API_KEY:'fixture-secret'});
  assert.deepEqual(gemini,{mode:'shadow',provider:'gemini',model:'fixture-model',key:'fixture-secret'});
  assert.equal(configuration({AUTOSELL_CHAT_AI_PROVIDER:'gemini'}).model,'gemini-3.5-flash-lite');
  assert.equal(configuration({AUTOSELL_CHAT_AI_MODE:'shadow',AUTOSELL_CHAT_AI_MODEL:'fixture-model',AUTOSELL_CHAT_AI_API_KEY:'fixture-secret'}).provider,'openai');
  assert.throws(() => configuration({AUTOSELL_CHAT_AI_PROVIDER:'unrecognized-provider'}),/provider/i);
  assert.throws(() => configuration({AUTOSELL_CHAT_AI_PROVIDER:'gemini',AUTOSELL_CHAT_AI_MODEL:'model?key=unsafe'}),/model/i);
});

test('Gemini schema-shaped output is still checked locally before persisting or suggesting', async t => {
  for (const [name, value] of [
    ['extra money field',{...candidate,amount:'1000000'}],
    ['invented username',{...candidate,username:'InventedName'}],
    ['partial username',{...candidate,username:'Buyer'}],
    ['confirmation with a username',{...candidate,intent:'CONFIRM'}],
    ['numeric confidence',{...candidate,confidence:1}],
    ['missing username',{intent:'PROVIDE_IGN',confidence:'high'}],
    ['unexpected intent',{...candidate,intent:'EXECUTE_PAYMENT'}],
    ['array result',[candidate]]
  ]) {
    await t.test(name,async t => {
      const {db,engine} = await fixture(t,async () => response(complete(value)));
      assert.equal(await engine.interpret(input),null);
      const row = db.raw().prepare('SELECT state,result,reason FROM chat_interpretations').get();
      assert.equal(row.state,'UNAVAILABLE');
      assert.equal(row.result,null);
      assert.equal(row.reason,'AI_INVALID_OR_UNAVAILABLE');
    });
  }
});

test('Gemini prompt and candidate refusals, incomplete output and malformed envelopes fail closed', async t => {
  for (const [name, body] of [
    ['blocked prompt',{promptFeedback:{blockReason:'SAFETY'}}],
    ['blocked prompt with apparent output',{...complete(),promptFeedback:{blockReason:'SAFETY'}}],
    ['safety finish',{candidates:[{...complete().candidates[0],finishReason:'SAFETY'}]}],
    ['token limit',{candidates:[{...complete().candidates[0],finishReason:'MAX_TOKENS'}]}],
    ['missing finish reason',{candidates:[{content:complete().candidates[0].content}]}],
    ['no candidates',{candidates:[]}],
    ['multiple candidates',{candidates:[...complete().candidates,...complete().candidates]}],
    ['no parts',{candidates:[{finishReason:'STOP',content:{parts:[]}}]}],
    ['multiple text parts',{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(candidate)},{text:'{}'}]}}]}],
    ['tool call',{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'pay',args:{amount:'1000000'}}}]}}]}],
    ['text mixed with a tool call',{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(candidate)},{functionCall:{name:'pay',args:{amount:'1000000'}}}]}}]}],
    ['malformed output JSON',{candidates:[{finishReason:'STOP',content:{parts:[{text:'{"intent":'}]}}]}],
    ['malformed envelope',null]
  ]) {
    await t.test(name,async t => {
      let calls = 0;
      const {db,engine} = await fixture(t,async url => {
        calls++;
        assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
        return response(body);
      });
      assert.equal(await engine.interpret(input),null);
      assert.equal(calls,1);
      const row = db.raw().prepare('SELECT state,result,reason FROM chat_interpretations').get();
      assert.equal(row.state,'UNAVAILABLE');
      assert.equal(row.result,null);
      assert.match(row.reason,/^AI_/);
    });
  }
});

test('Gemini failure persists only a sanitized reason and never falls back to OpenAI', async t => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
    return new Response('fixture-secret raw provider error body',{status:429});
  };
  const {db,engine} = await fixture(t,fetchImpl);
  assert.equal(await engine.interpret(input),null);
  const row = db.raw().prepare('SELECT * FROM chat_interpretations').get();
  assert.equal(row.reason,'AI_HTTP_429');
  assert.equal(JSON.stringify(row).includes('fixture-secret'),false);
  assert.equal(JSON.stringify(row).includes('raw provider error body'),false);
  assert.equal(await engine.interpret({...input,messageId:'during-cooldown'}),null);
  const restarted = new ChatInterpreter({db:db.raw(),config:() => config(),request:args => requestModel({...args,fetchImpl})});
  assert.equal(await restarted.interpret(input),null);
  assert.equal(calls,1);
});

test('Gemini response size limit is enforced before JSON is parsed', async t => {
  const {db,engine} = await fixture(t,async () => response(complete({...candidate,unused:'x'.repeat(32768)})));
  assert.equal(await engine.interpret(input),null);
  const row = db.raw().prepare('SELECT state,reason FROM chat_interpretations').get();
  assert.equal(row.state,'UNAVAILABLE');
  assert.equal(row.reason,'AI_RESPONSE_TOO_LARGE');
});

test('decision cache identity includes provider even when message and model are identical', async t => {
  let currentProvider = 'openai', calls = 0;
  const {db,engine} = await fixture(t,async () => {throw Error('Unused transport');},{
    config:() => config(currentProvider),
    request:async () => {calls++;return candidate;}
  });
  const openai = await engine.interpret(input);
  assert.equal(openai.cached,false);
  currentProvider = 'gemini';
  assert.equal(engine.status().provider,'gemini');
  assert.equal(JSON.stringify(engine.status()).includes('fixture-secret'),false);
  const gemini = await engine.interpret(input);
  assert.equal(gemini.cached,false);
  assert.equal(calls,2);
  assert.equal(db.raw().prepare('SELECT count(*) n FROM chat_interpretations').get().n,2);
  const restarted = new ChatInterpreter({db:db.raw(),config:() => config(),request:async () => {calls++;throw Error('Cached result must survive restart');}});
  const cached = await restarted.interpret(input);
  assert.equal(cached.cached,true);
  assert.equal(cached.moneyActionsAllowed,false);
  assert.match(suggestion(cached),/reply "ign: BuyerOne"/);
  assert.equal(calls,2);
});

test('existing injected configs without provider continue to use the OpenAI Responses API', async () => {
  const legacyConfig = {mode:'shadow',model:'fixture-model',key:'fixture-secret'};
  let sent;
  const result = await requestModel({text:input.text,config:legacyConfig,fetchImpl:async (url, options) => {
    sent = {url,options,body:JSON.parse(options.body)};
    return response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(candidate)}]}]});
  }});
  assert.deepEqual(result,candidate);
  assert.equal(sent.url,'https://api.openai.com/v1/responses');
  assert.equal(new Headers(sent.options.headers).get('Authorization'),'Bearer fixture-secret');
  assert.equal(sent.body.text.format.strict,true);
  assert.equal(sent.body.store,false);
});
