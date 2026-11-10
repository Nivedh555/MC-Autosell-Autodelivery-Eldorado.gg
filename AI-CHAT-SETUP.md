# Optional AI interpretation

AI helps interpret informal buyer text. It does not verify that an account belongs to the buyer, determine the order amount, confirm a recipient, execute a command, or decide whether to repay.

## Modes

| Mode | Behavior |
| --- | --- |
| `off` | Default. No AI requests. Deterministic chat and payment checks remain active. |
| `shadow` | Classifies ambiguous messages and records the result locally. No customer message or payment behavior changes. |
| `suggest` | May suggest a literal username from the buyer's message. The buyer must re-enter `ign: ExactName`, then confirm the normal amount-and-name prompt. |

Example: “the account u need is BuyerOne pls” can produce a clarification proposing `BuyerOne`. A reply of “yes” to that clarification **does not authorize payment**. The standard name-entry and confirmation flow must still complete.

## Configure locally

In the application's `.env`, set:

```dotenv
AUTOSELL_CHAT_AI_MODE=shadow
AUTOSELL_CHAT_AI_PROVIDER=gemini
AUTOSELL_CHAT_AI_MODEL=gemini-3.5-flash-lite
AUTOSELL_CHAT_AI_API_KEY=YOUR_API_KEY
```

Gemini uses Google's Developer API directly, with JSON-schema output and header authentication. `gemini-3.5-flash-lite` is the default model when the provider is explicitly `gemini`. No API key is bundled. Keep the key in this local ignored file, restrict filesystem access, and do not paste it into customer chat or support messages. Restart the backend after changing environment configuration.

Existing OpenAI configurations remain supported: set `AUTOSELL_CHAT_AI_PROVIDER=openai` and an explicit Responses-compatible model. If the provider is omitted, legacy configurations continue using OpenAI. There is no automatic provider/model fallback, billing setup, or paid-tier upgrade.

Start with `shadow`. Inspect `chat_interpretations` and compare decisions with the actual captured buyer messages before choosing `suggest`. Only after that evaluation should suggestions be enabled for real customers. Reverting to `off` immediately after a restart disables model use without touching payment journals.

Authenticated diagnostics: `GET /api/marketplace/reliability` reports the provider, configured model/mode, whether a model/key are present, request cooldown and classification counts. No key is returned. The existing dashboard authentication and route mount apply.

## Gemini free tier

Google currently lists free input/output for Gemini 3.5 Flash-Lite on its free tier. Quotas depend on the project's model and tier and are shared across that project's keys; inspect the actual limits in Google AI Studio. If billing is already enabled, paid-tier pricing can apply. The application cannot guarantee free usage by inspecting an API key and does not change Google billing settings.

Google's pricing page says free-tier content is used to improve its products. Only the single qualifying buyer message is sent, but it can still contain customer information. Review the provider's terms before enabling real customer classification. Shadow mode also sends qualifying text to Google; it only disables changes to customer messages and payments. Use `off` to make no AI requests.

## Limits and privacy

- One ambiguous message of at most 1,000 characters is sent per request. No complete transcript, order payload, seller credentials, wallet data, cookies or bridge token is included.
- Obvious credential assignments and URLs in buyer text are excluded. Arbitrary text entered by the buyer is still customer data; enabling AI sends qualifying text to the provider.
- Fixed provider endpoints: Gemini `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, or OpenAI `https://api.openai.com/v1/responses`. Keys are sent in headers, never URLs. Redirects are rejected. Gemini uses `responseJsonSchema`; OpenAI uses strict Structured Outputs with `store:false`. No tools are provided; local validation rejects extra fields, invalid names and names absent from the source message.
- One request in flight, at most 20 new requests per rolling minute per process, 2.5-second deadline, bounded response size and 512 output tokens.
- Each decision is keyed to order, message, text hash, provider, model and interpreter version. Legacy OpenAI cache identities are preserved; Gemini uses a separate namespace. Duplicate observations reuse the saved result. An interrupted/failed request does not loop on restart.
- Provider errors, refusals, invalid output and timeouts fall back to the normal deterministic workflow and open a 60-second AI cooldown. Raw provider errors and response bodies are not logged.
- Only `PROVIDE_IGN` and `CORRECT_IGN` with a valid literal candidate and high self-reported confidence can produce a clarification. Model confirmation, cancellation and other intents never change the financial state.
- Self-reported confidence is not an accuracy score. Structured output constrains format, not semantic truth. This implementation has provider-contract and failure fixtures; a real-model accuracy evaluation is still required.

## Verification

Gemini has fixture tests for header authentication, schema fields, local name validation, refusals, truncated/malformed output, oversized responses, quota failure, provider-separated caching, and compatibility with existing OpenAI configuration. A synthetic live Gemini 3.5 Flash-Lite request succeeded on 2026-11-09 and extracted the exact made-up username in approximately 1.6 seconds. That is a connectivity check, not an accuracy benchmark or production latency guarantee. Real-model accuracy and unattended live delivery acceptance remain pending.

References: [Gemini model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [generateContent API](https://ai.google.dev/api/generate-content), [pricing and data use](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
