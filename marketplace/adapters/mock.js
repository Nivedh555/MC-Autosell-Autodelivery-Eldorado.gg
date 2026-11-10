'use strict';

const { MarketplaceAdapter } = require('../adapter-interface');

class MockAdapter extends MarketplaceAdapter {
  constructor() {
    super();
    this.offers = new Map();
    this.orders = new Map();
    this.capabilities = {
      createOffer: true, updateOffer: true, pauseOffer: true,
      listOrders: true, subscribeOrders: false, getOrder: true,
      sendMessage: true, markDelivered: true, cancelOrder: true,
      getBalance: true, withdraw: true
    };
  }
  
  async authenticate() { return Promise.resolve(); }
  async refreshAuth() { return Promise.resolve(); }
  async healthCheck() { return { ok: true, details: 'Mock ready' }; }

  async createOffer(offer) {
    const id = 'mock_offer_' + Date.now();
    this.offers.set(id, { id, ...offer, status: 'active' });
    return id;
  }
  async updateOffer(offerId, updates) {
    if (this.offers.has(offerId)) {
      this.offers.set(offerId, { ...this.offers.get(offerId), ...updates });
    }
  }
  async setStock(offerId, quantity) { return this.updateOffer(offerId, { quantity }); }
  async pauseOffer(offerId) { return this.updateOffer(offerId, { status: 'paused' }); }
  async resumeOffer(offerId) { return this.updateOffer(offerId, { status: 'active' }); }
  async getOffer(offerId) { return this.offers.get(offerId) || null; }
  async listOffers() { return Array.from(this.offers.values()); }

  async listOrders(filter) { return Array.from(this.orders.values()); }
  async getOrder(orderId) { return this.orders.get(orderId) || null; }
  async markDelivered(orderId, proof) {
    if (this.orders.has(orderId)) {
      this.orders.set(orderId, { ...this.orders.get(orderId), status: 'delivered' });
    }
  }
  async cancelOrder(orderId, reason) {
    if (this.orders.has(orderId)) {
      this.orders.set(orderId, { ...this.orders.get(orderId), status: 'cancelled' });
    }
  }
  async sendMessage(orderId, message) { }
  async getBalance() { return { available: 1000, pending: 200, currency: 'USD' }; }
  async withdraw(amount, destination) { return { status: 'success', amount }; }
  
                
  simulateOrder(order) {
    const id = 'mock_order_' + Date.now();
    this.orders.set(id, { id, status: 'pending', ...order });
    return id;
  }
}

module.exports = { MockAdapter };
