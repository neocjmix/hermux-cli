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
npx hermux onboard
```

Then run:

```bash
hermux start
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
5. Installs a local `hermux` launcher command at `~/.local/bin/hermux`.
6. Starts runtime daemon automatically.
7. Prints exact Telegram verification sequence (`/repos` -> `/connect <repo>` -> `/whereami`).

Validation rules:
- token: `\d+:[A-Za-z0-9_-]+`
- repo name: alphanumeric, `-`, `_`
- chat IDs: numeric, unique (optional)
- workdir: absolute path + existing directory

Re-run `npx hermux onboard` anytime to add/update repos safely.

If `hermux` is not found after onboarding, add `~/.local/bin` to your `PATH`.

## Runtime

Start runtime:

```bash
hermux start
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

## Developer Guide

Developer-focused details (local packaging, scripts, config schema, and agent workflow) are in `docs/DEVELOPER_GUIDE.md`.
