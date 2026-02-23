# Developer Guide

This guide describes development workflow and verification commands.
For behavior contracts, use spec documents.

## Local Setup

```bash
npm install
npm run check
```

## Core Commands

```bash
# onboarding
npm run onboard

# runtime start
npm start

# tests
npm test

# isolated e2e
npm run test:e2e:telegram

# telegram stub for e2e/debug loops
npm run telegram:stub
npm run test:e2e:telegram
```

Direct CLI equivalents:

```bash
node src/cli.js onboard
node src/cli.js start
node src/cli.js init --yes
node src/cli.js init --yes --full
```

## Test and Validation Policy

- Run `npm test` after behavior-changing work.
- Prefer interface-level tests over internal implementation assertions.
- Do not remove failing tests to pass CI.

## Documentation-First Loop

For non-trivial changes, follow:

1. update/check specs,
2. add/update tests,
3. implement,
4. reconcile docs.

Reference rule: `docs/rules/DOCUMENTATION_RULES.md`.

## Configuration Contract (Developer View)

`config/instances.json` canonical structure:

```json
{
  "global": { "telegramBotToken": "123456789:token" },
  "repos": [
    {
      "name": "my-repo",
      "enabled": true,
      "workdir": "/absolute/path",
      "chatIds": ["-1001111111111"],
      "opencodeCommand": "opencode sdk",
      "logFile": "./logs/my-repo.log"
    }
  ]
}
```

Legacy `instances[]` configs are normalized during load.

## Runtime Tuning Environment Variables

- `OMG_MAX_PROCESS_SECONDS`
- `OMG_SDK_SERVER_START_TIMEOUT_MS`
- `OMG_SDK_PORT_RANGE_MIN`
- `OMG_SDK_PORT_RANGE_MAX`
- `OMG_SDK_PORT_PICK_ATTEMPTS`
- `OMG_EXECUTION_TRANSPORT` (`sdk` or `command`)
- `OMG_OPENCODE_SDK_SHIM` (test shim path override)

## Test Profile Isolation

`npm test` and `npm run test:e2e:telegram` run through an isolated profile root (`.tmp/test-profile`) and set:

- `OMG_CONFIG_DIR` / `OMG_CONFIG_PATH`
- `OMG_STATE_DIR` / `OMG_SESSION_MAP_PATH`
- `OMG_RUNTIME_DIR`

This prevents test runs from mutating developer/production files under `config/`, `state/`, and `runtime/`.

## Telegram E2E Stub Loop

Use this loop to validate Telegram contracts without real Telegram network dependency.

1. Start stub server:

```bash
npm run telegram:stub
```

2. Start gateway against stub:

```bash
OMG_TELEGRAM_BASE_API_URL=http://127.0.0.1:8081 OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS=0 npm start
```

3. Inject updates (example):

```bash
curl -X POST http://127.0.0.1:8081/__control/updates -H 'content-type: application/json' -d '{"token":"test-token","update":{"message":{"message_id":1,"date":1700000000,"text":"/start","chat":{"id":100,"type":"private"},"from":{"id":200,"is_bot":false,"first_name":"Tester"}}}}'
```

4. Inspect outbound Telegram API calls captured by stub:

```bash
curl http://127.0.0.1:8081/__control/requests
```

5. Run e2e contract tests:

```bash
npm run test:e2e:telegram
```

Reference: `docs/specs/TELEGRAM_E2E_STUB_SPEC.md`.

## Packaging Notes

- package name: `@hermux/cli`
- binary: `hermux` (also `opencode-mobile-gateway` alias)
- publish configuration: public npm package
