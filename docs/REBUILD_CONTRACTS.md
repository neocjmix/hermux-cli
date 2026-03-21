# Rebuild Contracts

This document consolidates the essential invariants and contracts that MUST survive any rebuild.
Use this as the authoritative checklist when implementing or verifying rebuild work.

## Critical Invariants

### 1. Session-First Event Acceptance

Event delivery acceptance is **session-first**. Run lifecycle state MUST NOT gate acceptance for session-resolved events.

- Router key is `(repoScope, sessionId)`.
- Events MUST be processed regardless of run active/idle/completed state.
- Events MUST NOT be dropped due to turn mismatch or run terminal state.

### 2. Run Complete Semantics

`run.complete` is a **phase marker**, NOT session termination.

- Only next-run handoff or explicit session end revokes session ownership.
- After `run.complete`: `/interrupt` has no effect, `/revert` remains available.
- Late events for the completed run MUST still be accepted until next-run handoff.

### 3. Run View Snapshot Boundary

Upstream emits provider-agnostic `RunViewSnapshot`; downstream MUST consume ONLY snapshot.

```
RunViewSnapshot {
  runId: string
  sessionId: string
  messages: string[]   // ordered logical text blocks
  isFinal: boolean
}
```

- Downstream MUST NOT parse provider raw event fields.
- Transport-size chunking is a downstream concern.
- Upstream MUST NOT split/truncate messages for transport limits.

### 4. Per-Repo Isolation

- One active run per repo context.
- FIFO queue for pending prompts.
- Per-repo dispatch lock serialization.
- `/interrupt` and `/restart` bypass dispatch lock.

### 5. Session Continuity

- Session map: `(repoName, chatId) -> sessionId`.
- Chat remap clears session continuity for both source and target repos.
- `/reset` terminates session lifecycle for the cleared session.

## Interface Contracts

### AgentRuntimeAdapter (upstream)
- `capabilities()` -> feature flags
- `startRun(input, onEvent)` -> streamed execution
- `cancelRun(runId, scope?)`
- Optional: `revert(input)`, `unrevert(input)`

### DeliveryAdapter (downstream)
- `sendEvent(target, canonicalEvent)`
- `sendControl(target, text)`
- MUST NOT mutate canonical event meaning.
- Channel-specific behavior (retries, chunking, fallbacks) lives INSIDE adapter.

### SessionRoutingPolicy
- `shouldDeliver(event, currentBinding)` -> boolean
- `nextBinding(event, currentBinding)` -> binding

### SessionStore
- `get(chatKey)`, `set(chatKey, binding)`, `clear(chatKey)`
- Clear operations MUST be idempotent.

### Canonical Event Envelope
```
{
  id: string           // event identity for idempotency
  source: string       // provider id
  ts: string           // ISO timestamp
  runId: string
  type: string         // canonical type
  payload: object
  sessionId?: string
  role?: "user" | "assistant" | "system" | "tool"
}
```

Canonical types: `run.started`, `run.progress`, `run.completed`, `run.failed`, `message.delta`, `message.final`, `tool.started`, `tool.output`, `tool.completed`, `session.updated`, `raw`.

## Data Contracts

### Configuration
```
{
  global: { telegramBotToken: string },
  repos: [{
    name: string,
    enabled: boolean,
    workdir: string,      // absolute path
    chatIds: string[],
    opencodeCommand: string,
    logFile: string
  }]
}
```
- Atomic write (temp + rename).
- Repo upsert keyed by name.
- `addChatIdToRepo` rejects cross-repo duplicate mapping.

### Session Map
- Key: `(repoName, chatId) -> sessionId`
- `clearSessionId` is idempotent.
- `clearAllSessions` returns count of removed entries.

## Compatibility Branches (MUST remain explicit)

1. **Model-layer bifurcation**: Separate control for OpenCode core model vs oh-my-opencode agent overrides.
2. **Control-command fast path**: `/interrupt` and `/restart` bypass dispatch lock.
3. **Transport compatibility**: SDK-first with command fallback.
4. **Session continuity by `(repo, chat)`**: Deterministic continuation scope.

## Event Normalization Requirements

- Upstream events MUST be normalized into canonical types before orchestration.
- Type categories: `final_text`, `stream_text`, `reasoning`, `tool`, `system_internal`, `raw_unknown`.
- Each carries visibility metadata: `user_visible`, `stream_only`, `diagnostic_only`.
- `raw_unknown` and `system_internal` MUST NOT appear in user-visible final output.

## Deterministic Finalization

Final output resolution precedence:
1. Authoritative meta-final text
2. Validated final_text from event stream
3. Merged stream_text candidate
4. Safe no-output fallback

Final candidate MUST NOT be frozen until terminal signal + buffer flush is complete.

## Error Contract

Provider/channel errors MUST map to:
- `upstream_unavailable`
- `upstream_protocol_error`
- `routing_rejected`
- `delivery_failed`
- `capability_unsupported`

## Verification Checklist

These MUST pass before any rebuild milestone is considered complete:

- [ ] Session events are processed while run state is idle
- [ ] Events are never dropped solely due to run lifecycle state
- [ ] `run.complete` does not revoke session-event acceptance
- [ ] Late events accepted after `run.complete` until next-run handoff
- [ ] Starting next run atomically terminates previous run lifecycle
- [ ] Per-repo FIFO queue ordering is preserved
- [ ] `/interrupt` and `/restart` bypass dispatch lock
- [ ] Cross-repo duplicate chat mapping is rejected
- [ ] Chat remap clears session continuity for both repos
- [ ] RunViewSnapshot is the only render contract between upstream and downstream
- [ ] Downstream never parses provider-specific raw event fields
- [ ] Final output never contains raw/system_internal content
- [ ] Configuration writes are atomic
