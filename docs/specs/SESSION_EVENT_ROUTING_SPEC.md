# Session-Centric Event Routing Spec

This spec defines the target architecture for global Hermux daemon event handling across multiple repos.

## 1. Intent

- Hermux daemon is singleton per host/process.
- Each repo scope (`repoName::workdir`) owns exactly one OpenCode server instance.
- Each repo scope owns exactly one active event subscription.
- Global daemon consumes all repo streams and routes primarily by `sessionId`.
- Event processing is independent from run execution state (events can be processed even when no run is active).

Primary objective:

- Filtering is weaker, routing is stronger, observability is higher.
- Hermux MUST ingest all OpenCode events first, then route with strict session-boundary rules.

## 2. Non-Goals

- Router-level dispatch by `runId`.
- Per-run event subscriptions.
- Best-effort/no-audit mode for production debugging timelines.

Anti-goals:

- Dropping events solely because a run is idle/completed/missing.
- Cross-session fallback routing when session identity is ambiguous.

## 3. Core Entities

- `repoScope`: `repoName::workdir`
- `serverEpoch`: monotonic integer bumped whenever repo OpenCode server is recreated
- `subscriptionEpoch`: monotonic integer bumped whenever repo event subscription is recreated
- `sessionId`: OpenCode session id (`ses_*`)
- `sessionTurn`: monotonic counter per `(repoScope, sessionId)` for observability and optional local ordering
- `eventCursor`: daemon-local monotonic cursor per `repoScope` event ingress

Note: `runId` MAY exist for UI/audit correlation but MUST NOT be router key nor acceptance gate.

## 4. Required Invariants

1. For each `repoScope`, OpenCode server instance count MUST be `<= 1`.
2. For each `repoScope`, active subscription count MUST be `<= 1`.
3. Duplicate server start requests MUST be idempotent and return existing handle when healthy.
4. Duplicate subscription requests MUST be idempotent and return existing subscriber handle when healthy.
5. Every accepted or dropped event MUST be auditable with reason.
6. Router decisions MUST include epoch fencing (`serverEpoch`, `subscriptionEpoch`) to reject stale deliveries.
7. Routing decisions MUST be derived from event identity/session fields, not run lifecycle state.
8. Observability failures MUST NOT block routing decisions.

## 5. Subscription and Lifecycle Model

### 5.1 Repo Runtime State Machine

Each `repoScope` runtime uses states:

- `STOPPED`
- `STARTING`
- `RUNNING`
- `STOPPING`
- `FAILED`

Transitions MUST be serialized by per-scope lock.

### 5.2 Idempotent Start/Stop

- `startRepoRuntime(repoScope)`:
  - If `RUNNING`, return existing runtime handle.
  - If `STARTING`, await same in-flight promise and return same handle.
  - Else create server, bump `serverEpoch`, establish subscription, bump `subscriptionEpoch`.
- `stopRepoRuntime(repoScope)`:
  - Safe to call multiple times.
  - MUST close subscription before server close when possible.

### 5.3 Global Daemon Topology

- Daemon owns `N` repo runtimes.
- Daemon owns one routing loop per repo subscription.
- Daemon routing output fans into three lanes:
  - `global lane` (non-session events)
  - `session lane` (events resolved to `sessionId`)
  - `run-observer lane` (optional observer that tracks active run status, never router authority)

Contract:

- Event intake MUST happen before any run-state-based reaction logic.
- Run-observer lane MUST NOT suppress or rebind session-lane events.

## 6. Session ID Extraction Contract

Event-to-session extraction MUST use a typed fallback order defined by the upstream provider adapter.
If extraction yields conflicting session identities within the same event, the event MUST be dropped and audited (`drop_reason=conflicting_session_identity`).

Extraction rule:

- Session identity extraction MUST be deterministic for identical event payloads.
- If event type has no session identity by contract, it MUST remain in global lane.

## 7. Routing Contract

### 7.1 Session-First Routing

- Router key is `(repoScope, sessionId)`.
- Router MUST process session events regardless of run active/idle state.
- Router MUST NOT require `runId` to accept session events.
- Router MUST NOT drop session events solely due turn mismatch or run terminal state.
- Router MUST NOT drop a session event only because it differs from currently active session binding; it MUST route by extracted event session identity.

### 7.2 Global Lane Contract

- Events without resolvable `sessionId` go to global lane.
- Global lane MUST NOT mutate per-session state.
- Global lane MAY update repo-level diagnostics/health snapshots.
- Global lane events MAY be fully audited and observed but MUST NOT be auto-bound to any session.

### 7.3 Run Lifecycle Semantics

- A provider `complete` signal MUST be treated as an in-run phase marker, not as run termination.
- A run MUST remain lifecycle-active until either (a) the next run for the same session starts, or (b) the session ends explicitly.
- The final run in a session MUST remain lifecycle-active until explicit session termination.
- `run.complete` MUST NOT revoke session-event acceptance, session ownership, observer attachment, or session-log collection.
- After `run.complete`, the run MUST no longer be an interrupt target.
- After `run.complete`, the run MUST become eligible as a revert target.
- Starting the next run for the same session MUST atomically terminate the prior run lifecycle and transfer ownership.
- Session-resolved late events for the prior run MUST still be accepted until that atomic handoff occurs.
- Explicit session-ending actions (`/reset`, remap, or equivalent session continuity clear) MUST terminate the final run lifecycle for that session.

Ownership chain after `run.complete`:

- upstream session delivery remains authoritative for same-session late events until next-run handoff or explicit session end
- run-callback raw event flow becomes observational/shadowed once session delivery is attached for the same session
- downstream render ownership remains session-owned through that same handoff/end boundary
- implementation cleanup flags such as `completionHandled` MUST NOT become routing or render-acceptance authority

### 7.4 Stale Event Fencing

Each event carries ingress metadata:

- `repoScope`
- `serverEpoch`
- `subscriptionEpoch`
- `eventCursor`

Events from older epochs MUST be dropped and audited (`drop_reason=stale_epoch`).

Fence semantics:

- Epoch fence is repo-runtime safety fence, not run-state filter.
- For same epoch, out-of-order delivery is tolerated; routing remains session-deterministic.

## 8. Idempotency Contract

Side effects (Telegram send/edit/delete, state transitions, finalization markers) MUST use dedupe key:

`kind + repoScope + sessionId + sessionTurn + sourceEventCursor + targetMessageId`

Rules:

- Duplicate side effects MUST be ignored (idempotent pass).
- Dedupe record SHOULD be retained at least for current + previous `sessionTurn`.
- Every dedupe skip MUST be auditable (`decision=dedup_skip`).

Important:

- Deduplication applies to side effects, not event intake.
- Event intake completeness MUST be preserved even when side effects are deduped.

## 9. Session Turn Contract (관측/분석 보강, 라우팅 강제 아님)

Because routing does not use `runId`, daemon SHOULD track `sessionTurn`:

- Increment when prompt is accepted for `(repoScope, sessionId)`.
- Tag outgoing side effects and state transitions with current `sessionTurn` when available.
- Use turn mismatch for diagnostics/classification, not for primary event acceptance.

Default policy:

- Accept all valid session-resolved events.
- Mark turn-relative classification (`current`, `previous`, `out_of_window`) in audit.
- Drop only for explicit identity/fence violations, not for run/turn freshness alone.

## 10. Audit Contract

### 10.1 Scope and Default

- Audit MUST cover global/session/run-observer lanes.
- Current development default is `ON`.

### 10.2 Toggle Behavior

- Audit toggle is start-time option only.
- Mid-run/mid-process disabling MUST NOT be allowed for reconstructable mode.
- Recommended controls:
  - CLI: `--audit on|off`
  - ENV: `HERMUX_AUDIT_ENABLED=1|0`

Default during development:

- Audit default is `ON`.

### 10.3 Reconstructability Requirements

Each audit record MUST include sufficient context to reconstruct the accept/drop decision for any event. This includes routing context, decision outcome, and reason when not accepted.

Audit writer MUST be async-buffered; overflow MUST emit summarized drop record.

Non-blocking rule:

- Audit write latency/failure MUST NOT block event routing pipeline.

## 11. Failure Semantics

- Server crash/restart: bump `serverEpoch`, recreate subscription, stale old-epoch events dropped.
- Subscription disconnect: bump `subscriptionEpoch`, reconnect with backoff.
- Duplicate callback delivery: resolved by side-effect dedupe key.
- Session-end cleanup MUST be session-scoped; it MUST NOT be inferred solely from provider `complete`.

Revised session-reuse rule:

- Session reuse after reset MUST preserve strict cross-session isolation by identity extraction and epoch fencing.
- Turn markers SHOULD be reset/rebased for clarity, but turn mismatch alone is not drop criterion.

## 12. Compatibility Notes

- Existing `runId` audit fields may remain for observability but MUST NOT gate routing.
- Existing per-run event loops can be migrated incrementally to repo-global subscriber.
- During migration, dual-path mode MUST audit source (`per-run` vs `global-sub`) for comparison.

## 13. Testable Acceptance Criteria

1. Starting same repo runtime concurrently yields exactly one server + one subscription.
2. Restarting repo runtime bumps epochs and stale pre-epoch events are dropped.
3. Session events are processed while run state is idle.
4. Global-lane events never mutate session state.
5. Duplicate side effects produce one external action and one or more `dedup_skip` audits.
6. Audit timeline can reconstruct event accept/drop order for a repo/session incident.
7. Events are never dropped solely due run lifecycle state (`idle`, `completed`, or no active run).
8. Within same session, out-of-order events are tolerated and audited without cross-session leakage.
9. Session-resolved late events MUST still be accepted and rendered when `HERMUX_SDK_POST_COMPLETE_LINGER_MS=0`.
10. Downstream delivery path MUST receive materialized run-view snapshots and MUST NOT require provider-specific raw event field knowledge.
11. After `run.complete`, `/interrupt` no longer targets that run, while `/revert` remains valid until next-run handoff or explicit session-end cleanup.
12. Starting the next run for the same session atomically terminates the previous run lifecycle without dropping late events accepted before handoff.
13. If no next run starts, the last run stays lifecycle-active until explicit session termination.
