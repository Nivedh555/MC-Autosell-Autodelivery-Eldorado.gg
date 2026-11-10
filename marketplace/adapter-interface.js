'use strict';

class MarketplaceAdapter {
  constructor() {
    this.capabilities = {
      createOffer: false,
      updateOffer: false,
      pauseOffer: false,
      resumeOffer: false,
      listOffers: false,
      getOffer: false,
      deleteOffer: false,
      listCompetitorOffers: false,
      getSellerIdentity: false,
      listOrders: false,
      subscribeOrders: false,
      getOrder: false,
      sendMessage: false,
      markDelivered: false,
      cancelOrder: false,
      getBalance: false,
      withdraw: false
    };
  }

  async authenticate() { throw new Error('Not implemented'); }
  async refreshAuth() { throw new Error('Not implemented'); }
  async healthCheck() { throw new Error('Not implemented'); }

  async createOffer(offer) { throw new Error('Not implemented'); }
  async updateOffer(offerId, updates) { throw new Error('Not implemented'); }
  async setStock(offerId, quantity) { throw new Error('Not implemented'); }
  async pauseOffer(offerId) { throw new Error('Not implemented'); }
  async resumeOffer(offerId) { throw new Error('Not implemented'); }
  async getOffer(offerId) { throw new Error('Not implemented'); }
  async listOffers() { throw new Error('Not implemented'); }

  async listOrders(filter) { throw new Error('Not implemented'); }
  async getOrder(orderId) { throw new Error('Not implemented'); }
  async markDelivered(orderId, proof) { throw new Error('Not implemented'); }
  async cancelOrder(orderId, reason) { throw new Error('Not implemented'); }

  async sendMessage(orderId, message) { throw new Error('Not implemented'); }

  async getBalance() { throw new Error('Not implemented'); }
  async withdraw(amount, destination) { throw new Error('Not implemented'); }
}

module.exports = { MarketplaceAdapter };
