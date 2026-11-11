# Discord dashboard parity

The original frontend existed only as a compiled bundle. The archived bundles, the live `web/dist` assets, the existing Discord modules and APIs, and the current navigation were inspected. The existing Discord APIs, saved-panel template, design preview and navigation were reused behind a discoverable **Discord Dashboard**; the dashboard adds the token, guild, role and channel controls that were missing from the shipped screen. This file records what is implemented and what still needs a live server.

| Area | Control | Backend path | Evidence |
| --- | --- | --- | --- |
| Connection | Bot token, server ID, owner ID | `GET/POST /api/v2/discord/dashboard`, `/settings` | Integration: mask, blank-token retention, save/reload, invalid ID; UI: mask, save, reload |
| Connection | Check bot, guild, channels, roles | `POST /api/v2/discord/check` | Integration: connected checks and offline 409; UI: check message |
| Permissions | Owner re-authentication for writes | `requireReauth` on every mutation | Integration: unauthenticated save is 403 |
| Channels | Text/announcement channel picker and raw channel ID | `GET /dashboard`, `POST /panel/post` | Integration: channel/permission rejection; UI: channel select and post |
| Roles | Admin, sold, automod-exempt selectors | `GET /dashboard` fields/roles, `POST /settings` | Integration: role check; UI: fields render |
| Buying | Spawner price, money rate, buy money/spawners, pause all | `POST /api/v2/discord/buying` | Integration: prices and toggles persist; UI: form renders and saves |
| Embeds | Author, title, description, color, footer, fields, button layout | `POST /panel/preview`, `/panel/save` | Integration: preview renders fields; UI: edit and preview |
| Posting | Post panel to a validated channel | `POST /panel/post` | Integration: permission failure and successful message ID; UI: post and reload |
| Saved panel | Saved channel/message, stale detection, refresh | `GET /dashboard`, `POST /panel/refresh` | Integration: missing message marks stale; UI: Current/Needs attention |
| Audio | Master toggle, volume, five sound categories | Browser `localStorage` (`autosell_discord_audio_v1`) | UI: toggling payment sound persists |
| Accounts | Links to pairs, sellers/cashouts, wallet, payout setup, operations | Existing dashboard tabs and `/intake-setup`, `/operations` | UI: link targets |
| Intake | Configured/missing channels and roles | `GET /dashboard` `intake`, `POST /check` | Integration: configured/missing states; UI: checklist |
| Live Discord | Real posting, real role/channel permissions, real bot token | Discord client | **Not verified in this environment.** All posting tests use a fake Discord client and permissions. |

## Still requires the owner

- A real bot token, guild, channels and roles on a test Discord server.
- A live post and a permission-removal check with that bot.
- A live Eldorado sign-in in the seller's own browser (unchanged from the handoff).
- A signed release and a real signed A-to-B update acceptance run.

The fake client exercises validation, permission refusal, channel lookup, message binding and failure handling. It cannot prove Discord account-level permissions, rate limits or the final visual rendering in a Discord client.
