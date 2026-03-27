# Architecture

## System Purpose

`hermux` connects Telegram chat input to local `opencode` execution with repo-scoped isolation.

## Runtime Boundaries

- Telegram boundary: one polling bot process.
- Routing boundary: chat ID resolves to one repo context.
- Execution boundary: one active run per repo context.
- Backend boundary: runner executes via SDK transport or command transport.

Target boundary contract (for ongoing refactor) is defined in `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`.
Core orchestration MUST evolve toward provider/channel-agnostic interfaces (`AgentRuntimeAdapter`, `DeliveryAdapter`, `SessionRoutingPolicy`, `SessionStore`).

Current refactor target:

- `src/gateway.js` is the composition root and orchestration shell.
- `src/gateway.js` MUST NOT keep accumulating Telegram transport internals or OpenCode raw-payload interpretation.
- provider resolution in `src/providers/*` MUST yield explicit adapter contracts rather than raw provider module bags.
- Telegram-specific delivery behavior belongs under `src/providers/downstream/telegram/*`.
- OpenCode-specific payload parsing, normalization, and projection belong under `src/providers/upstream/opencode/*`.
- Generic-looking compatibility shims such as `src/lib/runner.js` MUST stay compatibility-only until they are removed.

## Module Boundaries

```text
src/
  cli.js
  onboard.js
  gateway.js
  gateway-message-handler.js
  gateway-repo-message-handler.js
  gateway-callback-query-handler.js
  lib/
    config.js
    session-map.js
    runner.js
    md2html.js
```

## Control Flow

1. CLI starts gateway or onboarding.
2. Gateway loads config and builds chat router.
3. Command messages are handled in gateway.
4. Prompt messages dispatch to runner for mapped repo contexts.
5. Runner emits progress and final output; gateway sends Telegram responses.

Refactor target control flow:

1. Telegram adapters decode inbound updates and route them into app/orchestration services.
2. Gateway composes dependencies and coordinates run/session lifecycle.
3. Upstream provider modules own provider-specific raw event parsing and `RunViewSnapshot` construction.
4. Downstream provider modules own transport-specific send/edit/delete/draft/chat-action behavior.
5. App/service modules own config mutation, chat mapping, and command-side business policy.

## Event Handling Topology

Event ingress is unified at Telegram update level and then split into command/callback/prompt paths.

- Telegram transport source: `bot.on('message', handleMessage)` and `bot.on('callback_query', handleCallbackQuery)` in `src/gateway.js`.
- Message classification: `createMessageHandler` parses slash commands and routes onboarding/setup commands before repo-bound dispatch in `src/providers/downstream/telegram/gateway-message-handler.js`.
- Repo-bound dispatch: `createRepoMessageHandler` handles runtime commands (`/status`, `/models`, `/interrupt`, `/restart`) and prompt submission in `src/providers/downstream/telegram/gateway-repo-message-handler.js`.
- Callback classification: `createCallbackQueryHandler` handles structured callback data (`connect:*`, `verbose:*`, model-layer callbacks) in `src/providers/downstream/telegram/gateway-callback-query-handler.js`.
- Runtime event adapter: `runOpencode` in `src/lib/runner.js` normalizes SDK and command transports into internal event primitives (`step_start`, `text`, `tool_use`, `wait`, `raw`).
- Completion path: `startPromptRun` in `src/gateway.js` records provider completion as an in-run phase, while run lifecycle termination occurs only at same-session next-run handoff or explicit session end.

### Run View Snapshot Boundary

The canonical upstream->downstream rendering boundary is `RunViewSnapshot`.

- Upstream responsibility: parse provider-specific raw events and materialize snapshot state as logical render blocks.
- Downstream responsibility: consume snapshot text blocks, apply channel formatting, then perform channel-safe diff/send/edit/delete and any required post-format chunking.

Current module mapping:

- Snapshot materializer: `src/providers/upstream/opencode/run-view-snapshot.js`
- Upstream event state projection: `src/providers/upstream/opencode/render-state.js`
- Snapshot text building: `src/providers/upstream/opencode/view-builder.js`
- Downstream reconcile execution: `src/providers/downstream/telegram/view-reconciler.js`
- Upstream adapter contract wrapper: `src/providers/upstream/opencode/adapter.js`
- Downstream adapter contract wrapper: `src/providers/downstream/telegram/adapter.js`

Boundary rule:

- Downstream modules MUST NOT depend on OpenCode raw event fields (`message.part.delta`, `session.status`, etc.).
- Gateway orchestrates snapshot flow and MUST pass provider-agnostic logical snapshot messages into downstream reconcile.
- Transport-size chunking is a downstream concern and MUST NOT leak back into upstream snapshot construction.
- Gateway MAY coordinate run-view application timing, but transport retries, draft/materialize policy, and channel chat-action effects MUST terminate in downstream adapter modules.
- Once equivalent upstream-normalized/session-aware data exists, gateway MUST NOT inspect OpenCode raw payload shape for normal delivery decisions.

### Event Concurrency Contract

- Per-repo serialization uses `withStateDispatchLock` in `src/gateway.js` and `src/providers/downstream/telegram/gateway-message-handler.js`.
- Control-command bypass for immediate interruption/restart (`/interrupt`, `/restart`) skips dispatch lock in `src/providers/downstream/telegram/gateway-message-handler.js`.
- Prompt work is queue-backed per repo (`state.queue`) and one-active-run per repo (`state.running`) in `src/providers/downstream/telegram/gateway-repo-message-handler.js` and `src/gateway.js`.

## Observability

Development/debug runtime uses dense structured audit logs.

- File: `runtime/audit-events.jsonl` (or `${HERMUX_RUNTIME_DIR}/audit-events.jsonl`)
- Source: `src/lib/audit-log.js` and integration points in `src/gateway.js`
- Coverage:
  - inbound Telegram updates (`telegram.update`)
  - message/callback router decisions (`router.message.*`, `router.callback.*`, `repo.message.*`)
  - normalized runtime events and reaction decisions (`run.event_received`, `run.reaction`, `run.finalization`, `run.complete`, `run.error`)
  - final/reminder/UI/reconcile internals (`run.final_pipeline.*`, `run.reconcile.*`, `run.ui.*`, `run.final_unit_send*`, `run.heartbeat.*`)
  - Telegram API outcomes (`telegram.send`, `telegram.edit`, `telegram.delete`, `telegram.send_photo`, `telegram.send_document`)
  - chunked-send boundaries and completion (`telegram.send_batch.start`, `telegram.send_batch.complete`)

## Isolation Model

Per repo context state includes:

- run lock and queue
- verbosity mode
- process/session references
- wait/interrupt state

This state is not shared across repo contexts.

## Runtime Executor Lifecycle

- scope key: `repoName::workdir`
- runtime status key: in-memory state keyed by scope in `src/lib/runner.js`

Recovery guarantees:

- per-scope active run tracking
- explicit global executor stop during restart/shutdown
- command-transport timeout kill fallback

## Command Surface (Current)

- setup/mapping: `/onboard`, `/onboard cancel`, `/init`, `/init confirm`, `/repos`, `/connect <repo>`, `/whereami`, `/help`
- runtime: `/start`, `/status`, `/models`, `/session`, `/version`, `/revert`, `/unrevert`, `/verbose`, `/interrupt`, `/restart`, `/reset`
- utility: `/test`

## Data and Persistence

- config: `config/instances.json`
- session map: runtime session map file
- runtime status/state: in-memory map in `src/lib/runner.js`
- run logs: per-repo log path
- telegram e2e stub fixture: `test/fixtures/telegram-mock-server.js`

## Failure Semantics

- unmapped chat interactions return setup/connect guidance
- runner errors/timeouts return explicit error responses
- interrupt and restart are idempotent at command level
- restart/shutdown attempts runtime executor cleanup first

## Reference Contracts

- user behavior contracts: `docs/specs/UX_SPEC.md`
- interface contracts: `docs/specs/COMPONENT_CONTRACTS.md`
- session/event routing contracts: `docs/specs/SESSION_EVENT_ROUTING_SPEC.md`
- strategy+DI adapter contracts: `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`
