# Developer Guide

This document contains developer-focused operational details that are intentionally excluded from the user-facing README.

## Local npx Test (without publishing)

```bash
npm pack
npx --yes ./hermux-cli-0.1.0.tgz --help
```

Or run directly from this local package folder:

```bash
npm run npx:local
```

## Agent-First Onboarding (Openclaw / ClaudeCode)

Use this sequence as-is:

```bash
npm install
npm run check
npx hermux onboard
```

Required interaction contract for agents:

1. Start from `npx hermux onboard` as the only onboarding entrypoint.
2. Ask the user for onboarding values explicitly (token, repo name, workdir, chat IDs if needed).
3. Let onboard start runtime, then guide Telegram verification.
4. In each target Telegram group:
   - call `/repos`
   - call `/connect <repo>`
   - call `/whereami` to verify mapping
5. On failure, retry `/connect <repo>` once before escalating.

Operational guarantees useful to agents:

- `/connect <repo>` is idempotent for the same chat+repo pair.
- Mapping conflicts are explicit and non-destructive.
- Config writes are atomic (temp file + rename).

## Scripts

| command | description |
|--------|-------------|
| `npm run onboard` | same as CLI onboarding |
| `npm start` | same as CLI start |
| `npm run check` | prerequisite check (`node`, `git`, `opencode`) |

CLI reset options:

```bash
npx hermux init --yes
# safe reset: clear repos/chat mappings/sessions, keep global bot token

npx hermux init --yes --full
# full reset: also clear global bot token
```

## Environment Variable

| name | default | description |
|------|---------|-------------|
| `OMG_MAX_PROCESS_SECONDS` | `3600` | opencode process timeout in seconds |

## Config Shape

```json
{
  "global": {
    "telegramBotToken": "123456789:token"
  },
  "repos": [
    {
      "name": "my-repo",
      "enabled": true,
      "workdir": "/absolute/path/to/repo",
      "chatIds": ["-1001111111111"],
      "opencodeCommand": "opencode serve",
      "logFile": "./logs/my-repo.log"
    }
  ]
}
```

Legacy `instances[]` configs are automatically normalized in memory.
