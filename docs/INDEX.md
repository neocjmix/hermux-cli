# Documentation Index

이 문서는 **모든 독자의 단일 시작점**이다. 목적에 따라 아래 탐색 경로를 따른다.

## Quick Orientation

hermux는 텔레그램에서 로컬 AI 코딩 에이전트([opencode](https://opencode.ai))를 원격 조작하는 게이트웨이다. 제품 전체 맥락은 [`PRODUCT_GUIDE.md`](PRODUCT_GUIDE.md)를 참조한다.

## Critical Invariant (session-first)

모든 문서에 반복 등장하는 핵심 불변량의 **정규 정의**는 [`REBUILD_CONTRACTS.md` § 1](REBUILD_CONTRACTS.md#1-session-first-event-acceptance)에 있다:

> 이벤트 수락은 세션 ID 기반이다. 실행 상태(idle, completed 등)는 이벤트 수락 조건이 될 수 없다. `run.complete`는 세션 종료가 아닌 단계 표시자다.

## Navigation by Purpose

### "hermux가 뭔데?" — 제품 이해

1. [`PRODUCT_GUIDE.md`](PRODUCT_GUIDE.md) — 제품 개요, 외부 의존성(opencode/Telegram API), 목표/비목표, 사용자 워크플로우
2. [`README.md`](../README.md) — 퀵스타트, 명령어 목록

### "어떻게 만들어져 있어?" — 아키텍처 이해

1. [`ARCHITECTURE.md`](ARCHITECTURE.md) — 시스템 경계, 런타임 모델, 이벤트 토폴로지, 데이터 흐름
2. [`specs/ADAPTER_STRATEGY_DI_SPEC.md`](specs/ADAPTER_STRATEGY_DI_SPEC.md) — 목표 아키텍처 (프로바이더/채널 어댑터, DI)
3. [`specs/SESSION_EVENT_ROUTING_SPEC.md`](specs/SESSION_EVENT_ROUTING_SPEC.md) — 세션 중심 이벤트 라우팅 정규 명세
4. [`specs/EVENT_HANDLING_COMPARISON.md`](specs/EVENT_HANDLING_COMPARISON.md) — 레퍼런스 구현 비교 (설계 배경)

### "리빌드해야 하는데?" — 계약 기반 구현

1. [`REBUILD_CONTRACTS.md`](REBUILD_CONTRACTS.md) — **필수 첫 번째 읽기**. 불변량, 인터페이스/데이터 계약, 검증 체크리스트
2. [`BOUNDARY_AUDIT.md`](BOUNDARY_AUDIT.md) — 현재 코드의 경계 침범 현황 (리빌드 시 반복 금지)
3. [`specs/COMPONENT_CONTRACTS.md`](specs/COMPONENT_CONTRACTS.md) — 컴포넌트별 인터페이스 계약
4. [`specs/UX_SPEC.md`](specs/UX_SPEC.md) — 사용자 행동 계약, 실패 시맨틱
5. [`ARCHITECTURE.md`](ARCHITECTURE.md) — 현재/목표 경계 이해
6. [`specs/SESSION_EVENT_ROUTING_SPEC.md`](specs/SESSION_EVENT_ROUTING_SPEC.md) — 라우팅 상세
7. [`specs/ADAPTER_STRATEGY_DI_SPEC.md`](specs/ADAPTER_STRATEGY_DI_SPEC.md) — 어댑터 계약

### "개발/테스트 하려면?" — 개발자 워크플로우

1. [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) — 로컬 설정, 명령어, 테스트, 프로파일 격리
2. [`specs/TELEGRAM_E2E_STUB_SPEC.md`](specs/TELEGRAM_E2E_STUB_SPEC.md) — E2E 테스트 스텁

### "에이전트로 작업하는데?" — AI 에이전트 진입점

1. [`../AGENTS.md`](../AGENTS.md) — 필수 읽기 순서, 불변량, 디버깅 프로토콜, 변경 루프
2. 이 문서 (`INDEX.md`) — 목적별 탐색 경로
3. [`rules/DOCUMENTATION_RULES.md`](rules/DOCUMENTATION_RULES.md) — 문서 거버넌스

## Legacy Archive

`legacy/` 디렉토리에는 리빌드 이전 구현의 읽기 전용 아카이브가 있다. 상세 규칙은 [`../legacy/README.md`](../legacy/README.md)를 참조한다.

- **읽기 전용 참조만** — 새 구현에서 legacy 경로를 import하지 않는다
- **계약 권위는 문서** — 행동 계약은 `docs/specs/*`가 권위이며, legacy 코드가 아니다
- **경계 침범 주의** — legacy 코드의 알려진 경계 문제는 `legacy/README.md`에 기록되어 있다

## All Documents

| 문서 | 독자 | 내용 | 갱신 시점 |
|------|------|------|----------|
| [`PRODUCT_GUIDE.md`](PRODUCT_GUIDE.md) | 모든 사람 | 제품 개요, 외부 의존성, 목표/비목표, 사용자 워크플로우 | 제품 방향, 외부 의존성 변경 시 |
| [`../README.md`](../README.md) | 사용자, 에이전트 | 퀵스타트, 명령어, 문서 맵 | 온보딩/시작 명령, 최상위 행동 변경 시 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 엔지니어, 에이전트 | 시스템 경계, 런타임 토폴로지, 데이터/제어 흐름 | 모듈 경계, 런타임 수명주기, 라우팅 모델 변경 시 |
| [`REBUILD_CONTRACTS.md`](REBUILD_CONTRACTS.md) | 리빌드 구현자 | 필수 불변량, 인터페이스/데이터 계약, 검증 체크리스트 | 계약 수준 결정 변경 시 |
| [`specs/UX_SPEC.md`](specs/UX_SPEC.md) | 제품, 구현자 | 사용자 행동 계약, 실패 시맨틱 | 명령어 UX, 채팅 흐름, 온보딩, 메시지 변경 시 |
| [`specs/COMPONENT_CONTRACTS.md`](specs/COMPONENT_CONTRACTS.md) | 구현자, 테스터 | 컴포넌트 인터페이스 계약 (CLI, 설정, 라우팅, 러너, 변환, 스냅샷) | 함수/공개 모듈 계약 변경 시 |
| [`specs/SESSION_EVENT_ROUTING_SPEC.md`](specs/SESSION_EVENT_ROUTING_SPEC.md) | 구현자, 아키텍처 리뷰어 | 세션 중심 라우팅/수명주기/멱등성/감사 계약 | 레포 런타임 토폴로지, 세션 추출, 에포크 펜싱 변경 시 |
| [`specs/ADAPTER_STRATEGY_DI_SPEC.md`](specs/ADAPTER_STRATEGY_DI_SPEC.md) | 구현자, 아키텍처 리뷰어 | 프로바이더/채널 어댑터 + DI 계약 | 어댑터 인터페이스, 이벤트 모델, 컴포지션 루트 변경 시 |
| [`specs/EVENT_HANDLING_COMPARISON.md`](specs/EVENT_HANDLING_COMPARISON.md) | 아키텍처 리뷰어 | 이벤트 처리 비교 (hermux vs 레퍼런스 구현) | 이벤트 라우팅/콜백 모델, 어댑터 전략 변경 시 |
| [`specs/TELEGRAM_E2E_STUB_SPEC.md`](specs/TELEGRAM_E2E_STUB_SPEC.md) | 구현자, 테스터 | Telegram API 스텁 계약 (E2E/CI/디버그) | 스텁 엔드포인트, 제어 API, E2E 흐름 변경 시 |
| [`BOUNDARY_AUDIT.md`](BOUNDARY_AUDIT.md) | 리빌드 구현자 | 경계 침범 현황, 리빌드 수정 대상 | 경계 위반 발견/수정 시 |
| [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) | 개발자, 에이전트 | 로컬 설정, 명령어, 테스트, 릴리스 워크플로우 | 스크립트, 로컬 워크플로우, 릴리스 변경 시 |
| [`rules/DOCUMENTATION_RULES.md`](rules/DOCUMENTATION_RULES.md) | 에이전트, 메인테이너 | 문서 거버넌스 (진실 원천, 변경 루프, 품질 게이트) | 거버넌스 정책 변경 시 |
| [`../legacy/README.md`](../legacy/README.md) | 리빌드 구현자 | 레거시 코드 아카이브 규칙 | 아카이브 갱신 시 |
