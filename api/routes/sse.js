'use strict';

const express = require('express');
const router = express.Router();
const services = require('../../services');

const clients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {}
  }
}

                               
function bindServiceEvents() {
  if (services.pairManager) {
    services.pairManager.on('balanceUpdated', (d) => broadcastEvent('pair:balance', d));
    services.pairManager.on('pairLocked', (d) => broadcastEvent('pair:locked', d));
    services.pairManager.on('pairReleased', (d) => broadcastEvent('pair:released', d));
    services.pairManager.on('thresholdReached', (d) => broadcastEvent('pair:ready', d));
    services.pairManager.on('orderQueued', (d) => broadcastEvent('order:queued', d));
    services.pairManager.on('pairsUpdated', (d) => broadcastEvent('pairs:list', d));
  }

  if (services.events) {
    services.events.on('marketplace:new_order', (d) => broadcastEvent('marketplace:order', d));
    services.events.on('marketplace:delivered', (d) => broadcastEvent('marketplace:delivered', d));
  }
}

                                                             
bindServiceEvents();
process.nextTick(bindServiceEvents);

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

                            
  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

module.exports = router;
module.exports.broadcastEvent = broadcastEvent;
