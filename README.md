# hermux

Gateway for running local AI coding agent sessions from chat, with repo-scoped isolation and an SDK-backed runtime executor. Currently supports Telegram (downstream) and opencode (upstream).

## What is hermux?

[opencode](https://opencode.ai)는 터미널 기반 AI 코딩 에이전트다. hermux는 텔레그램에서 opencode 세션을 원격 조작할 수 있게 해주는 게이트웨이로, **로컬 개발 머신의 코드 에이전트를 모바일/채팅에서 제어하는 것이 목적이다.**

자세한 제품 개요, 외부 의존성 설명, 목표/비목표는 [`docs/PRODUCT_GUIDE.md`](docs/PRODUCT_GUIDE.md)를 참조한다.

## Start Here

```bash
npx hermux onboard
hermux start
```

## Product Overview

- One global downstream channel token (현재 [Telegram bot](https://core.telegram.org/bots/api) token).
- Multiple repo contexts (`name`, `workdir`, `chatIds`) under one gateway process.
- One active execution per repo context (`running` lock per repo).
- Persistent repo-scoped runtime session continuity via [opencode](https://opencode.ai) SDK session IDs.

Critical invariant (session-first principle):

- Event delivery/routing acceptance is session-identity-first.
- Run lifecycle (`idle`, `completed`, no active run) MUST NOT be an acceptance gate for session-resolved events.
- `run.complete` MUST be treated as a phase marker only; it MUST NOT change same-session late-event rendering or ownership before next-run handoff or explicit session end.
- Canonical statement: [`docs/REBUILD_CONTRACTS.md` § 1](docs/REBUILD_CONTRACTS.md#1-session-first-event-acceptance).

## User Command Surface

- Setup/routing: `/onboard`, `/onboard cancel`, `/repos`, `/connect <repo>`, `/whereami`, `/help`
- Runtime control: `/start`, `/status`, `/session`, `/verbose [status|on|off]`, `/interrupt`, `/restart`, `/reset`, `/version`
- Utility: `/models`, `/test`

## Documentation Map

**단일 시작점**: 모든 문서 탐색은 [`docs/INDEX.md`](docs/INDEX.md)에서 시작한다.

| 문서 | 내용 |
|------|------|
| [`docs/INDEX.md`](docs/INDEX.md) | **문서 허브** — 모든 독자의 단일 시작점, 목적별 탐색 경로 |
| [`docs/PRODUCT_GUIDE.md`](docs/PRODUCT_GUIDE.md) | 제품 개요, 외부 의존성(opencode/Telegram), 목표/비목표 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 시스템 경계, 런타임 모델, 데이터 흐름 |
| [`docs/REBUILD_CONTRACTS.md`](docs/REBUILD_CONTRACTS.md) | 리빌드 불변량, 인터페이스/데이터 계약, 검증 체크리스트 |
| [`docs/specs/UX_SPEC.md`](docs/specs/UX_SPEC.md) | 사용자 행동 계약, 실패 시맨틱 |
| [`docs/specs/COMPONENT_CONTRACTS.md`](docs/specs/COMPONENT_CONTRACTS.md) | 컴포넌트 인터페이스 계약 |
| [`docs/specs/SESSION_EVENT_ROUTING_SPEC.md`](docs/specs/SESSION_EVENT_ROUTING_SPEC.md) | 세션 라우팅 정규 명세 |
| [`docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`](docs/specs/ADAPTER_STRATEGY_DI_SPEC.md) | 프로바이더/채널 어댑터 목표 아키텍처 |
| [`docs/specs/EVENT_HANDLING_COMPARISON.md`](docs/specs/EVENT_HANDLING_COMPARISON.md) | 레퍼런스 구현 비교 분석 |
| [`docs/specs/TELEGRAM_E2E_STUB_SPEC.md`](docs/specs/TELEGRAM_E2E_STUB_SPEC.md) | 테스트 스텁 계약 |
| [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) | 로컬 개발 워크플로우 |
| [`docs/rules/DOCUMENTATION_RULES.md`](docs/rules/DOCUMENTATION_RULES.md) | 문서 거버넌스 |
| [`AGENTS.md`](AGENTS.md) | 에이전트 필수 읽기 순서, 불변량, 디버깅 프로토콜 |
| [`legacy/README.md`](legacy/README.md) | 리빌드 이전 구현 아카이브 (읽기 전용 참조) |
