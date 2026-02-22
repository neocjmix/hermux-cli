# AGENTS

This file defines the always-read documentation entrypoint for agents working in this repository.

## Read Order (Mandatory)

1. `README.md`
2. `docs/INDEX.md`
3. `docs/rules/DOCUMENTATION_RULES.md`
4. Relevant spec/contract docs for the task

## Document Source of Truth

- Product behavior and user experience contracts: `docs/specs/UX_SPEC.md`
- Component and interface contracts: `docs/specs/COMPONENT_CONTRACTS.md`
- System structure and boundaries: `docs/ARCHITECTURE.md`
- Development workflow and commands: `docs/DEVELOPER_GUIDE.md`

If documentation conflicts with code, code is the factual source. Update docs in the same task.

## Required Change Loop

For non-trivial work, use this loop:

1. Update or validate relevant spec/contract docs.
2. Add or update tests for changed contracts.
3. Implement or modify code.
4. Reconcile docs with final behavior.

Detailed rule set: `docs/rules/DOCUMENTATION_RULES.md`.
