# Event Handling Comparison

This document compares event handling across:

- `hermux` (this repository)
- `ref/opencode-telegram-bot` (`grinev/opencode-telegram-bot`)
- `ref/opencode-telegram` (`Tommertom/opencode-telegram`)

## Scope

- Telegram update classification (message/callback/command)
- OpenCode event intake and per-type dispatch
- Session and concurrency state boundaries
- User-visible reply strategy

## Setup Actions Completed

1. `ref/` directory created and added to `.gitignore`.
2. Cloned:
   - `https://github.com/grinev/opencode-telegram-bot` -> `ref/opencode-telegram-bot`
   - `https://github.com/Tommertom/opencode-telegram` -> `ref/opencode-telegram`

## Reference A: grinev/opencode-telegram-bot

### Telegram update classification

- Startup removes webhook, then starts long polling (`ref/opencode-telegram-bot/src/app/start-bot-app.ts:38`, `ref/opencode-telegram-bot/src/app/start-bot-app.ts:45`).
- Update pipeline is middleware-first (`auth -> command init -> interaction guard`) before handlers (`ref/opencode-telegram-bot/src/bot/index.ts:526`, `ref/opencode-telegram-bot/src/bot/index.ts:527`, `ref/opencode-telegram-bot/src/bot/index.ts:528`).
- Commands are explicit registrations (`bot.command(...)`) for operational verbs (`ref/opencode-telegram-bot/src/bot/index.ts:543`).
- Callback queries are centralized through one `bot.on("callback_query:data", ...)` fan-out chain (`ref/opencode-telegram-bot/src/bot/index.ts:558`).
- Free text prompt path is separated from command path (`ref/opencode-telegram-bot/src/bot/index.ts:701`, `ref/opencode-telegram-bot/src/bot/index.ts:707`).

### OpenCode event dispatch model

- SSE subscription is directory-scoped with reconnect/backoff and abort control (`ref/opencode-telegram-bot/src/opencode/events.ts:44`, `ref/opencode-telegram-bot/src/opencode/events.ts:67`, `ref/opencode-telegram-bot/src/opencode/events.ts:169`).
- Event types are normalized by `summaryAggregator.processEvent` switch (`ref/opencode-telegram-bot/src/summary/aggregator.ts:202`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:219`).
- Key event-to-handler mapping:
  - `message.updated` -> `handleMessageUpdated` (message lifecycle, completion detection) (`ref/opencode-telegram-bot/src/summary/aggregator.ts:220`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:286`)
  - `message.part.updated` -> `handleMessagePartUpdated` (text/tool part handling, dedupe) (`ref/opencode-telegram-bot/src/summary/aggregator.ts:223`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:383`)
  - `session.idle` -> `handleSessionIdle` (typing stop) (`ref/opencode-telegram-bot/src/summary/aggregator.ts:229`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:646`)
  - `session.compacted` -> `handleSessionCompacted` (context reload callback) (`ref/opencode-telegram-bot/src/summary/aggregator.ts:232`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:663`)
  - `question.asked` -> `handleQuestionAsked` (interactive question flow) (`ref/opencode-telegram-bot/src/summary/aggregator.ts:235`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:688`)
  - `permission.asked` -> `handlePermissionAsked` (interactive approval flow) (`ref/opencode-telegram-bot/src/summary/aggregator.ts:247`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:742`)

### Side effects strategy

- Aggregator callbacks are wired in bot bootstrap to send final output, tool summaries/files, questions, permission requests, token/context updates (`ref/opencode-telegram-bot/src/bot/index.ts:166`, `ref/opencode-telegram-bot/src/bot/index.ts:209`, `ref/opencode-telegram-bot/src/bot/index.ts:262`, `ref/opencode-telegram-bot/src/bot/index.ts:305`, `ref/opencode-telegram-bot/src/bot/index.ts:338`).
- Interaction isolation is explicit (single active interaction kind; stale callbacks blocked) (`ref/opencode-telegram-bot/src/bot/handlers/inline-menu.ts:121`, `ref/opencode-telegram-bot/src/bot/handlers/inline-menu.ts:149`).

## Reference B: Tommertom/opencode-telegram

### Telegram update classification

- Commands and message types are directly registered in one class (`ref/opencode-telegram/src/features/opencode/opencode.bot.ts:40`, `ref/opencode-telegram/src/features/opencode/opencode.bot.ts:60`, `ref/opencode-telegram/src/features/opencode/opencode.bot.ts:68`).
- Callback data handling is direct and narrow (`esc`, `tab`) (`ref/opencode-telegram/src/features/opencode/opencode.bot.ts:56`, `ref/opencode-telegram/src/features/opencode/opencode.bot.ts:57`).
- Non-command text routes to prompt sender (`ref/opencode-telegram/src/features/opencode/opencode.bot.ts:67`, `ref/opencode-telegram/src/features/opencode/opencode.bot.ts:266`).

### OpenCode event dispatch model

- `eventHandlers` object is a type-keyed map from `Event["type"]` to handler functions (`ref/opencode-telegram/src/features/opencode/opencode.event-handlers.ts:54`, `ref/opencode-telegram/src/features/opencode/opencode.event-handlers.ts:62`).
- `processEvent(...)` resolves handler by `event.type` and executes it (`ref/opencode-telegram/src/features/opencode/opencode.event-handlers.ts:117`, `ref/opencode-telegram/src/features/opencode/opencode.event-handlers.ts:124`).
- OpenCode service consumes subscription stream and calls `processEvent` per event (`ref/opencode-telegram/src/features/opencode/opencode.service.ts:74`, `ref/opencode-telegram/src/features/opencode/opencode.service.ts:82`).

### Side effects strategy

- Per-event handlers often emit directly to Telegram API and/or local logs/files.
- Example: `session.status` handler writes latest event payload to disk (`events/*.last.json`) (`ref/opencode-telegram/src/features/opencode/event-handlers/session.status.handler.ts:16`, `ref/opencode-telegram/src/features/opencode/event-handlers/session.status.handler.ts:23`).
- Example: `message.part.updated` delegates by part subtype (reasoning/tool/text) (`ref/opencode-telegram/src/features/opencode/event-handlers/message.part.updated.handler.ts:19`, `ref/opencode-telegram/src/features/opencode/event-handlers/message.part.updated.handler.ts:25`, `ref/opencode-telegram/src/features/opencode/event-handlers/message.part.updated.handler.ts:31`).

## Hermux Event Handling (Current)

### Telegram update classification

- Single polling bot receives two top-level streams:
  - `message` -> `handleMessage`
  - `callback_query` -> `handleCallbackQuery`
  (`src/gateway.js:2325`, `src/gateway.js:2326`)
- Message handler prioritizes setup flow (`/onboard`, `/init`, onboarding answers), then command routing, then repo-bound handling (`src/gateway-message-handler.js:29`, `src/gateway-message-handler.js:34`, `src/gateway-message-handler.js:39`, `src/gateway-message-handler.js:68`).
- Callback handler routes by `callback_data` prefix (`connect:*`, `verbose:*`, `interrupt:now`, model-layer prefixes) (`src/gateway-callback-query-handler.js:41`, `src/gateway-callback-query-handler.js:50`, `src/gateway-callback-query-handler.js:69`, `src/gateway-callback-query-handler.js:99`).

### Repo-level command and prompt dispatch

- Repo command handler covers runtime control (`/status`, `/models`, `/session`, `/reset`, `/interrupt`, `/restart`) and prompt enqueue/start (`src/gateway-repo-message-handler.js:47`, `src/gateway-repo-message-handler.js:57`, `src/gateway-repo-message-handler.js:62`, `src/gateway-repo-message-handler.js:76`, `src/gateway-repo-message-handler.js:134`, `src/gateway-repo-message-handler.js:169`).
- Per-repo dispatch lock serializes commands/prompts, except `/restart` and `/interrupt` which intentionally bypass lock for responsiveness (`src/gateway-message-handler.js:106`, `src/gateway-message-handler.js:111`).

### OpenCode event intake

- `runOpencode` abstracts SDK and command transports, normalizing runtime events into `step_start`, `step_finish`, `text`, `tool_use`, `wait`, `raw` (`src/lib/runner.js:629`, `src/lib/runner.js:343`, `src/lib/runner.js:201`).
- SDK path builds final text from `message.part.updated` text parts and marks completion at `session.idle` (`src/lib/runner.js:525`, `src/lib/runner.js:555`, `src/lib/runner.js:596`).
- Gateway execution loop consumes normalized events in `startPromptRun` and updates status panel, stream preview, and final output behavior (`src/gateway.js:1836`, `src/gateway.js:1954`, `src/gateway.js:2041`).

### Session and concurrency contract

- One active run per repo state (`state.running`), FIFO queue for pending prompts (`state.queue`) (`src/gateway-repo-message-handler.js:160`, `src/gateway-repo-message-handler.js:169`).
- Session continuity is `(repo, chatId) -> sessionId` via session map and persisted on completion (`src/gateway.js:1856`, `src/gateway.js:2057`).

## Comparison Summary

1. Dispatch granularity:
   - `grinev`: centralized aggregator callback fan-out after SSE.
   - `tommertom`: direct event-type map to handlers.
   - `hermux`: normalized runtime event primitives consumed by queue-driven run loop.
2. Concurrency model:
   - `grinev`: interaction-state guard; single active interaction.
   - `tommertom`: mostly per-user session map with direct sends.
   - `hermux`: strict per-repo execution lock + queue, with control-command bypass branch.
3. Callback complexity:
   - `grinev`: broad callback ecosystem (session/project/question/permission/model/agent/variant/context).
   - `tommertom`: minimal callback set (`esc`/`tab`).
   - `hermux`: operational callback set (`connect`, `verbose`, `interrupt`, model layers).
4. Event-response UX:
   - `grinev`: rich staged notifications (thinking/tool/question/permission/file).
   - `tommertom`: simpler direct messages and per-event outputs.
   - `hermux`: status panel + stream preview + final response + queue-aware progress.

## External Corroboration

### grinev/opencode-telegram-bot

- README documents strict interaction gating while active flows are running (allowed utility commands only), which matches middleware + interaction guard behavior observed in code.
  - Source: https://github.com/grinev/opencode-telegram-bot/blob/03e9e697d4a6d85d5a7df90dfda07ca6bfa2e0ee/README.md#L89-L113
- README states persistent SSE + long polling and warns against auto-restart because it breaks active tasks, consistent with `events.ts` reconnect lifecycle and long-polling startup.
  - Source: https://github.com/grinev/opencode-telegram-bot/blob/03e9e697d4a6d85d5a7df90dfda07ca6bfa2e0ee/README.md#L196-L197
- PRODUCT documents the event bridge model (OpenCode SSE -> aggregation -> Telegram output), matching aggregator callback architecture.
  - Source: https://github.com/grinev/opencode-telegram-bot/blob/03e9e697d4a6d85d5a7df90dfda07ca6bfa2e0ee/PRODUCT.md#L7-L13
  - Source: https://github.com/grinev/opencode-telegram-bot/blob/03e9e697d4a6d85d5a7df90dfda07ca6bfa2e0ee/PRODUCT.md#L56-L66

### Tommertom/opencode-telegram

- README positions command-driven session control and ESC/TAB control keyboard behavior, matching command/callback wiring in `opencode.bot.ts`.
  - Source: https://github.com/Tommertom/opencode-telegram/blob/230fae4d1b4e7305be66b6de97a1529f11051a34/README.md#L42-L62
- README differentiates runtime persistence scope and restart reset behavior, matching in-memory user-session map design.
  - Source: https://github.com/Tommertom/opencode-telegram/blob/230fae4d1b4e7305be66b6de97a1529f11051a34/README.md#L95-L97
  - Source: https://github.com/Tommertom/opencode-telegram/blob/230fae4d1b4e7305be66b6de97a1529f11051a34/README.md#L429-L430
- Repository docs define event architecture and explicit event taxonomy (`message.part.updated`, `session.status`, `session.idle`, etc.), matching internal `eventHandlers` map.
  - Source: https://github.com/Tommertom/opencode-telegram/blob/230fae4d1b4e7305be66b6de97a1529f11051a34/docs/event-handler-architecture.md#L5-L15
  - Source: https://github.com/Tommertom/opencode-telegram/blob/230fae4d1b4e7305be66b6de97a1529f11051a34/docs/opencoder-events.md#L354-L464

## Cycle 2: Output Translation Fidelity (Focused)

This cycle focuses only on output-type translation quality:

- lost output parts
- intermediate output accidentally merged into final output
- system/internal payload leaking to user-visible output

### Type-by-type translation matrix

| Output category | Hermux (current) | grinev/opencode-telegram-bot | Tommertom/opencode-telegram | Main risk in Hermux |
| --- | --- | --- | --- | --- |
| Final assistant text | SDK path builds final text from `message.part.updated` text parts (`src/lib/runner.js:596`, `src/lib/runner.js:599`); final send prefers `metaFinalText` then stream final (`src/gateway.js:1236`, `src/gateway.js:2063`) | Aggregator buffers text parts and emits on completion (`ref/opencode-telegram-bot/src/summary/aggregator.ts:320`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:361`) | Prompt response path joins text parts; stream text also edits interim message (`ref/opencode-telegram/src/features/opencode/opencode.service.ts:112`, `ref/opencode-telegram/src/features/opencode/event-handlers/message-part-updated/text-part.handler.ts:46`) | Command transport keeps only last text chunk (`src/lib/runner.js:257`), so multi-chunk finals can be truncated |
| Intermediate reasoning text | Routed as `textKind='reasoning'`, shown in stream panel only (`src/lib/runner.js:589`, `src/gateway.js:1975`) | Think/tool service messages are batched and optional by config (`ref/opencode-telegram-bot/src/bot/index.ts:335`, README service interval) | Separate ephemeral "Reasoning" message with auto-delete (`ref/opencode-telegram/src/features/opencode/event-handlers/message-part-updated/reasoning-part.handler.ts:16`) | Reasoning can visually dominate stream preview but is excluded from final candidate by design (`src/gateway.js:1975`, `src/gateway.js:2065`) |
| Tool events | Converted to `tool_use`, reflected in panel/tool counters (`src/lib/runner.js:578`, `src/gateway.js:1990`) | Tool calls are deduped/batched and flushed before final message (`ref/opencode-telegram-bot/src/summary/aggregator.ts:467`, `ref/opencode-telegram-bot/src/bot/index.ts:177`) | Separate ephemeral tool message with delete timeout (`ref/opencode-telegram/src/features/opencode/event-handlers/message-part-updated/tool-part.handler.ts:16`) | Verbose tool message branch is effectively muted in normal path due to `!statusMsgId` condition (`src/gateway.js:1999`) |
| Session/system events | Unknown/non-text SDK events mostly downgraded to `raw` (`src/lib/runner.js:561`, `src/lib/runner.js:603`) | Event switch handles selected types and ignores out-of-session events (`ref/opencode-telegram-bot/src/summary/aggregator.ts:219`, `ref/opencode-telegram-bot/src/summary/aggregator.ts:390`) | Many handlers persist event snapshots and return null (`ref/opencode-telegram/src/features/opencode/opencode.event-handlers.ts:124`, `ref/opencode-telegram/src/features/opencode/event-handlers/session.status.handler.ts:23`) | Type fidelity drops when everything unmodeled is collapsed to raw JSON blobs |
| Errors/retries | `session.error` and parse failures become `raw`; retry status mapped to `wait` (`src/lib/runner.js:532`, `src/lib/runner.js:550`) | SSE reconnect/backoff + event loop yielding for reliability (`ref/opencode-telegram-bot/src/opencode/events.ts:69`, `ref/opencode-telegram-bot/src/opencode/events.ts:89`) | Stream loop lacks reconnect/backoff and exits on error (`ref/opencode-telegram/src/features/opencode/opencode.service.ts:74`) | Raw fallback message can expose internal payload snippets (`src/gateway.js:2104`, `src/gateway.js:2110`) |

### Concrete leakage/merge-loss hotspots (Hermux)

1. Command-mode text accumulation loss:
   - `runViaCommand` assigns `latestFinalText = text` on each `text` event (`src/lib/runner.js:257`), not append/ordered merge.
2. Raw fallback leakage:
   - no-final fallback includes sampled raw payloads (`src/gateway.js:2104`, `src/gateway.js:2110`).
3. Intermediate/final ambiguity in stream UI:
   - reasoning and final share the stream panel channel; only final is selected for final output (`src/gateway.js:1975`, `src/gateway.js:1978`, `src/gateway.js:2065`).
4. Over-broad raw coercion:
   - SDK unknown events and unsupported parts are serialized to `raw` by default (`src/lib/runner.js:561`, `src/lib/runner.js:603`).

### Keep-existing-direction constraint

This cycle does **not** replace the existing improvement baseline. It only tightens it with output-type fidelity focus:

- Keep `event-normalizer` vs `event-renderer` split direction.
- Keep typed gateway event contract direction.
- Keep stale-callback protection direction.
- Keep compatibility branches for ultrawork (`model-layer bifurcation`, `interrupt/restart fast path`, `transport fallback`, `session continuity map`).

### Oracle-validated mitigation order (cycle 2)

To preserve the current baseline while reducing loss/merge/leak risk, apply mitigation in this order:

1. Typed normalization gate first.
   - Introduce canonical classes at runner->gateway boundary:
     - `final_text`
     - `stream_text`
     - `reasoning`
     - `tool`
     - `system_internal`
     - `raw_unknown`
   - Add explicit visibility metadata (`user_visible`, `stream_only`, `diagnostic_only`).
2. Command transport semantics second.
   - In command mode, treat plain text chunks as `stream_text` by default.
   - Promote to `final_text` only by deterministic policy (terminal signal + validated final candidate).
3. Deterministic finalization third.
   - Resolution order:
     - `metaFinalText`
     - validated `final_text`
     - merged `stream_text` candidate
     - safe no-output fallback
   - Freeze final candidate only after terminal/flush completion to avoid late overwrite races.
4. Raw/system quarantine fourth.
   - `raw_unknown` and `system_internal` must not be inserted into final user-visible text.
   - Keep them in diagnostics/trace only.
5. Pre-final flush and stale-filter precondition fifth.
   - Flush tool/intermediate buffers before final send.
   - Enforce stale callback/session guard before finalization side effects.
6. Guardrail tests sixth.
   - No chunk loss on multi-part streams.
   - No reasoning/raw/system leakage into final.
   - Final precedence remains deterministic under mixed meta+stream input.
   - Stale callback cannot mutate finalized output.

### Risk trade-offs noted by Oracle

- Do not silently discard unknown provider events forever; quarantine + metrics first.
- Do not freeze final too early; tie freeze to terminal and buffer flush completion.
- Dedupe must key by chunk identity/event id, not semantic text alone, to avoid suppressing intentional repeats.

## Improvement Plan for Hermux

### 1) Separate event normalization from UI side effects

Introduce explicit `event-normalizer` and `event-renderer` boundaries so SDK/command transport and Telegram rendering evolve independently.

- Why: current `startPromptRun` combines normalization consumption, panel logic, and finalization in one large flow.
- Target: keep `runOpencode` event schema stable and move rendering policy to a dedicated module.

### 2) Add typed event contract for gateway loop

Define a documented internal event union (including payload constraints) for:

- `step_start`
- `step_finish`
- `tool_use`
- `text` (`reasoning` vs `final`)
- `wait`
- `raw`

Why: strengthens regression testing and clarifies compatibility between transports.

### 3) Extend callback strategy with stale-callback protection

Adopt active-interaction metadata checks (message id + intent kind), similar to `grinev` inline-menu stale callback rejection.

Why: prevents outdated model/verbose/connect callbacks from mutating state unexpectedly in busy chats.

### 4) Structured event audit logs (optional debug mode)

Add a debug-only event trace sink (JSON lines, bounded retention) for:

- inbound Telegram update classification
- normalized runtime events
- finalization decision path

Why: simplifies diagnosis for queue stalls, retries, and no-output fallback paths.

## Mandatory Compatibility Branching (oh-my-opencode + ultrawork plugin)

The following divergences are required and should remain explicit branches, not unified away:

1. Model-layer bifurcation is mandatory.
   - Hermux must preserve separate control surfaces for OpenCode core model and oh-my-opencode agent model overrides (`/models` + callback layer branches in `src/gateway.js` and `src/gateway-callback-query-handler.js`).
   - Reason: ultrawork/plugin workflows can require agent-specific model pinning independent of base OpenCode model.

2. Control-command fast path is mandatory.
   - `/interrupt` and `/restart` must continue bypassing the normal dispatch lock (`src/gateway-message-handler.js:106`).
   - Reason: ultrawork loops can generate long-running tasks; interruption must preempt queued work.

3. Transport compatibility branch is mandatory.
   - Keep SDK-first with explicit command fallback (`OMG_EXECUTION_TRANSPORT`) in `src/lib/runner.js:163`.
   - Reason: plugin or environment constraints may force command transport temporarily.

4. Session continuity by `(repo, chat)` is mandatory.
   - Keep session persistence in session map (`src/gateway.js:2057`).
   - Reason: ultrawork workflows depend on deterministic continuation scope.

### Recommended handling strategy

- Keep these as first-class, documented branch points in architecture docs.
- Add targeted contract tests per branch (model layers, interrupt bypass, transport switch, session persistence).
- Avoid collapsing branches into generic abstractions that hide operational intent.
