'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SellStore = require('../../sell/store');

test('Member Lookup handles a runtime without the optional legacy autobuy module', () => {
  const store = new SellStore();
  store.sellersRepo = { getAllSellers: () => [], getSeller: () => null };
  store.ordersRepo = { getAllOrders: () => [] }; store.salesRepo = { list: () => [] };
  assert.deepEqual(store.listUserDataSummaries(), []);
  assert.deepEqual(store.lifetimeIgns('fixture-member'), []);
});

test('member history retains actual ordinary sales when optional autobuy history is absent', () => {
  const store = new SellStore();
  store.sellersRepo = { getAllSellers: () => [], getSeller: () => null };
  store.ordersRepo = { getAllOrders: () => [] };
  store.salesRepo = { list: () => [{ discordId: 'fixture-member', ign: 'FixtureIGN', createdAt: '2026-10-18T00:00:00Z' }] };
  assert.deepEqual(store._allUserIds(), ['fixture-member']);
  assert.equal(store.lifetimeIgns('fixture-member')[0].ign, 'FixtureIGN');
});
