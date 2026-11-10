# Customer Messages

Open **Customer Messages** in the dashboard. Select an order stage, edit the text, choose **Send this message**, and save. A preview uses example order values. Saved versions survive restarts and upgrades. **Reset to default** also saves the restored value.

The delivery-completion message and optional review request start disabled with empty text. The two confirmation-guide pictures also start disabled. Enable these controls before the next order reaches delivery if you want to send them. Genuine payment evidence uploads independently of those options.

Supported placeholders are `{buyer_name}`, `{minecraft_ign}`, `{amount}`, `{order_id}`, `{order_url}`, `{server_name}` and `{shop_name}`. The editor omits a username placeholder at stages where a recipient has not been supplied. `{shop_name}` uses the order's shop name when present and otherwise renders as “our shop”. Enter your shop name directly in the template when you want specific branding.

Recipient confirmation always includes the exact game amount, recipient, order and conversation reference. Its introduction is editable. The buyer must affirm the saved prompt after providing a valid username. A correction or cancellation invalidates the previous authorization. A custom greeting cannot qualify as a confirmation by copying the previous wording.

## Event timing

| Event | Trigger |
| --- | --- |
| New order | First funded conversation that still needs a recipient |
| Request Minecraft username | Combined with the first greeting |
| Invalid Minecraft username | Recipient clarification before payment |
| Username correction | Replacement recipient, included before the new mandatory confirmation |
| Confirm recipient and amount | Exact selected recipient and amount before payment |
| Buyer confirms | Authorized recipient, immediately before the payment-start message |
| Payment starts | Before the first verified payment command |
| Payment proof is ready | Before the genuine proof upload |
| Payment fully verified | All payment chunks reached `PAY_VERIFIED` |
| Order marked delivered | Eldorado acknowledged the verified delivery |
| Delivery delayed | First recorded retry or failure for the order |
| Minecraft account unavailable | Recorded delivery failure reports an unavailable game session |
| Manual attention | Delivery enters operator review |
| Buyer cancels before payment | Confirmed buyer-requested marketplace cancellation with no payment intent |
| Optional review request | After the configured completion stage |

## Persistence and retry behavior

Migration 028 adds SQLite template revisions and rendered message snapshots. Scheduling stores the intended text, event version and stable action identity. Later template edits affect future scheduling. Queued messages retain their original content. Disabled events are also recorded so enabling an event later cannot send an unexpected message to a previously completed customer.

The existing browser outbox records the point where submission may have occurred. After an uncertain send, the worker checks the saved conversation observations for its outgoing text or attachment. It does not start a second submission. Existing uncertain guide uploads from earlier versions continue through this reconciliation path even when the new guide preference is disabled.

Delivery-completion notifications can finish after the buyer has already confirmed receipt. Canceled orders are excluded from delivery-completion messages. Their optional cancellation message requires its own verified cancellation record. Message retries never create a Minecraft payment.

The notification worker checks pending work every 15 seconds. Failed optional lifecycle messages use persisted retry delays. Authentication, browser connectivity, Global Autosell, automatic-chat settings and owner holds still apply. An external chat outage can delay delivery notices, with the recorded action available for review.

## Developer entry points

`GET /api/v3/customer-messages` returns saved templates, guide preference and example values. `PUT /api/v3/customer-messages/:event` accepts `text`, `enabled` and the current `revision`. `POST /api/v3/customer-messages/:event/reset` resets a template using its current revision. `PUT /api/v3/customer-messages/guides` accepts `enabled` and the current guide revision. These writes use the dashboard's authenticated, reauthorized request flow. Conflicting revisions return HTTP 409. Invalid placeholders and settings return HTTP 400.

`marketplace/customer-message-config.js` owns defaults, validation, snapshots and event mapping. `marketplace/order-chat-flow.js` recognizes the saved mandatory confirmation. `v3/notifications.js` finishes optional lifecycle and delivery messages. `marketplace/browser/dispatch-chat.js` keeps submission receipt checks and stable outbox identities. The dashboard editor is `web/dist/assets/customer-messages.js`.
