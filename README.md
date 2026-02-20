# opencode_mobile_gateway

## Important Notice

- This project is built as a fork/derivative of the OpenClaw gateway.
- The codebase is 100% AI-generated, and no part of the source has undergone formal human code review.
- You are solely responsible for assessing and accepting all operational, security, and compliance risks before use.

Telegram gateway that runs local `opencode run` from inbound Telegram messages.

Current behavior:
- one global Telegram bot token
- multiple repo-scoped runtime instances
- each repo can allow multiple chat IDs (typically Telegram groups)
- one bot process routes chats to repo contexts

## Quickstart

```bash
npm install
npm run check
npx hermux start
```

## Local npx Test (without publishing)

```bash
npm pack
npx --yes ./hermux-cli-0.1.0.tgz --help
```

Or run directly from this local package folder:

```bash
npm run npx:local
```

## Onboarding

Single standard onboarding path:

```bash
npx hermux onboard
```

What this single command does:
1. Checks local prerequisites (`git`, `opencode`).
2. Guides Telegram bot prerequisite (BotFather token).
3. Collects and validates repo config values.
4. Saves `config/instances.json` (repo upsert).
5. Starts runtime daemon automatically.
6. Prints exact Telegram verification sequence (`/repos` -> `/connect <repo>` -> `/whereami`).

Validation rules:
- token: `\d+:[A-Za-z0-9_-]+`
- repo name: alphanumeric, `-`, `_`
- chat IDs: numeric, unique (optional)
- workdir: absolute path + existing directory

Re-run `npx hermux onboard` anytime to add/update repos safely.

## Runtime

Start runtime:

```bash
npx hermux start
```

Bot commands:

| command | description |
|--------|-------------|
| `/onboard` | Start in-chat onboarding wizard |
| `/onboard cancel` | Cancel onboarding wizard |
| `/init` | Prepare safe reset (clear repos/mappings/sessions) |
| `/init confirm` | Execute safe reset |
| `/start` | Show mapped repo info and usage |
| `/repos` | List connectable repos |
| `/connect <repo>` | Bind current chat to a repo |
| `/help` | Show onboarding and command help |
| `/status` | Show repo name/workdir/busy/verbose |
| `/version` | Show opencode output plus hermux version |
| `/restart` | Restart daemon process (keep settings/sessions) |
| `/verbose on` | Show intermediate step/tool events |
| `/verbose off` | Final output only |
| `/whereami` | Show current chat ID and mapped repo |

Routing rules:
- Unmapped chat IDs are ignored except onboarding commands (`/onboard`, `/init`, `/start`, `/whereami`, `/repos`, `/connect`, `/help`, `/restart`)
- Repo mapping is by chat ID
- Duplicate chat IDs across enabled repos fail fast at startup
- Execution lock is per repo (`running` state is isolated)

## Resume / Failure Recovery

- Unknown repo on `/connect` -> bot returns a repo list and exact retry hint.
- Temporary save failure on `/connect` -> retry the same command (`/connect <repo>`).
- Already connected to same repo -> safe no-op.
- Already connected to another repo -> bot explains the conflict clearly.

## Agent-First Onboarding (Openclaw / ClaudeCode)

Use this sequence as-is:

```bash
npm install
npm run check
npx hermux onboard
```

Required interaction contract for agents:

1. Start from `npx hermux onboard` as the only onboarding entrypoint.
2. Ask the user for onboarding values explicitly (token, repo name, workdir, command, chat IDs if needed).
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
      "opencodeCommand": "opencode run",
      "logFile": "./logs/my-repo.log"
    }
  ]
}
```

Legacy `instances[]` configs are automatically normalized in memory.
