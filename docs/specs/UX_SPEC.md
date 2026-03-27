# UX Spec

This document defines user-visible behavior contracts.

## Scope

In scope:

- onboarding and repo mapping in Telegram
- prompt execution interaction model
- runtime control commands and outcomes
- error and retry UX semantics

Out of scope:

- internal module composition
- low-level process orchestration details

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
2. Gateway executes in mapped repo context.
3. User receives final response and status updates.

Contract:

- only one active execution per repo context
- queued prompts execute in order
- final output is delivered or explicit failure is shown

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

## Unmapped Chat Behavior

- setup commands remain available in unmapped chats
- free-text prompt in unmapped chat returns setup guidance

## Output Contract

- Markdown output is converted to Telegram-safe HTML when possible
- on HTML send/edit failure, plain text retry is used
- long messages are chunked to Telegram-safe limits
- when a new run starts in the same session, prior-run Telegram run-view body blocks MUST remain visible in chat history, and the new run MUST start its own fresh status-panel message below the new user turn
- when a new run starts and the previous private-chat Telegram draft preview contains any non-whitespace text, that preview MUST be materialized into a normal message before the new run resets downstream run-view state
- during an active run, when a private-chat assistant text tail receives a stable `message.part.updated` after prior deltas, Telegram delivery SHOULD materialize that tail immediately instead of leaving it in draft preview until completion or next-run fallback
- while a session is busy, mapped Telegram chats SHOULD emit `typing` chat actions until the session becomes idle or the run ends
- status pane SHOULD append the latest reasoning preview as its final line when reasoning text exists, prefixed with a thinking emoji
- status pane MUST render active upstream `question.asked` prompts as visible text instead of leaving them only in raw-event or draft-only paths, so the user can answer from Telegram immediately
- status pane MUST render active upstream `permission.asked` prompts as visible text so Telegram users can approve or reject stalled work without opening another interface
- unresolved button-only question prompts MUST NOT swallow later plain-text Telegram prompts; only explicit custom-input capture mode may treat free text as a question answer
- removed message and part events MUST retract deleted content from future Telegram run-view reconciliation instead of leaving stale assistant text visible
- session compaction and deletion MUST update projected state without breaking same-session event acceptance or leaving stale question/permission prompts open
- when a run starts with existing session continuity, the status pane MUST warn that model context may include earlier turns hidden from the current run view
- when upstream reports session compaction, the status pane MUST warn that model context may no longer match the visible chat history exactly
- delegated subagent/task work that remains active inside the same session MUST keep the status surfaces visibly busy until the delegated work reaches a terminal state
- `/interrupt` MUST remain available while same-session delegated work is still active; it may only fall back to "no running task" after delegated work actually becomes non-interruptible under the session lifecycle rules
- `<system-reminder>` content is rendered at the bottom of the live status panel and MUST appear as a code block

## Failure Semantics

- mapping conflict shows actionable error
- backend timeout reports timeout state
- backend execution error reports user-visible error with retry direction
- missing mapping reports onboarding/connect guidance

## Non-Goals

- no guarantee of preserving old legacy alias commands
- no guarantee for historical temporary output-normalization behavior
