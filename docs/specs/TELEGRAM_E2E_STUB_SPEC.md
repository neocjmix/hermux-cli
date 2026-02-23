# Telegram E2E Stub Spec

## Objective

Provide a reusable Telegram Bot API contract stub for hermux that supports:

- deterministic CI test loops,
- polling + callback flow validation,
- error and conflict simulation,
- request inspection for debug and regression analysis.

## Scope

In-repo stub implementation is intentionally focused on methods used by hermux runtime contracts:

- `getUpdates`
- `setWebhook`
- `getWebhookInfo`
- `deleteWebhook`
- `setMyCommands`
- `sendMessage`
- `editMessageText`
- `deleteMessage`
- `answerCallbackQuery`
- `sendPhoto`
- `sendDocument`

## Control API Contract

- `GET /__control/health`
- `GET /__control/requests`
- `DELETE /__control/requests`
- `GET /__control/scenarios`
- `POST /__control/scenarios`
- `DELETE /__control/scenarios`
- `POST /__control/updates`

## Runtime Integration Contract

Gateway supports `OMG_TELEGRAM_BASE_API_URL` for custom Telegram API endpoint.

- when set: bot uses local/mock endpoint.
- when unset: bot defaults to official endpoint behavior through library default.

Gateway also supports `OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS` to reduce integration-test latency.

## Determinism Requirements

- message/update ids generated monotonically per token state.
- scenario matching and decrement (`times`) deterministic.
- request log order preserved.

## Verification Requirements

E2E tests must validate at minimum:

1. mapped `/start` message flow sends expected onboarding/runtime info text.
2. callback `interrupt:now` in idle state sends expected user-visible message and callback acknowledgement.
3. bot bootstrap command registration path (`setMyCommands`) reaches stub API with expected command set.
4. polling conflict semantics are preserved (`getUpdates` returns `409` while webhook is active) and gateway logs structured polling error details.
5. scenario-driven API failure injection (for example `sendMessage` failure) does not crash gateway process and remains inspectable in control request logs.
6. webhook conflict recovery is validated (`deleteWebhook` after conflict restores polling and normal `/start` flow processing).
7. callback acknowledgement failures (`answerCallbackQuery`) keep user-visible callback contract responses intact.
8. HTML parse-mode send failures trigger `safeSend` fallback retry without `parse_mode` and succeed.

## Debug Loop Usage

For local feature debugging:

1. start stub server (`npm run telegram:stub`),
2. start gateway with `OMG_TELEGRAM_BASE_API_URL`,
3. inject updates through control API,
4. inspect request log through control API,
5. iterate with scenarios for errors/conflicts.
