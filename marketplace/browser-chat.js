'use strict';
                                                                               
class BrowserChatModule {
  async init() { throw new Error('Browser chat unavailable: observed pages and owner-approved session integration required'); }
  async sendMessage() { throw new Error('Browser chat unavailable; use the operator inbox'); }
  async close() {}
}
module.exports = { BrowserChatModule };
