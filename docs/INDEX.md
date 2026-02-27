# Documentation Index

This is the canonical documentation entrypoint.

## Critical Invariant

- Event delivery acceptance is session-first.
- Run lifecycle state MUST NOT gate acceptance for session-resolved events.

## Read Order

1. `README.md`
2. `docs/INDEX.md`
3. `docs/rules/DOCUMENTATION_RULES.md`
4. `docs/specs/UX_SPEC.md`
5. `docs/specs/COMPONENT_CONTRACTS.md`
6. `docs/specs/TELEGRAM_E2E_STUB_SPEC.md`
7. `docs/specs/EVENT_HANDLING_COMPARISON.md`
8. `docs/specs/SESSION_EVENT_ROUTING_SPEC.md`
9. `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`
10. `docs/ARCHITECTURE.md`
11. `docs/DEVELOPER_GUIDE.md`

## Documents

- `README.md`
  - Audience: users and agents
  - Purpose: quickstart, command surface, doc map
  - Update when: onboarding/start commands or top-level behavior changes

- `docs/ARCHITECTURE.md`
  - Audience: engineers and agents
  - Purpose: system boundaries, runtime topology, data/control flow
  - Update when: module boundaries, runtime lifecycle, routing model changes

- `docs/specs/UX_SPEC.md`
  - Audience: product + implementation
  - Purpose: user-visible behavior contract and failure semantics
  - Update when: command UX, chat flow, onboarding flow, user-facing messages change

- `docs/specs/COMPONENT_CONTRACTS.md`
  - Audience: implementers and testers
  - Purpose: interface-level contracts (CLI, config, routing, runner, transforms, run-view snapshot boundary)
  - Update when: function-level/public module contract changes

- `docs/specs/TELEGRAM_E2E_STUB_SPEC.md`
  - Audience: implementers and testers
  - Purpose: Telegram API stub contract for e2e/CI/debug loops
  - Update when: stub endpoints, control API, or e2e Telegram contract flows change

- `docs/specs/EVENT_HANDLING_COMPARISON.md`
  - Audience: implementers and architecture reviewers
  - Purpose: event-handling comparison between Hermux and reference Telegram OpenCode bots
  - Update when: event routing model, callback dispatch model, or OpenCode event adapter strategy changes

- `docs/specs/SESSION_EVENT_ROUTING_SPEC.md`
  - Audience: implementers and architecture reviewers
  - Purpose: normative session-centric routing/lifecycle/idempotency/audit contract for repo-global OpenCode subscriptions
  - Update when: repo runtime topology, session extraction rules, epoch fencing, or audit reconstructability guarantees change

- `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`
  - Audience: implementers and architecture reviewers
  - Purpose: provider-agnostic upstream/downstream strategy + dependency injection contract
  - Update when: adapter interfaces, canonical event model, composition root wiring, or capability matrix rules change

- `docs/DEVELOPER_GUIDE.md`
  - Audience: developers and agents
  - Purpose: setup, commands, test workflow, release workflow
  - Update when: scripts, local workflow, release flow changes

- `docs/rules/DOCUMENTATION_RULES.md`
  - Audience: agents and maintainers
  - Purpose: source-of-truth rules, required change loop, doc quality gates
  - Update when: governance policy changes
