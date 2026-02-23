# Component Contracts

This document defines interface-level contracts used to implement and test the system.

## 1) CLI Contract (`src/cli.js`)

Supported commands:

- `start`
- `onboard`
- `init --yes [--full]`
- `help` / `--help` / `-h`

Contract:

- unknown command exits non-zero with help hint
- `start` launches gateway (daemon mode by default, foreground for child/flag path)
- `init --yes` resets repos/sessions and keeps global token
- `init --yes --full` also clears global token

## 2) Configuration Contract (`src/lib/config.js`)

Canonical config shape:

- `global.telegramBotToken: string`
- `repos[]` with:
  - `name: string`
  - `enabled: boolean`
  - `workdir: absolute path string`
  - `chatIds: string[]`
  - `opencodeCommand: string`
  - `logFile: string`

Behavior contract:

- legacy `instances[]` input is normalized at load
- repo upsert is keyed by repo `name`
- `addChatIdToRepo` rejects duplicate mapping across different repos
- persistence write is atomic (temp file + rename)

## 3) Session Map Contract (`src/lib/session-map.js`)

Behavior contract:

- map key: `(repoName, chatId) -> sessionId`
- `clearSessionId` is idempotent
- `clearAllSessions` returns count of removed entries

## 4) Gateway Runtime Contract (`src/gateway.js`)

Runtime contract:

- single Telegram polling bot per process
- chat routes to repo by mapping table
- per-repo lock allows one active run
- queued prompts maintain FIFO order

Command handling contract:

- setup commands work in unmapped chats
- mapped chats support runtime-control and prompt execution commands
- callback handlers use explicit `callback_data` contract keys

## 5) Runner Contract (`src/lib/runner.js`)

Execution contract:

- `runOpencode(instance, prompt, handlers)` is primary execution entrypoint
- SDK transport is the default runtime path
- optional command transport fallback can be forced via `OMG_EXECUTION_TRANSPORT=command`
- runtime status is tracked by repo scope key

Failure contract:

- timeout and backend errors are surfaced through handler callbacks
- restart/shutdown paths trigger runtime executor cleanup behavior

## 6) Output Transform Contract (`src/lib/md2html.js`)

Contract:

- markdown subset converts to Telegram-safe HTML
- escaping is enforced for unsafe HTML characters
- code blocks and inline code preserve readability semantics

## 7) Test Mapping Rule

Every contract above must map to at least one test suite section.

- CLI: `test/cli.test.js`
- Config/session: `test/config.test.js`, `test/session-map.test.js`
- Gateway runtime/UX behavior: `test/gateway-internal.test.js`, `test/gateway-main.test.js`
- Runner runtime lifecycle: `test/runner.test.js`
- Transform: `test/md2html.test.js`
