'use strict';

   
                                                                               
                                                                         
  
                                                                                 
                                                                           
                                                                   
   

const { EmbedBuilder } = require('discord.js');
const services = require('../services');

const COLORS = {
  info: 0x5865f2,
  success: 0x57f287,
  warn: 0xfee75c,
  error: 0xed4245,
  minecraft: 0x55ff55,
};
const MAX_BUFFER = 500;

class DiscordLogger {
  redact(text) {
    if (typeof text !== 'string') return text;
    let res = text;
    res = res.replace(/([a-zA-Z0-9_-]{24}.[a-zA-Z0-9_-]{6}.[a-zA-Z0-9_-]{27})/g, '[REDACTED_DISCORD_TOKEN]');
    res = res.replace(/(xprv[a-zA-Z0-9]{107})/g, '[REDACTED_XPUB]');
    res = res.replace(/([a-zA-Z0-9]{32,64})/g, (match) => match.length >= 32 && match.length <= 64 ? '[REDACTED_HEX/KEY]' : match);
    return res;
  }

  constructor() {
    this.buffer = [];
    this._seq = 0;
  }

  recent(n = 10) {
    return this.buffer.slice(-n);
  }

  clear() {
    this.buffer = [];
  }

                                                                         
  latestSeq() {
    return this._seq;
  }

                                                                                           
  since(afterSeq = 0) {
    const a = Number(afterSeq) || 0;
    return this.buffer.filter((e) => e.seq > a);
  }

                                                                                 
  _route(level, title, channel) {
    if (channel) return channel;
    const t = String(title || '');
    if (level === 'error') return 'errors';
    if (/cashout/i.test(t)) return 'cashouts';
    if (/verif|link/i.test(t)) return 'verify';
    if (/sale|sell|credit|payment|money|skelly|spawner|payout/i.test(t)) return 'sales';
    return 'system';
  }

  _channel(routeKey) {
    try {
      const { discordClient, config, logChannels } = services;
      if (!discordClient || typeof discordClient.isReady !== 'function' || !discordClient.isReady()) return null;
      if (!discordClient.channels || !discordClient.channels.cache) return null;
      const id = (logChannels && logChannels[routeKey]) || config?.discord?.logsChannelId;
      if (!id) return null;
      const ch = discordClient.channels.cache.get(id);
      return ch && typeof ch.isTextBased === 'function' && ch.isTextBased() ? ch : null;
    } catch {
      return null;
    }
  }

  async log({ title, description = '', level = 'info', fields = [], channel }) {
    try {
      const route = this._route(level, title, channel);
                                                                                      
      this.buffer.push({ seq: ++this._seq, timestamp: new Date().toISOString(), title, message: description, level, category: route });
      if (this.buffer.length > MAX_BUFFER) this.buffer.shift();

      const ch = this._channel(route);
      if (!ch) return;
      try {
        const embed = new EmbedBuilder()
          .setAuthor({name:'DonutFlip · Autosell'})
          .setColor(COLORS[level] ?? COLORS.info)
          .setTitle(String(title).slice(0, 256))
          .setFooter({text:'System log · DonutFlip'})
          .setTimestamp();
        if (description) embed.setDescription(String(description).slice(0, 4096));
        if (fields && fields.length) {
          embed.addFields(
            fields.slice(0, 25).map((f) => ({
              name: String(f.name).slice(0, 256),
              value: String(f.value).slice(0, 1024) || '​',
              inline: Boolean(f.inline),
            }))
          );
        }
        await ch.send({ embeds: [embed], allowedMentions:{parse:[]} });
      } catch (err) {
                                              
        console.error('[logger] failed to post:', err.message);
      }
    } catch {
                                                    
    }
  }

  info(title, description, fields, channel) {
    return this.log({ title, description, fields, level: 'info', channel });
  }
  success(title, description, fields, channel) {
    return this.log({ title, description, fields, level: 'success', channel });
  }
  warn(title, description, fields, channel) {
    return this.log({ title, description, fields, level: 'warn', channel });
  }
  minecraft(title, description, fields, channel) {
    return this.log({ title, description, fields, level: 'minecraft', channel });
  }

  error(title, err, context = {}, channel) {
    const details=require('../ops/notification-text').notificationDetails({component:'system',reason:err instanceof Error?err.message:String(err)});
    const description=details.summary;
    const fields = Object.entries(context || {}).map(([name, value]) => ({
      name:require('./log-text').clean(name,100),
      value:/password|passphrase|cookie|token|secret|key/i.test(name)?'[removed]':require('./log-text').clean(value,500),
      inline: true,
    }));
    fields.unshift({name:'Next step:',value:details.next,inline:false});
    return this.log({ title, description, fields, level: 'error', channel });
  }

  adminCommand(commandName, user, details = '') {
    return this.log({
      title: '🛠️ Admin command',
      description: `\`/${commandName}\` used by **${user}**${details ? `\n${details}` : ''}`,
      level: 'info',
    });
  }
}

module.exports = DiscordLogger;
