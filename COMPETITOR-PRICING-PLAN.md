# How Autosell prices DonutSMP offers

In **Browser + API** mode, automatic offers can follow the lowest qualifying price that Eldorado returns. The program reads currency listings through the Seller API and applies the rules saved in **Eldorado Setup → Offers and stock**. This guide describes the shipped code and a proposed AI feature. The audit used local source, fixtures and public documentation. It did not access a seller account or change an offer.

## What works today

For an existing linked offer, open **Eldorado Setup → Existing currency offer → Compare competitor prices**. The preview uses the linked offer’s minimum purchase as the comparison size and shows up to five distinct sellers ordered by asking price in **USD per million**. Each row must be Active, have enough advertised stock, and allow that purchase size. It excludes your own offers. The preview shows the time of the scan and can reuse it for 30 seconds. Comparing prices works with global automation paused. This preview and the automatic undercut policy below use different filters.

| Choice | What happens |
| --- | --- |
| Link an existing offer | The worker manages its availability and preserves the price and quantity chosen in Eldorado. |
| Create automatic offers at a fixed price | When an enabled pair's fresh Minecraft balance minus its reserve reaches its threshold, the worker can create an offer at the configured price. It advertises the available balance rounded down to whole currency units. The threshold decides when to start. |
| Create automatic offers with undercutting | The worker checks your own offers and comparable currency listings. It excludes your seller ID and offer IDs, checks the game and server, converts unit prices to USD per billion coins, and keeps positive USD prices with at least your minimum competitor stock. |

The market price is `max(configured floor, lowest eligible USD/B − undercut amount)`. For example, a qualifying offer at $9.30/B, a $0.01/B undercut and a $9.00/B floor give $9.29/B. A competing offer at $8.50/B gives $9.00/B. If every row is excluded, the worker uses the configured fallback price or waits when the fallback is blank. A failed API read is a separate error. With undercutting off, repricing uses the fixed selling price.

The worker compares prices from grouped listings. Today's price function does not rank sellers by sales or reputation, explicitly require an Active competitor state, or check whether one unusually low quote represents the market. Market mode enforces the floor only. It can follow a competitor upward past the previous selling price. The floor is owner-supplied. The hybrid price calculation does not derive it from acquisition costs, fees or a target profit.

Stock checks run every 30 seconds by default and can also be triggered by stock or delivery events. For an automatic offer, unfinished orders pause availability. When stock or price changes, the worker pauses the offer, writes the changed field and rereads it before resuming. It records a creation attempt before sending it and reconciles uncertain results before creating another offer. The adapter spaces requests and observes HTTP 429 cooldowns. The pricing rule has no separate minimum time between price changes.

## Where the numbers come from

These are the routes in the **bundled** Seller API contract under `/api/v1/currency-management`. Responses and account permissions would need a separate live check. Eldorado describes offer creation, availability, price and quantity management in its seller guide. [Eldorado Seller API guide](https://support.eldorado.gg/en/articles/16127288-how-the-seller-api-works)

| Method and relative path | Use in Autosell |
| --- | --- |
| `GET /offers/groups` | Read paginated currency listings for `gameId`, `category=Currency` and a trade environment where applicable. The adapter requests up to 50 rows per page and checks for complete pagination. |
| `GET /me/offers` and `GET /me/offers/{id}` | Identify the seller's own offers and verify the chosen offer after a change. |
| `POST /me/offers` | Create an automatic offer with its price, quantity, minimum purchase, description and delivery time. |
| `PUT /me/offers/{id}/change-price` and `.../change-quantity` | Update an existing automatic offer. The API expects price per currency unit and quantity in units. |
| `PUT /me/offers/{id}/pause` and `.../resume` | Control availability while checking stock, orders or an update. |

## A practical next version

1. **Show the market before changing a price.** Save each complete scan with its start and finish time, game, server, seller and offer IDs, state, units, price, stock and minimum purchase. In a preview, show the compared rows, excluded rows and reasons. Require fresh, complete data and independently verified balance and orders before a new price or quantity can be applied.
2. **Define a comparable seller.** Require an Active offer that can fill the intended order size. Group by seller so one account with several offers gets one vote. Support an owner-selected seller list. Rank by reputation or sales only when a documented, reliable field supplies that metric. Label a price-based rank as such. Compare several distinct sellers, flag quotes far from their median, and hold on thin or contradictory data. Listed prices are asking prices. Historical purchases from your own account can measure realized prices and demand.
3. **Calculate a profitable range.** For each order size, include acquisition cost, fixed costs allocated per billion, and the required profit per billion. If the variable fee is a fraction of gross revenue, `minimum USD/B = (cost/B + fixed costs/B + target profit/B) / (1 − fee fraction)`. Use verified fee terms for the account, round the minimum upward, then apply the higher of this minimum and the owner's floor. Enforce an explicit ceiling. If cost coverage or fees are unknown, or the floor exceeds the ceiling, hold the recommendation.
4. **Bound inventory and writes.** Cap a proposed quantity at the fresh balance minus the reserve and unpaid-in-game obligations already accepted, then apply the owner's quantity limit, API unit size and minimum purchase. Keep account locks, offer identity checks and the existing creation journal. Require a material price difference or repeated confirmation across scans before repricing. Add a per-offer cooldown and update budget, honor marketplace rate limits, and reread each write. A delayed create response must lead to reconciliation before any new creation attempt.
5. **Add an AI recommendation.** Give the model a dated snapshot of numeric market inputs, recent realized sales and the allowed ranges. Ask it to return an action such as `hold`, `update` or `propose_create`, a suggested USD/B price and quantity, a snapshot ID and a short reason. The model can compare stock turnover and net proceeds. The application must independently validate eligibility, data age, economics, available stock, cadence and owner controls. A schema constrains the response format. It cannot establish that a proposed trade is profitable or feasible. [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)

Start with a preview that logs the current rule beside the proposed decision and its expected net proceeds. Replay scenarios with a lone low quote, a high-price spike, stale pages, newly accepted orders and an uncertain create response. Once the owner can inspect those outcomes, an explicitly enabled policy could apply validated changes through the same seller adapter.

The implementation is in `marketplace/adapters/eldorado-seller.js` (`listCompetitorOffers`, `pages`), `marketplace/seller-protocol.js` (`undercut`, `automaticDraft`), and `marketplace/hybrid-listings.js` (`price`, `sync`). `test/unit/seller-prices.test.js` exercises the floor, undercut, own-offer exclusion, fallback and decimal conversions.
