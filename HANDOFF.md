# Handoff

Last updated: 2026-03-16 (Asia/Seoul)

## Current Problem

Telegram run-view delivery can appear frozen for several minutes while session late events continue to arrive.

## Direct Cause

- The blocking command was `telegram.edit` on run-view content message `5959`.
- Channel: `run_view_edit`
- Index: `1`
- Telegram returned `retry_after` and the gateway slept inside the edit path.

Primary evidence:

- `runtime/audit-events.jsonl:954115`
  - `2026-03-15T15:55:55.199Z`
  - `kind: "telegram.edit"`
  - `stage: "retry_after_pending"`
  - `messageId: 5959`
  - `retryAfterSeconds: 237`
  - `waitMs: 237228`

- `runtime/audit-events.jsonl:972826`
  - `2026-03-15T15:59:53.641Z`
  - same `messageId: 5959`
  - `stage: "retry_after"`
  - retry succeeded after the sleep

## What This Caused

- While `5959` was blocked, session events kept arriving.
- The per-session throttle merger kept accumulating pending payloads.
- When the blocked edit finally resumed, a large backlog flushed at once.

Backlog evidence:

- `runtime/audit-events.jsonl:972828`
  - `batchSize: 3778`
  - `oldestPendingAgeMs: 239092`
  - `throttleIntervalMs: 500`

## Why This Is Not A Lock Contention Issue

- `runViewLockWaitMs` stayed `0` in the affected apply records.
- The stall is downstream Telegram backpressure, not run-view dispatch lock wait.

## Telemetry Now Present

The gateway now logs the boundaries needed to diagnose this class of issue quickly:

- `telegram.send` / `telegram.edit` with `stage: "retry_after_pending"`
- `run.session_event.apply.batch.begin.oldestPendingAgeMs`
- `run.view.apply.begin/end.runViewLockWaitMs`

Relevant implementation file:

- `src/gateway.js`

## Fast Log Reading Order Next Time

1. Find `retry_after_pending` for the affected `runId`.
2. Check which `messageId` and `channel` were blocked.
3. Check the next `run.session_event.apply.batch.begin` for `batchSize` and `oldestPendingAgeMs`.
4. Confirm `runViewLockWaitMs` to distinguish Telegram backpressure from internal lock wait.

## Open Decision

If this behavior is unacceptable, the next design decision is whether `run_view_edit` should keep waiting on long Telegram `retry_after`, or degrade to a different strategy such as skipping stale edits and sending new chunks later.
