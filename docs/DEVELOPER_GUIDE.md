# Developer Guide

개발 워크플로우와 검증 명령을 설명한다. 행동 계약은 spec 문서를 참조한다.
프로젝트 전체 이해는 [`docs/INDEX.md`](INDEX.md)에서 시작한다.

## Local Setup

```bash
npm install
npm run check
```

## Core Commands

```bash
# onboarding
npm run onboard

# runtime start
npm start

# tests
npm test

# isolated e2e
npm run test:e2e:telegram

# telegram stub for e2e/debug loops
npm run telegram:stub
npm run test:e2e:telegram
```

Direct CLI equivalents:

```bash
node src/cli.js onboard
node src/cli.js start
node src/cli.js init --yes
node src/cli.js init --yes --full
```

## Test and Validation Policy

- Run `npm test` after behavior-changing work.
- Prefer interface-level tests over internal implementation assertions.
- Do not remove failing tests to pass CI.

### Test File Structure

| 테스트 파일 | 검증 대상 | 관련 계약 문서 |
|------------|----------|---------------|
| `test/cli.test.js` | CLI 명령어 파싱, 진입점 | `COMPONENT_CONTRACTS.md` § 1 |
| `test/config.test.js` | 설정 로드/저장, 레포 매핑 | `COMPONENT_CONTRACTS.md` § 2 |
| `test/session-map.test.js` | 세션 맵 CRUD, 멱등성 | `COMPONENT_CONTRACTS.md` § 3 |
| `test/gateway-internal.test.js` | gateway 내부 로직 | `COMPONENT_CONTRACTS.md` § 4 |
| `test/gateway-main.test.js` | gateway 통합 동작 | `UX_SPEC.md` |
| `test/runner.test.js` | 실행 수명주기, transport | `COMPONENT_CONTRACTS.md` § 5 |
| `test/md2html.test.js` | Markdown → HTML 변환 | `COMPONENT_CONTRACTS.md` § 6 |
| `test/e2e/telegram/*.test.js` | Telegram E2E 계약 | `TELEGRAM_E2E_STUB_SPEC.md` |

### Adding Tests

새로운 기능이나 버그 수정 시:

1. 관련 계약 문서 (`docs/specs/*`)에서 검증해야 할 행동을 확인한다.
2. 위 테이블에서 해당 테스트 파일을 찾는다.
3. 테스트를 추가한다. 이벤트 수락/라우팅 관련이면 **session-first 불변량**을 반드시 검증한다.
4. `npm test`로 전체 테스트를 실행한다.

### Running Specific Tests

```bash
# 특정 파일만 실행 (격리 모드)
node --require ./test/helpers/test-profile.js --test test/config.test.js

# 특정 테스트만 실행
node --require ./test/helpers/test-profile.js --test --test-name-pattern="session map" test/session-map.test.js
```

## Documentation-First Loop

For non-trivial changes, follow:

1. update/check specs,
2. add/update tests,
3. implement,
4. reconcile docs.

Reference rule: [`docs/rules/DOCUMENTATION_RULES.md`](rules/DOCUMENTATION_RULES.md).

## Configuration Contract (Developer View)

`config/instances.json` canonical structure:

```json
{
  "global": { "telegramBotToken": "123456789:token" },
  "repos": [
    {
      "name": "my-repo",
      "enabled": true,
      "workdir": "/absolute/path",
      "chatIds": ["-1001111111111"],
      "opencodeCommand": "opencode sdk",
      "logFile": "./logs/my-repo.log"
    }
  ]
}
```

Legacy `instances[]` configs are normalized during load.

Note: `global.telegramBotToken`은 현재 downstream channel이 Telegram뿐이므로 이 형태이다. 멀티 채널 지원 시 채널별 설정으로 확장될 수 있다.

## Runtime Tuning Environment Variables

Runtime behavior can be tuned via environment variables. See source code for current variables and defaults.

| 변수 | 용도 |
|------|------|
| `HERMUX_EXECUTION_TRANSPORT` | `sdk` (기본) 또는 `command` (CLI 폴백) |
| `HERMUX_TELEGRAM_BASE_API_URL` | Telegram API 엔드포인트 오버라이드 (스텁 테스트용) |
| `HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS` | 폴링 타임아웃 (테스트 시 0으로 설정) |
| `HERMUX_AUDIT_ENABLED` | 감사 로깅 on/off (`1`/`0`) |
| `HERMUX_SDK_POST_COMPLETE_LINGER_MS` | run.complete 후 추가 이벤트 대기 시간 |

## Test Profile Isolation

`npm test` and `npm run test:e2e:telegram` run through an isolated profile root (`.tmp/test-profile`) and set:

- `HERMUX_CONFIG_DIR` / `HERMUX_CONFIG_PATH`
- `HERMUX_STATE_DIR` / `HERMUX_SESSION_MAP_PATH`
- `HERMUX_RUNTIME_DIR`

This prevents test runs from mutating developer/production files under `config/`, `state/`, and `runtime/`.

Mandatory safeguard for tests that import config/session modules:

- Load `test/helpers/test-profile.js` before `../src/lib/config` or `../src/lib/session-map`.
- The helper hard-sets test profile env defaults (`HERMUX_TEST_PROFILE=1`) and redirects config/state/runtime paths into `.tmp/test-profile/p-<pid>`.
- Runtime code also treats `HERMUX_TEST_PROFILE=1` as a fail-safe default root for config/state/runtime, even if explicit path env vars are missing.

If you run tests manually (outside npm scripts), keep isolation enabled:

```bash
node --require ./test/helpers/test-profile.js --test --test-concurrency=1 test/*.test.js
```

## Audit Logging

Structured JSONL audit logs are written to `runtime/audit-events.jsonl` for development/debugging. Each record includes event kind and structured payload for tracing the full path from inbound update through runtime event to delivery outcome.

## Telegram E2E Stub Loop

[Telegram Bot API](https://core.telegram.org/bots/api) 계약을 실제 Telegram 네트워크 없이 검증하는 루프다. 다른 downstream channel이 추가되면 해당 채널의 스텁도 동일한 패턴으로 구성한다.

1. Start stub server:

```bash
npm run telegram:stub
```

2. Start gateway against stub:

```bash
HERMUX_TELEGRAM_BASE_API_URL=http://127.0.0.1:8081 HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS=0 npm start
```

3. Inject updates (example):

```bash
curl -X POST http://127.0.0.1:8081/__control/updates -H 'content-type: application/json' -d '{"token":"test-token","update":{"message":{"message_id":1,"date":1700000000,"text":"/start","chat":{"id":100,"type":"private"},"from":{"id":200,"is_bot":false,"first_name":"Tester"}}}}'
```

4. Inspect outbound API calls captured by stub:

```bash
curl http://127.0.0.1:8081/__control/requests
```

5. Run e2e contract tests:

```bash
npm run test:e2e:telegram
```

Reference: [`docs/specs/TELEGRAM_E2E_STUB_SPEC.md`](specs/TELEGRAM_E2E_STUB_SPEC.md).

## Packaging Notes

- package name: `@hermux/cli`
- binary: `hermux`
- publish configuration: public npm package
