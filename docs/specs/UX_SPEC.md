# UX Spec

이 문서는 사용자에게 보이는 행동 계약을 정의한다.

현재 downstream channel은 Telegram이지만, 이 spec의 행동 계약은 **채널에 독립적**이다. 채널별 포맷팅/전송 세부사항은 downstream adapter 내부 관심사이며, 여기서 정의하는 것은 사용자 의도와 시스템 반응의 계약이다.

## Scope

In scope:

- onboarding and repo mapping
- prompt execution interaction model
- runtime control commands and outcomes
- error and retry UX semantics

Out of scope:

- internal module composition
- low-level process orchestration details
- channel-specific rendering/formatting details (downstream adapter 관심사)

## Primary User Journeys

### 1) First-Time Setup

1. User runs onboarding (`npx hermux onboard` or `/onboard` wizard in chat).
2. User provides token/repo/workdir/chat mapping input.
3. System validates and persists config.
4. User verifies routing through `/repos` + `/connect <repo>` + `/whereami`.

Contract:

- invalid input produces explicit corrective message
- onboarding is resumable/retryable
- successful mapping is immediately usable

### 2) Prompt Execution

1. User sends prompt in mapped chat.
2. Gateway executes in mapped repo context via upstream provider (현재 opencode).
3. User receives final response and status updates.

Contract:

- only one active execution per repo context
- queued prompts execute in order
- final output is delivered or explicit failure is shown
- upstream provider는 플러그 가능하며, 현재 opencode SDK가 기본 구현이다

### 3) Runtime Control

Commands and expected effect:

- `/status`: current runtime/session summary
- `/session`: current session identifier information
- `/verbose on|off|status`: verbosity control/query
- `/interrupt`: stop current run (idempotent)
- `/restart`: restart runtime process
- `/reset`: clear chat-scoped session continuity
- `/models`: inspect/update model-layer settings
- `/version`: request version output path
- `/revert`: must be executed as reply to a recent bot output message; requires callback confirmation before execution
- `/unrevert`: restores current revert state only while `session.revert` is still present (before cleanup-triggering continuation)

Lifecycle semantics:

- `run.complete` is a phase change inside the current run, not the end of session lifecycle ownership.
- After `run.complete`, `/interrupt` MUST behave as if there is no interruptible run for that session.
- After `run.complete`, `/revert` MUST remain available for the completed run output until the next run is accepted or the session is ended explicitly.
- `/unrevert` remains available only until the next continuation-cleanup action for that same session.
- `/reset` and explicit session remap/end actions terminate the final run lifecycle for the cleared session.

These semantics apply regardless of which upstream provider or downstream channel is active.

## Unmapped Chat Behavior

- setup commands remain available in unmapped chats
- free-text prompt in unmapped chat returns setup guidance

## Output Contract

- Markdown output is converted to channel-safe format when possible (현재 Telegram: HTML)
- on format send/edit failure, plain text retry is used
- long messages are chunked to channel-safe limits
- when a new run starts in the same session, prior-run body blocks MUST remain visible in chat history, and the new run MUST start its own fresh status-panel message below the new user turn
- when a new run starts, any pending preview content MUST be materialized before resetting downstream state
- while a session is busy, mapped chats SHOULD show activity indicators until the session becomes idle or the run ends

Note: 구체적인 포맷팅 방식(HTML, Markdown, Slack blocks 등)은 각 downstream adapter의 내부 구현이다.

## Failure Semantics

- mapping conflict shows actionable error
- backend timeout reports timeout state
- backend execution error reports user-visible error with retry direction
- missing mapping reports onboarding/connect guidance

## Non-Goals

- no guarantee of preserving old legacy alias commands
- no guarantee for historical temporary output-normalization behavior
