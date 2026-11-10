'use strict';

                                              
const events = new (require('events').EventEmitter)();
const services = {
  events,
  settings: {
    getSync: (id) => {
      if (id === 'session.mode') return 'on_demand';
      if (id === 'mc.buyer1.email') return 'test1@example.com';
      if (id === 'mc.buyer2.email') return 'test2@example.com';
      if (id === 'session.lease.durationMs') return 1000;
      if (id === 'mc.server.reconnectDelayMs') return 100;
      return null;
    }
  },
  logger: {
    warn: console.log,
    error: console.error
  },
  config: { mc: { host: 'localhost' } }
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(mod) {
  if (mod === '../services' || mod === '../../services') return services;
  if (mod === 'mineflayer') return { createBot: () => ({ on: ()=>{}, once: ()=>{} }) };
  if (mod === 'mineflayer-pathfinder') return { pathfinder: {}, Movements: class {}, goals: {} };
  return originalRequire.call(this, mod);
};

const assert = require('assert');
const sessionManager = require('./session-manager');

async function run() {
  console.log('Testing session manager on_demand mode...');
  assert.strictEqual(sessionManager.getState('buyer1'), 'DISCONNECTED');
  
                  
  const lease = await sessionManager.acquire('buyer1', 'test sale', { ttlMs: 1500 });
  assert.strictEqual(sessionManager.getState('buyer1'), 'CONNECTING');
  assert.strictEqual(sessionManager.clients.has('buyer1'), true);
  
               
  const client = sessionManager.getClient('buyer1');
  client.bot = { chat: () => {}, on: () => {}, once: () => {}, swingArm: () => {}, end: () => {} };            
  client.state = 'idle';
  client.emit('spawn');
  
  await lease.ready();
  console.log('Lease ready.');
  assert.strictEqual(sessionManager.getState('buyer1'), 'READY');
  
                      
  await new Promise(r => setTimeout(r, 1600));
  sessionManager._checkExpirations();
  
  assert.strictEqual(lease.isValid(), false);
  console.log('Lease expired.');
  
                                                
  assert.strictEqual(sessionManager.getState('buyer1'), 'IDLE_GRACE');
  
                          
  await new Promise(r => setTimeout(r, 1200));
  
  assert.strictEqual(sessionManager.getState('buyer1'), 'DISCONNECTED');
  assert.strictEqual(client.isOnline(), false);
  console.log('Client successfully disconnected after idle grace. Zero connections while idle verified.');
  
  process.exit(0);
}

run().catch(console.error);
