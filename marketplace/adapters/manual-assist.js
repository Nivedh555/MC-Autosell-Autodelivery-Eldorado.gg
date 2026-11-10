'use strict';

const { MarketplaceAdapter } = require('../adapter-interface');

class ManualAssistAdapter extends MarketplaceAdapter {
  constructor(notifyCallback) {
    super();
    this.notifyCallback = notifyCallback;
    
    this.capabilities = {
      createOffer: true,                                         
      updateOffer: true,
      pauseOffer: true,
      listOrders: false,                                  
      subscribeOrders: false,
      getOrder: false,
      sendMessage: false,
      markDelivered: false,                   
      cancelOrder: false,
      getBalance: false,
      withdraw: false
    };
    
    this.offers = new Map();
  }

  async authenticate() { return Promise.resolve(); }
  async refreshAuth() { return Promise.resolve(); }
  async healthCheck() { return { ok: true, details: 'Manual assist ready' }; }

  async createOffer(offer) {
    const offerId = 'manual_' + Date.now();
    this.offers.set(offerId, { id: offerId, ...offer, status: 'active' });
    
    if (this.notifyCallback) {
      this.notifyCallback('OFFER_CREATED', {
        message: `Ready to list on Eldorado: ${offer.quantity} at $${offer.pricePerUnit}/M`,
        offer
      });
    }
    
    return offerId;
  }

  async updateOffer(offerId, updates) {
    if (this.offers.has(offerId)) {
      const existing = this.offers.get(offerId);
      this.offers.set(offerId, { ...existing, ...updates });
      if (this.notifyCallback) {
         this.notifyCallback('OFFER_UPDATED', { offerId, updates });
      }
    }
  }

  async setStock(offerId, quantity) {
    return this.updateOffer(offerId, { quantity });
  }

  async pauseOffer(offerId) {
    return this.updateOffer(offerId, { status: 'paused' });
  }

  async resumeOffer(offerId) {
    return this.updateOffer(offerId, { status: 'active' });
  }

  async getOffer(offerId) {
    return this.offers.get(offerId) || null;
  }

  async listOffers() {
    return Array.from(this.offers.values());
  }

  async listOrders(filter) { return []; }
  async getOrder(orderId) { return null; }
  async markDelivered(orderId, proof) { }
  async cancelOrder(orderId, reason) { }
  async sendMessage(orderId, message) { }
  async getBalance() { return { available: 0, pending: 0, currency: 'USD' }; }
  async withdraw(amount, destination) { return null; }
}

module.exports = { ManualAssistAdapter };
