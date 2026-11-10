'use strict';

   
                                        
                                                
   

const MAX_MESSAGE_LENGTH = 2000;
const MAX_EMBED_TITLE = 256;
const MAX_EMBED_DESC = 4096;

function escapeMentions(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/@everyone/g, '@\u200Beveryone')
    .replace(/@here/g, '@\u200Bhere')
    .replace(/<@/g, '<\u200B@')
    .replace(/<#/g, '<\u200B#')
    .replace(/<@&/g, '<\u200B@&');
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function render(template, data = {}, type = 'message') {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    const safeValue = escapeMentions(String(value !== null && value !== undefined ? value : ''));
    result = result.replace(new RegExp(`{${key}}`, 'g'), safeValue);
  }

  const maxLength =
    type === 'title' ? MAX_EMBED_TITLE :
    type === 'description' ? MAX_EMBED_DESC :
    MAX_MESSAGE_LENGTH;
    
  return truncate(result, maxLength);
}

module.exports = {
  render,
  escapeMentions,
  truncate,
  limits: {
    MAX_MESSAGE_LENGTH,
    MAX_EMBED_TITLE,
    MAX_EMBED_DESC
  }
};
