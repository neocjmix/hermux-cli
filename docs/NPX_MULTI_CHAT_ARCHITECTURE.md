# NPX + Repo-Scoped Multi-Chat Architecture

## Goal

Enable this gateway to run with `npx` while keeping one globally configured Telegram bot token and separate repo-scoped execution contexts. Each repo instance must allow one or more Telegram chat IDs (typically group chats).

## Product Requirements

1. Run from `npx` without manual source invocation.
2. One bot token is configured once globally.
3. Each repo has an isolated runtime instance:
   - isolated `workdir`
   - isolated run lock (`running`)
   - isolated log file
4. Each repo stores its own allowed chat IDs.
5. Same bot can be invited to multiple Telegram groups, and each group can map to one repo.
6. Onboarding should not require manual JSON editing.

## Current Gaps

- Config is instance-centric and duplicates `telegramBotToken` per instance.
- Runtime starts one Telegram polling client per instance token.
- Only one `allowedChatId` exists per instance.
- Startup assumes local `npm start`; no CLI optimized for `npx` flow.

## Target Configuration Model

Move to a split config model:

```json
{
  "global": {
    "telegramBotToken": "123456789:token"
  },
  "repos": [
    {
      "name": "backend-api",
      "enabled": true,
      "workdir": "/abs/path/backend-api",
      "chatIds": ["-1001111111111", "-1002222222222"],
      "opencodeCommand": "opencode run",
      "logFile": "./logs/backend-api.log"
    }
  ]
}
```

Compatibility policy:

- Existing `instances[]` config is auto-migrated in memory.
- First valid token found in old instances becomes `global.telegramBotToken`.
- Old `allowedChatId` becomes `chatIds: [allowedChatId]`.
- Save path remains `config/instances.json` for MVP compatibility.

## Runtime Design

### 1) Single bot process, repo router

- Start one `TelegramBot` polling client from `global.telegramBotToken`.
- Build `chatId -> repo` map from enabled repos.
- Incoming message flow:
  1. If chat ID has no mapped repo, ignore (or send short onboarding hint on `/start`).
  2. Resolve repo instance by chat ID.
  3. Execute existing prompt/image flow in that repo context.

### 2) Repo context isolation

Each repo keeps local state:

- `running` lock
- `verbose` mode
- log target
- process cwd

No cross-repo shared execution state is allowed.

### 3) Collision validation

- At startup, validate no duplicate chat IDs across enabled repos.
- On duplicate, fail fast with actionable error.

## Onboarding UX

Keep CLI-first onboarding and add a global/repo split.

### Command set

- `hermux onboard` (or `npx hermux onboard`)
  - interactive setup/update
- `hermux start`
  - start polling runtime

### Interactive flow

1. Global bot token (only if not already configured, otherwise confirm replace).
2. Repo name.
3. Repo workdir (absolute existing directory).
4. Allowed chat IDs (comma-separated numeric IDs).
5. `opencode` command (default `opencode run`).

Validation:

- token format: `^\d+:[A-Za-z0-9_-]+$`
- chat IDs: each matches `^-?\d+$`, unique in input
- workdir exists and is directory
- repo name pattern unchanged: `^[a-zA-Z0-9_-]+$`

### Telegram group onboarding guidance

Show this in onboarding completion and `/start` when unmapped:

1. Create Telegram group for target repo.
2. Invite the bot.
3. Send one message in the group.
4. Run onboarding with that group chat ID.

Optional helper command (runtime-safe):

- `/whereami` -> replies with current chat ID and mapped repo name (or unmapped).

## NPX Packaging Design

### package.json

- Add `bin` entry:
  - `"opencode-mobile-gateway": "./src/cli.js"`
- Keep `start` script for local dev compatibility.

### New `src/cli.js`

Subcommands:

- `start` -> launch runtime (`gateway.main()`)
- `onboard` -> launch onboarding (`onboard.main()`)
- default/no args -> `start`

This allows:

- `npx hermux start`
- `npx hermux onboard`

## Implementation Plan

1. Introduce config normalization/migration helpers in `src/lib/config.js`.
2. Refactor runtime to single bot + chat router in `src/gateway.js`.
3. Refactor onboarding to global token + multi-chat repo registration in `src/onboard.js`.
4. Add CLI entrypoint `src/cli.js` and package `bin` mapping.
5. Update docs (`README.md`, `docs/ONBOARDING_SPEC.md`, `docs/ARCHITECTURE.md`, sample config).
6. Verify with `npm run check` and a dry runtime start.

## Non-Goals (this iteration)

- Dynamic runtime admin commands that mutate config from Telegram chat.
- Multi-bot support.
- Secret manager integration for token storage.
- Auto-discovery of group chat IDs via Telegram update history API.
