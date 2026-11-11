'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDashboardSellerIdentity } = require('../../marketplace/browser/playwright-session');

for (const [name, url, title] of [
  ['OAuth login', 'https://login.eldorado.gg/oauth2/authorize', 'Sign in'],
  ['Cloudflare verification', 'https://www.eldorado.gg/dashboard/offers/Currency', 'Just a moment...']
]) test('connection checks leave ' + name + ' open without restarting navigation', async () => {
  let navigated = false;
  const page = { url: () => url, title: async () => title, goto: async () => { navigated = true; } };
  await assert.rejects(readDashboardSellerIdentity(page, 100), /Finish the sign-in or security verification/);
  assert.equal(navigated, false);
});

test('a signed-in dashboard still verifies the exact seller identity', async () => {
  const page = {
    url: () => 'https://www.eldorado.gg/dashboard/orders/sold', title: async () => 'Sold Orders | Eldorado.gg',
    locator: () => ({ first: () => ({ waitFor: async () => {} }), evaluateAll: async () => ['https://www.eldorado.gg/users/FixtureSeller'] })
  };
  assert.equal((await readDashboardSellerIdentity(page, 100)).sellerHref, 'https://www.eldorado.gg/users/FixtureSeller');
});
