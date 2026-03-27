# Upstream Provider Resume

This note is a restart point for the next slice of work: preparing Hermux to support another upstream provider cleanly.

## Current Checkpoint

- Checkpoint commit: `507c910` (`Checkpoint provider boundary refactor`)
- At that checkpoint, `npm test` passes: `323 pass / 0 fail`
- Adapter wrappers now exist for:
  - upstream: `src/providers/upstream/opencode/adapter.js`
  - downstream: `src/providers/downstream/telegram/adapter.js`

## What Was Just Finished

- Provider resolution now returns explicit adapters instead of raw provider module bags.
- `src/gateway.js` consumes:
  - `upstreamAdapter.runtime`
  - `upstreamAdapter.render`
  - `downstreamAdapter.transport`
- OpenCode payload preview / priority / assistant lifecycle parsing moved behind upstream-owned helpers.
- Telegram prompt edit behavior moved behind downstream transport helper (`editText`).
- Revert-target registration bug for complete-phase same-run `/revert` was fixed and verified by e2e.

## Remaining Gateway Boundary Leaks

These are the main remaining leaks after the checkpoint.

1. Telegram runtime bootstrap still lives in `src/gateway.js`
   - `TelegramBot` construction, polling config, and Telegram startup wiring are still composed directly there.
   - Relevant areas: `src/gateway.js:58`, `src/gateway.js:217`, `src/gateway.js:4208`

2. Telegram ingress handler wiring is still gateway-owned
   - `createMessageHandler`, `createRepoMessageHandler`, and `createCallbackQueryHandler` are still explicitly wired in `src/gateway.js`.
   - This keeps Telegram update topology visible to the composition root.

3. Telegram-specific UX/formatting still leaks into generic layers
   - Formatting showcase/help text and Telegram formatting assumptions still live in `src/gateway.js`.
   - `src/lib/md2html.js` is still effectively Telegram-specific despite living in `lib/`.

4. Revert target persistence is keyed by Telegram delivery identity
   - Store still uses `telegramMessageId`-shaped identity instead of a downstream-neutral persisted delivery reference.
   - Relevant areas: `src/gateway.js:107`, `src/gateway.js:142`, `src/gateway.js:699`

5. Gateway still knows an OpenCode-shaped runtime API
   - It destructures `runOpencode`, `subscribeSessionEvents`, `runSessionRevert`, `runQuestionReply`, `runPermissionReply`, etc.
   - This is adapterized, but not yet canonicalized.

## Concrete Blockers For A Second Upstream Provider

1. Static provider selection
   - `src/provider-selection.js` hardcodes:
     - `upstream: 'opencode'`
     - `downstream: 'telegram'`
   - This must become configurable/resolvable instead of fixed constants.

2. Generic runner shim still points only to OpenCode
   - `src/lib/runner.js` is still a thin alias to `../providers/upstream/opencode/runner`.
   - That is acceptable as a temporary shim, but it cannot remain the implied generic runtime entrypoint once another upstream exists.

3. Runtime contract is still OpenCode-shaped, not canonical
   - Current adapter surface exposes names like:
     - `runOpencode`
     - `subscribeSessionEvents`
     - `runSessionRevert`
     - `runQuestionReply`
     - `runPermissionReply`
   - The long-term target in `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md` is closer to canonical runtime operations and capability-gated optional operations.

4. Config/model/onboarding flows are still OpenCode-centric
   - Config paths, onboarding checks, and `/models` UX still assume OpenCode/OMO semantics.
   - Relevant files:
     - `src/gateway.js`
     - `src/onboard.js`
     - `src/app/model-command-service.js`
     - `src/app/model-control-service.js`

5. Tests still assume a single upstream
   - `test/providers-index.test.js` and surrounding tests are still centered on `opencode` as the only upstream.
   - New provider work should add provider-agnostic registry/contract tests before adding provider-specific behavior.

## Recommended Next Order

Do these in order.

1. Canonicalize the upstream runtime contract
   - Introduce generic operation names on the adapter boundary.
   - Keep OpenCode-specific compatibility shims temporarily if needed.

2. Replace static provider selection with config-driven resolution
   - Move `src/provider-selection.js` toward real selection input.

3. Pull Telegram bootstrap/ingress wiring farther behind downstream seams
   - Goal: keep `src/gateway.js` as composition root, but stop making it the owner of Telegram runtime topology.

4. Decide how question/permission/revert capabilities are represented
   - These should branch by `capabilities()` instead of implicitly assuming OpenCode support.

5. Add a second upstream adapter only after steps 1-4 are stable
   - Otherwise the second provider will be forced to mimic OpenCode-specific assumptions.

## Suggested Restart Checklist

- Read in this order:
  1. `README.md`
  2. `docs/INDEX.md`
  3. `docs/rules/DOCUMENTATION_RULES.md`
  4. `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`
  5. `docs/specs/SESSION_EVENT_ROUTING_SPEC.md`
  6. `docs/ARCHITECTURE.md`
  7. `docs/UPSTREAM_PROVIDER_RESUME.md`
- Verify baseline:
  - `git show --stat 507c910`
  - `npm test`
- Then start with:
  - provider selection / runtime contract analysis
  - not direct provider implementation first

## Useful Files To Reopen First

- `src/gateway.js`
- `src/providers/index.js`
- `src/provider-selection.js`
- `src/providers/upstream/opencode/adapter.js`
- `src/providers/downstream/telegram/adapter.js`
- `src/lib/runner.js`
- `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`
