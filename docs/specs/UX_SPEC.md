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
- status pane SHOULD append the latest reasoning preview as its final line when reasoning text exists, prefixed with a thinking emoji
- `<system-reminder>` content is rendered at the bottom of the live status panel and MUST appear as a code block

## Failure Semantics

- mapping conflict shows actionable error
- backend timeout reports timeout state
- backend execution error reports user-visible error with retry direction
- missing mapping reports onboarding/connect guidance

## Non-Goals

- no guarantee of preserving old legacy alias commands
- no guarantee for historical temporary output-normalization behavior
