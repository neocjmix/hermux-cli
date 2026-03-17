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

## Critical Invariant (Top Priority)

- Event delivery acceptance is session-first.
- Run lifecycle state is never a routing acceptance condition for session-resolved events.
- If code conflicts with this invariant, update code and tests to restore session-first behavior.

### Non-Negotiable Interpretation

- `run.complete` is only an in-run phase marker.
- `run.complete` MUST NOT disable, downgrade, reroute, materialize, or otherwise change acceptance/rendering behavior for same-session late events.
- Same-session late events MUST continue through the normal session-owned render path until next-run handoff or explicit session termination.
- `/interrupt` and `/revert` semantics MAY change after `run.complete`; event acceptance and downstream render ownership MUST NOT.

### Mandatory Pre-Change Check

Before changing any event handling, run-view, Telegram delivery, completion, finalization, revert, or interrupt logic, explicitly verify all of the following:

1. Am I using `run.complete`, `completionHandled`, idle/completed state, or "final run" status as a gate for accepting or rendering session events?
2. Am I changing transport mode or downstream behavior for same-session late events because the run reached `complete`?
3. Would the same snapshot still be accepted/rendered if it arrived after `run.complete` but before next-run handoff or explicit session end?

If any answer is "yes" or "no idea", stop and re-read `docs/specs/SESSION_EVENT_ROUTING_SPEC.md` before editing code.

### Mandatory Debugging Protocol

For debugging, incident analysis, or "why did this happen?" requests, do not stop at the first failed gate.

1. Reconstruct the full timeline from logs, inputs, and state transitions before concluding anything.
2. Identify the exact user-visible symptom first.
3. For every claimed failure, show:
   - the actual input/event
   - the exact predicate or branch that evaluated it
   - which subconditions were true/false
   - the concrete mismatch that blocked progress
4. If a condition failed, ask why that condition was false, then repeat the same process one layer deeper.
5. Distinguish clearly between:
   - symptom
   - immediate/proximate cause
   - contributing cause
   - root cause
6. Prefer concrete evidence over abstraction:
   - file/function references for code paths
   - log lines, event ordinals/cursors, message IDs, part IDs, or equivalent runtime identifiers for incidents
7. If behavior depends on heuristics, identify the exact heuristic inputs and the missing or mismatched signal.
8. Do not present architectural theories before proving the local input-vs-condition mismatch that triggered the failure.

If documentation conflicts with code, code is the factual source. Update docs in the same task.

## Required Change Loop

For non-trivial work, use this loop:

1. Update or validate relevant spec/contract docs.
2. Add or update tests for changed contracts.
3. Implement or modify code.
4. Reconcile docs with final behavior.

Detailed rule set: `docs/rules/DOCUMENTATION_RULES.md`.

## Test Safety Invariant

- Tests must never write to default developer profiles under `config/`, `state/`, or `runtime/`.
- Always use the isolated test profile (`.tmp/test-profile`) via `test/helpers/test-profile.js` and `scripts/run-tests-isolated.js`.

## Workspace Hygiene

- Keep the worktree clean by default. End tasks with no unintended modified or untracked files.
- Before starting and before finishing, check `git status --short` and verify that only intentional files are dirty.
- Revert tracked test/runtime artifacts before finishing (for example `.tmp/test-profile/...`) unless the file is part of the intended change.
- Ignore recurring generated artifacts in `.gitignore` instead of leaving them untracked repeatedly.
- Do not commit one-off generated outputs, local scratch files, debug dumps, or runtime logs.
- If a task produces a temporary artifact, delete it before completion unless the user explicitly wants it kept.
