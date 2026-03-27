# Component Contracts

This document defines interface-level contracts used to implement and test the system.

## 1) CLI Contract (`src/cli.js`)

Supported commands:

- `start`
- `onboard`
- `init --yes [--full]`
- `help` / `--help` / `-h`

Contract:

- unknown command exits non-zero with help hint
- `start` launches gateway (daemon mode by default, foreground for child/flag path)
- `init --yes` resets repos/sessions and keeps global token
- `init --yes --full` also clears global token

## 2) Configuration Contract (`src/lib/config.js`)

Canonical config shape:

- `global.telegramBotToken: string`
- `repos[]` with:
  - `name: string`
  - `enabled: boolean`
  - `workdir: absolute path string`
  - `chatIds: string[]`
  - `opencodeCommand: string`
  - `logFile: string`

Behavior contract:

- legacy `instances[]` input is normalized at load
- repo upsert is keyed by repo `name`
- `addChatIdToRepo` rejects duplicate mapping across different repos
- persistence write is atomic (temp file + rename)

## 3) Session Map Contract (`src/lib/session-map.js`)

Behavior contract:

- map key: `(repoName, chatId) -> sessionId`
- `clearSessionId` is idempotent
- `clearAllSessions` returns count of removed entries

## 4) Gateway Runtime Contract (`src/gateway.js`)

Runtime contract:

- single Telegram polling bot per process
- chat routes to repo by mapping table
- per-repo lock allows one active run
- queued prompts maintain FIFO order
- `src/gateway.js` acts as composition/orchestration root and MUST prefer provider/application facades over direct provider-private logic
- provider resolution in `src/providers/*` MUST return explicit adapter contracts (`runtime`, `render`, `transport`) instead of raw provider module bags
- non-final run-view latest-assistant preview MAY use Bot API `sendMessageDraft` in eligible private-chat flows, while committed status/older messages remain regular Telegram messages
- non-final run-view Telegram send/edit retries MAY degrade by deferring stale updates instead of sleeping inline on long `retry_after`; final-state delivery MUST keep explicit success/failure semantics
- draft-preview transport MUST fall back to regular send/edit preview if the method is unavailable or rejected by the Telegram API

Boundary contract:

- gateway MUST NOT accumulate new Telegram transport-specific send/edit/delete/draft/chat-action behavior; such behavior belongs in `src/providers/downstream/telegram/*`
- gateway MUST NOT accumulate new OpenCode raw payload parsing or provider-event introspection once equivalent upstream-normalized/session-aware data is available
- app/service concerns such as config mutation, model-selection policy, and chat-mapping/session-reset policy SHOULD move behind explicit service seams instead of remaining in Telegram handlers or gateway helpers
- core session-event delivery helpers (for example `src/lib/session-event-handler.js`) MUST use downstream-neutral naming and contracts; Telegram-specific delivery names are forbidden outside Telegram-owned modules

Command handling contract:

- setup commands work in unmapped chats
- mapped chats support runtime-control and prompt execution commands
- callback handlers use explicit `callback_data` contract keys

## 5) Runner Contract (`src/lib/runner.js`)

Execution contract:

- `runOpencode(instance, prompt, handlers)` is primary execution entrypoint
- SDK transport is the default runtime path
- optional command transport fallback can be forced via `HERMUX_EXECUTION_TRANSPORT=command`
- runtime status is tracked by repo scope key
- `src/lib/runner.js` is a compatibility shim over the active upstream provider surface and MUST NOT become a second long-term provider implementation layer

Failure contract:

- timeout and backend errors are surfaced through handler callbacks
- restart/shutdown paths trigger runtime executor cleanup behavior

## 6) Output Transform Contract (`src/lib/md2html.js`)

Contract:

- markdown subset converts to Telegram-safe HTML
- escaping is enforced for unsafe HTML characters
- code blocks and inline code preserve readability semantics
- because this module is channel-specific today, future boundary cleanup SHOULD relocate or rename it to make its Telegram ownership explicit

## 7) Test Mapping Rule

Every contract above must map to at least one test suite section.

- CLI: `test/cli.test.js`
- Config/session: `test/config.test.js`, `test/session-map.test.js`
- Gateway runtime/UX behavior: `test/gateway-internal.test.js`, `test/gateway-main.test.js`
- Runner runtime lifecycle: `test/runner.test.js`
- Transform: `test/md2html.test.js`

## 8) Session/Event Routing Contract

Normative session-centric routing and audit invariants are defined in:

- `docs/specs/SESSION_EVENT_ROUTING_SPEC.md`

Component-level implementations that touch repo runtime lifecycle, event subscription fan-in, or event identity extraction MUST stay aligned with that spec.

## 9) Adapter Strategy + DI Contract

Normative adapter and DI contracts are defined in:

- `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`

Component-level implementations that touch upstream runtime providers or downstream delivery channels MUST stay aligned with that spec.

## 10) RunView Snapshot Contract

Interface-level boundary for rendering flow:

- Upstream emits a materialized `RunViewSnapshot` with:
  - `runId: string`
  - `sessionId: string`
  - `messages: string[]`
  - `isFinal: boolean`
- Downstream consumes `messages` (or commands derived from message diff) only.

Contract rules:

- Downstream components MUST NOT parse provider raw event schemas.
- Upstream components own provider event parsing and state projection.
- Snapshot emission must allow last-snapshot application without semantic loss at downstream boundary.
- `isFinal` marks provider phase completion for the emitting run snapshot; it MUST NOT be interpreted as session lifecycle termination.
- `runId` remains a correlation field for rendering/audit, while lifecycle ownership still follows session-first routing and next-run/session-end termination semantics from `docs/specs/SESSION_EVENT_ROUTING_SPEC.md`.
- Status-pane rendering SHOULD include the latest reasoning preview as the final line when upstream render state exposes reasoning text.
- Upstream `question.asked` events MUST be projected into `RunViewSnapshot` as visible status-pane content, not left as provider-specific raw events or draft-only tails.
- Upstream `permission.asked` events MUST be projected into `RunViewSnapshot` as visible status-pane content and synchronized into Telegram-local approval UI state.
- Telegram inbound message routing MUST only divert plain text into question-answer handling when `questionFlow.waitingForCustomInput === true`; button-only question flows must fall through to normal repo prompt dispatch.
- Telegram callback routing MUST support approval actions for active permission requests and translate them into `permission.reply` SDK calls without bypassing session-owned render state.
- Upstream `message.removed`, `message.part.removed`, `session.compacted`, `session.created`, and `session.deleted` events MUST be reduced in `render-state` before downstream reconciliation; Telegram delete/edit behavior is derived only from resulting snapshot changes.
- Additional v2 part subtypes (`subtask`, `agent`, `retry`, `compaction`, `snapshot`, `patch`) MUST be preserved in reducer state and surfaced through snapshot text/status semantics rather than dropped on ingest.
- Run-view status rendering MUST accept an explicit continuity-warning signal for reused/forked session continuity and render it as visible warning text rather than hiding it in audit-only state.
- Run-view status rendering MUST derive a compaction warning from reduced session state when `session.compacted` has been observed, so downstream users are told that visible chat history may diverge from upstream model context.
- Run-view status rendering MUST treat same-session delegated tool/task parts with active running state as busy authority even when no fresh `session.status busy` event arrives, and it MUST return to idle only after those delegated parts reach terminal state.
- Run-view snapshot inspection MAY derive an active background-tool count by scanning reduced tool parts with the same active-status predicate used for busy authority; cumulative counters like `toolCount` and `stepCount` MUST NOT be repurposed as active background counts.
- When a new run starts in the same session, downstream reconciliation MUST preserve prior-run chat history and start a fresh status-panel message for the new run instead of reusing prior-run body or status slots.
- Run-start handoff MUST materialize any non-empty prior Telegram draft preview before `state.runView` is reset for the next run; empty draft previews are ignored.
- Active-run Telegram reconciliation SHOULD treat `tailMaterializeHint.reason === "text_part_updated_after_delta"` as a strong boundary for immediate tail materialization while preserving weaker hints for fallback-only behavior.
- Gateway runtime SHOULD renew Telegram `typing` chat actions while the active session snapshot reports `render.busy === true`, and stop renewing when the session goes idle or the run exits.
- Gateway runtime command status and interrupt eligibility MUST NOT drop to idle solely because the outer run observer becomes quiet while a same-session delegated tool/task is still running.
- Telegram interrupt handling MUST distinguish `idle` from `busy but non-interruptible`; the latter SHOULD surface explicit fallback controls and MUST NOT claim that a kill/interrupt already happened when the system only queued or sent a stop prompt.
- `RunViewSnapshot` delivery is the only supported render contract between upstream and downstream modules; downstream behavior changes MUST be expressed through snapshot semantics or downstream-local policy, not through upstream raw event knowledge in gateway.

Current implementation anchors:

- `src/providers/upstream/opencode/run-view-snapshot.js`
- `src/providers/upstream/opencode/render-state.js`
- `src/providers/upstream/opencode/view-builder.js`
- `src/providers/downstream/telegram/view-reconciler.js`
