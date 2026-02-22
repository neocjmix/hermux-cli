# Serve Daemon Locking and Recovery Design

## Goal

Harden `opencode serve` lifecycle so the runtime can recover from daemon failure, prevent duplicate daemons, and handle lock edge-cases safely under asynchronous race conditions.

## Scope

- File: `src/lib/runner.js`
- Runtime: single host, local filesystem
- Daemon granularity: per repo scope key (`repoName::workdir` or `workdir::...`)

## Problems Addressed

- Concurrent startup attempts for the same repo scope.
- Startup/stop overlap causing orphan or duplicate daemons.
- Process crash leaving stale lock artifacts.
- Daemon unhealthy/dead while stale metadata still exists.
- Restart/shutdown racing with prompt-triggered startup.

## Mechanism

### 1) Repo-scoped filesystem lock

- Lock path: `runtime/serve-locks/<scopeSlug>/lock/`
- Atomic acquisition: `mkdir(lockDir)`
- Owner file: `lock/owner.json`
  - `ownerId` (UUID)
  - `pid`
  - `hostname`
  - `acquiredAt`
  - `leaseUntil`
  - `reason`

### 2) Lease heartbeat and stale lock recovery

- While lock is held, lease is renewed periodically.
- If lock exists:
  - read `owner.json`
  - if lease valid and owner pid alive (`kill(pid, 0)` or `EPERM`): wait with jittered backoff
  - if lease stale and owner pid dead: remove stale lock dir and retry acquire
- Lock wait has bounded timeout (`OMG_SERVE_LOCK_WAIT_TIMEOUT_MS`).

### 3) Daemon state file (cross-process truth)

- Path: `runtime/serve-locks/<scopeSlug>/daemon.json`
- Stores: `key`, `pid`, `port`, `baseUrl`, `startedAt`, `ownerPid`, `ownerHostname`, `status`
- Used to adopt existing healthy daemon across process boundaries.

### 4) Health-driven recovery

- Daemon health check: `GET /doc` + PID liveness.
- On ensure:
  1. lock scope
  2. if daemon record is healthy: adopt and reuse
  3. if unhealthy and pid alive: kill it
  4. clear stale record
  5. spawn new daemon on randomized safe-range port
  6. wait ready and persist daemon record

### 5) In-process single-flight

- `daemonOps` map serializes operations per scope key.
- Prevents overlapping `ensure`/`stop` within the same process.

### 6) Stop-all barrier

- `stopAllInProgress` blocks new ensure/start attempts during global shutdown/restart.
- `stopAllServeDaemons()` collects keys from both in-memory map and persisted daemon records.

## Unlock Safety

- Unlock removes lock only when current owner file `ownerId` matches lock owner in memory.
- Prevents deleting lock acquired by another process after race or stale recovery.

## Orphan and Duplicate Prevention

- Duplicate prevention: atomic lock + per-scope single-flight.
- Orphan prevention: stale lock eviction + daemon health validation + stale daemon kill.
- Restart/shutdown integration uses `stopAllServeDaemons` before process exit.

## Config Knobs

- `OMG_SERVE_PORT_RANGE_MIN`
- `OMG_SERVE_PORT_RANGE_MAX`
- `OMG_SERVE_PORT_PICK_ATTEMPTS`
- `OMG_SERVE_LOCK_WAIT_TIMEOUT_MS`
- `OMG_SERVE_LOCK_STALE_MS`
- `OMG_SERVE_LOCK_LEASE_RENEW_MS`
- `OMG_SERVE_LOCK_RETRY_MIN_MS`
- `OMG_SERVE_LOCK_RETRY_MAX_MS`

## Test Coverage

- Reuse across sequential prompts.
- Dedupe under concurrent starts for same repo scope.
- Recovery from stale lock directory.

## Non-goals

- Distributed locking across multiple hosts.
- Strong transactional guarantees across network filesystems.
