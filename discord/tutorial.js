'use strict';

   
                                                          
                                                                               
   

const { EmbedBuilder } = require('discord.js');

const RED = 0xdc143c;
const PREFIX = '!tut';

function steps() {
  return [
    {
      title: '0–15 · Discord app & bot invite',
      body: [
        '**0** Create an app at [Discord Developer Portal](https://discord.com/developers/applications).',
        '**5** Bot tab → copy **token** → put in `.env` as `DISCORD_TOKEN`.',
        '**8** Enable **Server Members Intent** (Bot → Privileged Gateway Intents).',
        '**10** Enable **Message Content Intent** (needed for `!tut` + automod).',
        '**12** OAuth2 → URL Generator → scopes: `bot` + `applications.commands`.',
        '**15** Invite the bot to your server (Manage Server permission required).',
      ],
    },
    {
      title: '15–30 · `.env` file (secrets)',
      body: [
        'Copy `.env.example` → `.env` in the bot folder.',
        '**DISCORD_TOKEN** — your bot token.',
        '**GUILD_ID** — your server ID (Developer Mode → right-click server → Copy ID).',
        '**ADMIN_ROLE_ID** — role that can use `/control`, `/price-set`, etc.',
        '**OWNER_ID** — your Discord user ID (low-balance / restock DMs).',
        '**LOGS_CHANNEL_ID** — channel for staff logs.',
        '**LTC_MNEMONIC** *or* **LTC_WIF** — payout wallet (**friend fills this in — never share yours**).',
        '**LTC_SEND_ENABLED=false** keeps payouts disabled until your wallet is configured.',
        '**API_KEY** — long random string for the web dashboard.',
        '**API_PORT** — dashboard port (default `4201`).',
      ],
    },
    {
      title: '30–45 · Install & run',
      body: [
        '**30** Install [Node.js 22+](https://nodejs.org).',
        '**35** In the folder: `npm install`',
        '**40** Start: `node index.js` or double-click **Start Autosell.bat**.',
        '**45** Dashboard: `http://localhost:4201` (or your `API_PORT`) — log in with `API_KEY`.',
      ],
    },
    {
      title: '45–60 · Minecraft accounts (.env)',
      body: [
        'Set buyer logins **in `.env`** (or `/control` — both work):',
        '**BUYER1_EMAIL=** their Microsoft email for account 1 (new sellers)',
        '**BUYER1_IGN=** in-game name for account 1',
        '**BUYER2_EMAIL=** / **BUYER2_IGN=** optional second account (trusted sellers)',
        '**58** Run **`/mc-start`** → Microsoft login link in **console** + **#logs**',
        '**60** Complete login once; tokens save in `auth-cache/`',
      ],
    },
    {
      title: '60–75 · Panel, pricing & sweep',
      body: [
        '**62** **`/sell-panel`** in your sell channel — posts the red sell panel.',
        '**65** **`/price-set`** — USD per skeleton spawner.',
        '**68** **`/rate-set`** — USD per 1M in-game money.',
        '**70** **`/control`** → set sweep owner name + IGNs (where money goes).',
        '**73** **`/demopanel`** / **`/choosepanel`** — change panel design.',
        '**75** **`/sell-pause`** / **`/sell-resume`** — pause selling.',
      ],
    },
    {
      title: '75–90 · Wallet & payouts',
      body: [
        '**78** Fund the LTC address the bot prints on startup.',
        '**80** Configure your wallet before accepting sales. **`LTC_SEND_ENABLED=false`** blocks payouts; it does not simulate them.',
        '**85** Toggle live sends: set **`LTC_SEND_ENABLED=true`** in `.env` OR **`/control`** → Toggle LTC Sending → restart.',
        '**88** Dashboard → Wallet tab shows balance + send test.',
        '**90** Sellers set IGN + LTC address on the panel → sell → instant payout.',
      ],
    },
    {
      title: '90–100 · Go live checklist',
      body: [
        '**92** Bot role **above** any auto-grant “sold” role (`SOLD_ROLE_ID` in `.env`).',
        '**94** Set **`VOUCH_CHANNEL_ID`** in `.env` if you want vouch links on the panel.',
        '**96** Run **`/deal-stats`**, **`/mystats`**, **`/top-sellers`** to verify.',
        '**98** Never commit or send anyone your `.env`, `auth-cache/`, or `data/` with real sellers.',
        '**100** Type **`!tut`** anytime to see this guide again.',
      ],
    },
  ];
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return false;
  const text = (message.content || '').trim().toLowerCase();
  if (text !== PREFIX && !text.startsWith(`${PREFIX} `)) return false;

  const embeds = steps().map(
    (s) =>
      new EmbedBuilder()
        .setColor(RED)
        .setTitle(`📘 Autosell setup — ${s.title}`)
        .setDescription(s.body.join('\n'))
  );

  embeds[0].setAuthor({ name: 'Autosell — full owner tutorial (0→100)' }).setFooter({ text: 'Set everything in .env • /control still works for live edits' });

  await message.reply({ embeds: embeds.slice(0, 10), allowedMentions: { repliedUser: false } }).catch(() => {});
  return true;
}

module.exports = { handleMessage };
