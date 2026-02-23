# hermux

Telegram gateway for running local `opencode` sessions from chat, with repo-scoped isolation and an SDK-backed runtime executor.

## Start Here

```bash
npx hermux onboard
hermux start
```

## Product Overview

- One global Telegram bot token.
- Multiple repo contexts (`name`, `workdir`, `chatIds`) under one gateway process.
- One active execution per repo context (`running` lock per repo).
- Persistent repo-scoped runtime session continuity via SDK session IDs.

## User Command Surface

- Setup/routing: `/onboard`, `/onboard cancel`, `/repos`, `/connect <repo>`, `/whereami`, `/help`
- Runtime control: `/start`, `/status`, `/session`, `/verbose [status|on|off]`, `/interrupt`, `/restart`, `/reset`, `/version`
- Utility: `/models`, `/test`

## Documentation Map

- Canonical index: `docs/INDEX.md`
- Architecture: `docs/ARCHITECTURE.md`
- User experience spec: `docs/specs/UX_SPEC.md`
- Component contracts: `docs/specs/COMPONENT_CONTRACTS.md`
- Development workflow: `docs/DEVELOPER_GUIDE.md`
- Documentation governance rules: `docs/rules/DOCUMENTATION_RULES.md`
- Agent entrypoint and always-read order: `AGENTS.md`
