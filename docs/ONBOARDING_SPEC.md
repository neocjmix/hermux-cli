# Onboarding Spec (Single Standard Path)

Goal: a first-time user can begin with exactly one command and finish onboarding without editing JSON manually.

## Single Entry Point

Only one official onboarding entry command is supported:

```bash
npx hermux onboard
```

No alternate first-run flow is documented as standard.

## Dependency-First Order

Onboarding must follow strict prerequisite order. Each step unlocks the next.

1. **Local prerequisites**
   - Verify `git` and `opencode` are available in PATH.
   - If missing, fail immediately with a clear error.

2. **Telegram bot prerequisite**
   - User prepares a bot token via `@BotFather`.
   - Token format must pass validation: `^\d+:[A-Za-z0-9_-]+$`.

3. **Repo runtime inputs**
   - Repo name (`^[a-zA-Z0-9_-]+$`)
   - Allowed chat IDs (comma-separated, optional; each `^-?\d+$`, deduplicated)
   - Repo workdir (absolute path + existing directory)
   - opencode command (default: `opencode run`)

4. **Config persistence**
   - Save to `config/instances.json`.
   - Upsert by repo name.
   - Global token stored under `global.telegramBotToken`.

5. **Runtime activation**
   - Start daemon automatically from onboarding.
   - If runtime cannot start, fail onboarding and report cause.

6. **Telegram verification**
   - User runs in target chat/group:
     1) `/repos`
     2) `/connect <repo>`
     3) `/whereami`
     4) send a test prompt

## UX Principles

- Keep only one standard onboarding route.
- Fail early on missing hard dependencies.
- Validate each input immediately.
- Print exact next actions, not multiple optional paths.

## Failure Handling

- Validation failure: print error and exit non-zero.
- Runtime start failure: print error and exit non-zero.
- Recoverability: rerun `npx hermux onboard` safely; repo write is upsert.
