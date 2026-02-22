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
      "opencodeCommand": "opencode serve",
      "logFile": "./logs/my-repo.log"
    }
  ]
}
```

Legacy `instances[]` configs are normalized during load.

## Runtime Tuning Environment Variables

- `OMG_MAX_PROCESS_SECONDS`
- `OMG_SERVE_READY_TIMEOUT_MS`
- `OMG_SERVE_PORT_RANGE_MIN`
- `OMG_SERVE_PORT_RANGE_MAX`
- `OMG_SERVE_PORT_PICK_ATTEMPTS`
- `OMG_SERVE_LOCK_WAIT_TIMEOUT_MS`
- `OMG_SERVE_LOCK_STALE_MS`
- `OMG_SERVE_LOCK_LEASE_RENEW_MS`
- `OMG_SERVE_LOCK_RETRY_MIN_MS`
- `OMG_SERVE_LOCK_RETRY_MAX_MS`

## Packaging Notes

- package name: `@hermux/cli`
- binary: `hermux` (also `opencode-mobile-gateway` alias)
- publish configuration: public npm package
