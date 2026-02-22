# Documentation Rules

This document defines documentation governance for this repository.

## Source-of-Truth Policy

- Code is factual source-of-truth for current behavior.
- Specs are source-of-truth for intended behavior.
- If spec and code conflict:
  1. verify intended behavior,
  2. update tests,
  3. update code or spec,
  4. leave both aligned in the same change.

## Required Change Loop

For non-trivial work, follow this order:

1. Spec check/update (`docs/specs/UX_SPEC.md`, `docs/specs/COMPONENT_CONTRACTS.md`)
2. Tests add/update
3. Implementation add/update
4. Spec/docs reconciliation

This loop is mandatory for agent and human contributors.

## Document Boundaries

- `README.md`: quickstart + top-level behavior + links
- `docs/ARCHITECTURE.md`: system boundaries and runtime model
- `docs/specs/UX_SPEC.md`: user-visible behavior and failure semantics
- `docs/specs/COMPONENT_CONTRACTS.md`: interface contracts and invariants
- `docs/DEVELOPER_GUIDE.md`: setup, commands, validation workflow

Do not place temporary status snapshots, one-off migration notes, or implementation diaries in canonical docs.

## Quality Gates

- Contract language must be testable.
- Prefer MUST/SHOULD/MAY wording for normative sections.
- Avoid low-level implementation walkthroughs in spec documents.
- Every changed user-visible behavior must map to a spec update.

## Agent Discoverability Rules

- Agents start at `AGENTS.md` then `docs/INDEX.md`.
- New docs must be linked from `docs/INDEX.md`.
- Rules updates must be reflected in both `AGENTS.md` and this file.
