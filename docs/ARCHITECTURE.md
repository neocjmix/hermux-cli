# Architecture

## System Purpose

`hermux` connects Telegram chat input to local `opencode` execution with repo-scoped isolation.

## Runtime Boundaries

- Telegram boundary: one polling bot process.
- Routing boundary: chat ID resolves to one repo context.
- Execution boundary: one active run per repo context.
- Backend boundary: runner executes via SDK transport or command transport.

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

## Runtime Executor Lifecycle

- scope key: `repoName::workdir`
- runtime status key: in-memory state keyed by scope in `src/lib/runner.js`

Recovery guarantees:

- per-scope active run tracking
- explicit global executor stop during restart/shutdown
- command-transport timeout kill fallback

## Command Surface (Current)

- setup/mapping: `/onboard`, `/onboard cancel`, `/init`, `/init confirm`, `/repos`, `/connect <repo>`, `/whereami`, `/help`
- runtime: `/start`, `/status`, `/models`, `/session`, `/version`, `/verbose`, `/interrupt`, `/restart`, `/reset`
- utility: `/test`

## Data and Persistence

- config: `config/instances.json`
- session map: runtime session map file
- runtime status/state: in-memory map in `src/lib/runner.js`
- run logs: per-repo log path
- telegram e2e stub fixture: `test/fixtures/telegram-mock-server.js`

## Failure Semantics

- unmapped chat interactions return setup/connect guidance
- runner errors/timeouts return explicit error responses
- interrupt and restart are idempotent at command level
- restart/shutdown attempts runtime executor cleanup first

## Reference Contracts

- user behavior contracts: `docs/specs/UX_SPEC.md`
- interface contracts: `docs/specs/COMPONENT_CONTRACTS.md`
