'use strict';
const services = require('../services');
class OrderNotifier {
  constructor() {
    this.onOrder = data => { void this.handleNewOrder(data).catch(error => services.events?.emit('operator:alert', { component: 'notification', reason: error.message })); };
    services.events?.on('marketplace:new_order', this.onOrder);
  }
  stop() { services.events?.off('marketplace:new_order', this.onOrder); }
  async handleNewOrder({ order }) {
    const channel = await services.settings?.get('eldorado.order.notification_channel');
    if (!channel) return false;
    const row = services.db?.raw().prepare('SELECT state,mode FROM delivery_orders WHERE id=?').get(order.id);
    return this._sendToDiscord(channel, { content: 'Order detected: ' + order.id + '\nState: ' + (row?.state || 'not recorded') + '\nMode: ' + (row?.mode || 'not recorded'), allowedMentions: { parse: [] } });
  }
  async sendDeliveryProofNotification({ order }) {
    const row = services.db?.raw().prepare('SELECT state,mode,evidence FROM delivery_orders WHERE id=?').get(order.id);
    if (!row) throw new Error('No delivery journal record for notification');
    const channel = await services.settings?.get('eldorado.order.notification_channel');
    if (!channel) return false;
    return this._sendToDiscord(channel, {
      content: 'Delivery record: ' + order.id + '\nState: ' + row.state + '\nMode: ' + row.mode + '\nEvidence: ' + (row.evidence ? 'Available in the owner dashboard' : 'not captured'),
      allowedMentions: { parse: [] },
    });
  }
  async _sendToDiscord(channelId, payload) {
    const client = services.discordClient;
    if (!client?.isReady?.()) throw new Error('Discord notification was not sent: client disconnected');
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (typeof channel?.send !== 'function') throw new Error('Notification channel unavailable');
    await channel.send(payload);
    return true;
  }
}
module.exports = { OrderNotifier };
