'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OwnedCDPTransport,waitForOpen}=require('../../marketplace/browser/owned-cdp');
class Socket extends EventTarget{
  send(){}
  close(){this.dispatchEvent(new Event('close'));}
}
test('Chrome disconnect rejects pending protocol queries and clears attachment state immediately',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const socket=new Socket(),transport=new OwnedCDPTransport(socket);
  const pending=transport.query('Target.getTargets',{});transport.owned.add('fixture');socket.close();
  assert.equal(transport.internal.size,0);assert.equal(transport.owned.size,0);
  await assert.rejects(pending,/connection ended/);
});
test('sending a protocol command after close does not leak its callback',()=>{
  const socket=new Socket(),transport=new OwnedCDPTransport(socket);socket.close();
  assert.throws(()=>transport.command('Target.getTargets',{},()=>{}),/connection ended/);
  assert.equal(transport.internal.size,0);
});
test('closing a tab during attachment rejects its pending Playwright request',()=>{
  const transport=new OwnedCDPTransport(new Socket()),messages=[];transport.onmessage=value=>messages.push(value);
  transport.replies.set('fixture',{id:15,result:{targetId:'fixture'}});
  transport.receive({method:'Target.targetDestroyed',params:{targetId:'fixture'}});
  assert.equal(messages[0].id,15);assert.match(messages[0].error.message,/tab closed/);
  assert.equal(transport.replies.size,0);
});
test('Chrome approval refusal is surfaced immediately rather than waiting for a timeout',async()=>{
  const socket=new Socket(),pending=waitForOpen(socket,1000);socket.close();
  await assert.rejects(pending,/declined/);
});
test('Chrome approval respects the connection deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const socket=new Socket(),pending=waitForOpen(socket,100);
  t.mock.timers.tick(100);await assert.rejects(pending,/connection timeout/);
});
