# Architecture

## System Purpose

`hermux` connects Telegram chat input to local `opencode` execution with repo-scoped isolation.

## Runtime Boundaries

- Telegram boundary: one polling bot process.
- Routing boundary: chat ID resolves to one repo context.
- Execution boundary: one active run per repo context.
- Backend boundary: runner executes via serve transport or command transport.

## Module Boundaries

```text
src/
  cli.js
  onboard.js
  gateway.js
  gateway-message-handler.js
  gateway-repo-message-handler.js
  gateway-callback-query-handler.js
  lib/
    config.js
    session-map.js
    runner.js
    md2html.js
```

## Control Flow

1. CLI starts gateway or onboarding.
2. Gateway loads config and builds chat router.
3. Command messages are handled in gateway.
4. Prompt messages dispatch to runner for mapped repo contexts.
5. Runner emits progress and final output; gateway sends Telegram responses.

## Isolation Model

Per repo context state includes:

- run lock and queue
- verbosity mode
- process/session references
- wait/interrupt state

This state is not shared across repo contexts.

## Serve Daemon Lifecycle

- scope key: `repoName::workdir`
- lock path: `runtime/serve-locks/<scope>/lock`
- daemon state path: `runtime/serve-locks/<scope>/daemon.json`

Recovery guarantees:

- lock-based startup serialization
- stale lock recovery using lease + pid checks
- stale daemon record cleanup using pid + health checks
- global stop-all cleanup during restart/shutdown

## Command Surface (Current)

- setup/mapping: `/onboard`, `/onboard cancel`, `/init`, `/init confirm`, `/repos`, `/connect <repo>`, `/whereami`, `/help`
- runtime: `/start`, `/status`, `/models`, `/session`, `/version`, `/verbose`, `/interrupt`, `/restart`, `/reset`
- utility: `/test`

## Data and Persistence

- config: `config/instances.json`
- session map: runtime session map file
- runtime lock/state: `runtime/serve-locks/**`
- run logs: per-repo log path
- telegram e2e stub fixture: `test/fixtures/telegram-mock-server.js`

## Failure Semantics

- unmapped chat interactions return setup/connect guidance
- runner errors/timeouts return explicit error responses
- interrupt and restart are idempotent at command level
- restart/shutdown attempts daemon cleanup first

## Reference Contracts

- user behavior contracts: `docs/specs/UX_SPEC.md`
- interface contracts: `docs/specs/COMPONENT_CONTRACTS.md`
