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

## Unmapped Chat Behavior

- setup commands remain available in unmapped chats
- free-text prompt in unmapped chat returns setup guidance

## Output Contract

- Markdown output is converted to Telegram-safe HTML when possible
- on HTML send/edit failure, plain text retry is used
- long messages are chunked to Telegram-safe limits

## Failure Semantics

- mapping conflict shows actionable error
- backend timeout reports timeout state
- backend execution error reports user-visible error with retry direction
- missing mapping reports onboarding/connect guidance

## Non-Goals

- no guarantee of preserving old legacy alias commands
- no guarantee for historical temporary output-normalization behavior
