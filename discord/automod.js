'use strict';

   
                                                                       
                                                                                 
                                                                         
   

const { PermissionFlagsBits } = require('discord.js');

                                                                                
function exemptRoleId() {
  const id = require('../services').config.discord.automodExemptRoleId;
  return id && String(id).trim() ? String(id).trim() : null;
}

                                                                                          
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;

                                                                                
const PIC_EXT = /\.(?:png|jpe?g|webp|bmp|tiff?|heic|heif|avif|svg)(?:\?|#|$)/i;
                                            
const GIF_LIKE = /\.gif(?:\?|#|$)|tenor\.com|giphy\.com|gfycat\.com|\.gifv(?:\?|#|$)/i;

                                                           
function isPictureAttachment(att) {
  const ct = (att.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return ct !== 'image/gif';
                                                                    
  const name = (att.name || att.url || '').toLowerCase();
  if (GIF_LIKE.test(name)) return false;
  return PIC_EXT.test(name);
}

                                                                       
function hasPictureLink(content) {
  const urls = content.match(/https?:\/\/\S+/gi) || [];
  return urls.some((u) => !GIF_LIKE.test(u) && PIC_EXT.test(u));
}

                                           
function violation(message) {
  for (const att of message.attachments.values()) {
    if (isPictureAttachment(att)) return 'picture';
  }
  const content = message.content || '';
  if (INVITE_RE.test(content)) return 'invite';
  if (hasPictureLink(content)) return 'picture';
  return null;
}

                                                                                          
async function handleMessage(message) {
  try {
    if (!message.guild || message.author.bot) return false;
    const EXEMPT_ROLE_ID = exemptRoleId();
    if (!EXEMPT_ROLE_ID) return false;

    let member = message.member;
    if (!member) member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member && (member.roles.cache.has(EXEMPT_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator))) return false;

    const kind = violation(message);
    if (!kind) return false;

    await message.delete().catch(() => {});
    const what = kind === 'invite' ? 'server invite links' : 'images';
    const warn = await message.channel
      .send({
        content: `🚫 <@${message.author.id}>, only <@&${EXEMPT_ROLE_ID}> can post ${what} here. _(GIFs are fine.)_`,
        allowedMentions: { users: [message.author.id] },                               
      })
      .catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 6000);
    return true;
  } catch {
    return false;
  }
}

module.exports = { handleMessage };
