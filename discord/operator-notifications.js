'use strict';
const {EmbedBuilder,ChannelType}=require('discord.js');
const registry=require('../services'),{clean}=require('./log-text');
const colors={success:0x22c55e,info:0x38bdf8,warn:0xf59e0b,error:0xf43f5e};
const setupRetry=new WeakMap();
function buildEmbed(alert){
  const view=require('../ops/notification-text').notificationDetails(alert);
  const embed=new EmbedBuilder().setAuthor({name:'DonutFlip · Autosell'}).setColor(colors[view.level])
    .setTitle(view.title).setDescription(view.summary)
    .addFields({name:'Next step:',value:view.next},{name:'Status',value:view.status,inline:true});
  if(view.reference)embed.addFields({name:'Reference',value:view.reference,inline:true});
  if(alert.occurrences>1)embed.addFields({name:'Occurrences',value:String(alert.occurrences),inline:true});
  return decorate(embed,alert.created_ms);
}
function decorate(value,time){
  const raw=value?.toJSON?value.toJSON():value||{},embed=new EmbedBuilder();
  embed.setAuthor({name:'DonutFlip · Autosell'}).setColor(raw.color??colors.warn)
    .setTitle(clean(raw.title||'Autosell notice',256)).setFooter({text:'System log · DonutFlip'});
  if(raw.description)embed.setDescription(clean(raw.description,2000));
  if(raw.fields?.length)embed.addFields(raw.fields.slice(0,8).map(field=>({name:clean(field.name,80)||'Details',value:clean(field.value,350)||'Unavailable',inline:Boolean(field.inline)})));
  const timestamp=time??raw.timestamp??Date.now();embed.setTimestamp(new Date(timestamp));return embed;
}
async function channelFor(route,local){
  const client=local.discordClient;
  if(!client?.isReady?.())return null;
  const resolve=async()=>{
    const id=local.logChannels?.[route];if(!id)return null;
    let channel=client.channels?.cache?.get(id);
    if(!channel)try{channel=await client.channels?.fetch(id);}catch{return null;}
    return channel?.type===ChannelType.GuildText && channel.guildId===local.config?.discord?.guildId && typeof channel.send==='function'?channel:null;
  };
  let channel=await resolve();if(channel)return channel;
  if(Date.now()<(setupRetry.get(local)||0))return null;
  setupRetry.set(local,Date.now()+60000);
  await require('./log-channels').ensure({services:local});
  return resolve();
}
async function postEmbed(embed,{route='errors',services:local=registry,time}={}){
  let channel;
  try{channel=await channelFor(route,local);}catch{channel=null;}
  if(!channel)return {state:'unavailable',reason:'Discord log channel is unavailable. Check the configured guild and the bot’s Manage Channels, View Channel, Send Messages and Embed Links permissions.'};
  try{
    await channel.send({embeds:[decorate(embed,time)],allowedMentions:{parse:[]}});
    return {state:'sent',channelId:channel.id};
  }catch{return {state:'failed-or-unknown',reason:'Discord did not confirm this log message. No DM fallback was used.'};}
}
async function notify(alert,local=registry){
  return postEmbed(buildEmbed(alert),{services:local,route:['listing-success','listing-queue','order-detected'].includes(alert.component)?'system':'errors',time:alert.created_ms});
}
module.exports={notify,postEmbed,buildEmbed,decorate};
