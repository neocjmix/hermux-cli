# Documentation Index

This is the canonical documentation entrypoint.

## Read Order

1. `README.md`
2. `docs/INDEX.md`
3. `docs/rules/DOCUMENTATION_RULES.md`
4. `docs/specs/UX_SPEC.md`
5. `docs/specs/COMPONENT_CONTRACTS.md`
6. `docs/ARCHITECTURE.md`
7. `docs/DEVELOPER_GUIDE.md`

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
  - Purpose: interface-level contracts (CLI, config, routing, runner, transforms)
  - Update when: function-level/public module contract changes

- `docs/DEVELOPER_GUIDE.md`
  - Audience: developers and agents
  - Purpose: setup, commands, test workflow, release workflow
  - Update when: scripts, local workflow, release flow changes

- `docs/rules/DOCUMENTATION_RULES.md`
  - Audience: agents and maintainers
  - Purpose: source-of-truth rules, required change loop, doc quality gates
  - Update when: governance policy changes
