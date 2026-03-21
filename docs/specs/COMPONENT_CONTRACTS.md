# Component Contracts

이 문서는 시스템 구현과 테스트에 사용되는 인터페이스 수준 계약을 정의한다.

이 계약들은 **provider/channel-agnostic**이다. 현재 upstream은 opencode, downstream은 Telegram이지만, 인터페이스 수준의 행동은 구현체가 바뀌어도 유지되어야 한다.

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

- `global.telegramBotToken: string` (현재 downstream channel 설정; 멀티 채널 시 확장 가능)
- `repos[]` with:
  - `name: string`
  - `enabled: boolean`
  - `workdir: absolute path string`
  - `chatIds: string[]`
  - `opencodeCommand: string` (현재 upstream provider 명령; 멀티 프로바이더 시 확장 가능)
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

Session map은 provider/channel에 독립적이다. 어떤 upstream provider에서 발급한 sessionId든 동일한 방식으로 관리된다.

## 4) Gateway Runtime Contract (`src/gateway.js`)

Runtime contract:

- single downstream channel polling per process (현재 Telegram polling bot)
- chat routes to repo by mapping table
- per-repo lock allows one active run
- queued prompts maintain FIFO order
- `src/gateway.js` acts as composition/orchestration root and MUST prefer provider/application facades over direct provider-private logic
- non-final run-view delivery MAY use optimistic transport strategies; final-state delivery MUST keep explicit success/failure semantics

Boundary contract:

- gateway MUST NOT accumulate new downstream transport-specific send/edit/delete/draft/chat-action behavior; such behavior belongs in `src/providers/downstream/<channel>/*`
- gateway MUST NOT accumulate new upstream provider raw payload parsing or provider-event introspection once equivalent upstream-normalized/session-aware data is available
- app/service concerns such as config mutation, model-selection policy, and chat-mapping/session-reset policy SHOULD move behind explicit service seams instead of remaining in downstream handlers or gateway helpers

Command handling contract:

- setup commands work in unmapped chats
- mapped chats support runtime-control and prompt execution commands
- callback handlers use explicit `callback_data` contract keys

## 5) Runner Contract (`src/lib/runner.js`)

Note: runner는 현재 opencode 전용 호환 심(compatibility shim)이다. 목표 아키텍처에서는 `AgentRuntimeAdapter` 인터페이스로 교체되며, provider별 구현이 이 인터페이스를 따르게 된다.

Execution contract:

- `runOpencode(instance, prompt, handlers)` is primary execution entrypoint
- SDK transport is the default runtime path
- optional command transport fallback can be forced via `HERMUX_EXECUTION_TRANSPORT=command`
- runtime status is tracked by repo scope

Failure contract:

- timeout and backend errors are surfaced through handler callbacks
- restart/shutdown paths trigger runtime executor cleanup behavior

## 6) Output Transform Contract (`src/lib/md2html.js`)

Note: 이 모듈은 **Telegram 채널 전용**이다. 리빌드 시 downstream provider(`src/providers/downstream/telegram/`) 하위로 이동해야 한다. 다른 downstream channel(Slack, webhook 등)은 자체 포맷 변환 모듈을 가진다.

Contract:

- markdown subset converts to Telegram-safe HTML
- escaping is enforced for unsafe HTML characters
- code blocks and inline code preserve readability semantics

## 7) Test Mapping Rule

Every contract above must map to at least one test suite section.

- CLI: `test/cli.test.js`
- Config/session: `test/config.test.js`, `test/session-map.test.js`
- Gateway runtime/UX behavior: `test/gateway-internal.test.js`, `test/gateway-main.test.js`
- Runner runtime lifecycle: `test/runner.test.js`
- Transform: `test/md2html.test.js`

## 8) Session/Event Routing Contract

Normative session-centric routing and audit invariants are defined in:

- [`docs/specs/SESSION_EVENT_ROUTING_SPEC.md`](SESSION_EVENT_ROUTING_SPEC.md)

Component-level implementations that touch repo runtime lifecycle, event subscription fan-in, or event identity extraction MUST stay aligned with that spec. 이 계약은 upstream provider에 독립적이다.

## 9) Adapter Strategy + DI Contract

Normative adapter and DI contracts are defined in:

- [`docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`](ADAPTER_STRATEGY_DI_SPEC.md)

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
- `runId` remains a correlation field for rendering/audit, while lifecycle ownership still follows session-first routing and next-run/session-end termination semantics from [`docs/specs/SESSION_EVENT_ROUTING_SPEC.md`](SESSION_EVENT_ROUTING_SPEC.md).
- When a new run starts in the same session, downstream MUST preserve prior-run chat history and start fresh rendering for the new run.
- `RunViewSnapshot` is the only supported render contract between upstream and downstream; downstream behavior changes MUST be expressed through snapshot semantics or downstream-local policy, not through upstream raw event knowledge.

This contract is the **core extensibility point**: adding a new upstream provider means producing `RunViewSnapshot` from that provider's events; adding a new downstream channel means consuming `RunViewSnapshot` with that channel's formatting.
