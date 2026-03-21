# Product Guide

## What is hermux?

hermux는 **메시징 채널에서 로컬 AI 코딩 에이전트를 원격 조작하는 게이트웨이**다.

개발자의 로컬 머신에서 실행되는 AI 코딩 에이전트를 채팅으로 제어할 수 있게 해준다. 모바일이나 다른 디바이스에서 로컬 개발 환경의 코드 에이전트에 프롬프트를 보내고, 실행 결과를 실시간으로 받아볼 수 있다.

**현재 구현**: upstream provider로 [opencode](https://opencode.ai), downstream channel로 [Telegram](https://core.telegram.org/bots/api)을 지원한다. 아키텍처는 플러그 가능한 어댑터 구조로 설계되어 다른 provider(Claude Code, Codex, Cursor 등)와 channel(Slack, webhook, stdout 등)으로 확장할 수 있다.

## Problem Statement

AI 코딩 에이전트(opencode, Claude Code 등)는 터미널에서 실행된다. 이는 다음 제약을 만든다:

1. **물리적 접근 필요**: 에이전트를 실행하려면 해당 머신의 터미널에 직접 접근해야 한다.
2. **모바일 사용 불가**: 이동 중이나 다른 디바이스에서 에이전트를 제어할 수 없다.
3. **멀티 레포 관리 어려움**: 여러 프로젝트를 동시에 모니터링하기 어렵다.

hermux는 메시징 채널을 UI 레이어로 사용하여 이 제약을 해결한다:

- 채팅에서 프롬프트를 보내면 로컬 에이전트가 실행된다
- 실행 결과가 실시간 스트리밍으로 채팅에 표시된다
- 여러 레포를 각각의 채팅에 매핑하여 독립적으로 관리한다

현재 downstream channel은 Telegram이며, 아키텍처는 다른 채널(Slack, webhook 등)로 확장 가능하다.

## Who Uses hermux?

**로컬 머신에서 AI 코딩 에이전트(opencode 등)를 사용하는 개발자** 중:

- 이동 중에도 코드 에이전트를 제어하고 싶은 사람
- 장시간 실행되는 에이전트 작업을 원격으로 모니터링하고 싶은 사람
- 여러 프로젝트의 에이전트를 하나의 인터페이스에서 관리하고 싶은 사람

## Key User Workflow

```
[개발자 모바일/PC]           [개발자 로컬 머신]
      │                           │
      │  채팅 메시지 (Telegram 등)│
      │  "이 함수 리팩토링해줘"    │
      ├──────────────────────────>│
      │                           │  hermux gateway
      │                           │      │
      │                           │      ▼
      │                           │  upstream provider 실행
      │                           │  (opencode 등, 로컬 레포에서)
      │                           │      │
      │  실시간 스트리밍 응답      │      │
      │<──────────────────────────┤◄─────┘
      │  "리팩토링 완료. 변경사항:" │
      │  [코드 diff 표시]          │
```

1. **설정**: `npx hermux onboard`로 downstream channel 토큰(현재 Telegram 봇 토큰)과 레포를 등록한다.
2. **매핑**: 채팅을 특정 레포에 연결한다 (`/connect my-project`).
3. **사용**: 채팅에 프롬프트를 보내면 해당 레포에서 upstream provider(현재 opencode)가 실행된다.
4. **제어**: `/status`, `/interrupt`, `/restart` 등으로 실행을 제어한다.

## Plugin Architecture

hermux는 upstream provider와 downstream channel을 플러그 가능한 어댑터 구조로 분리한다:

- **Upstream provider**: AI 코딩 에이전트 런타임. `AgentRuntimeAdapter` 인터페이스를 구현한다.
- **Downstream channel**: 사용자 인터페이스 채널. `DeliveryAdapter` 인터페이스를 구현한다.
- **RunViewSnapshot**: upstream과 downstream 간 유일한 데이터 계약. provider-agnostic 렌더 상태.

| 방향 | 현재 구현 | 목표 확장 |
|------|----------|----------|
| Upstream | opencode SDK/CLI | Claude Code CLI, Codex CLI, Cursor CLI |
| Downstream | Telegram | Slack, webhook, stdout |

어댑터 상세 계약은 [`docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`](specs/ADAPTER_STRATEGY_DI_SPEC.md)를 참조한다.

## External Dependencies (Current Implementations)

### opencode (upstream provider)

opencode는 **터미널 기반 AI 코딩 에이전트**다. LLM을 사용하여 코드를 읽고, 수정하고, 실행할 수 있는 대화형 개발 도구다.

- 공식 사이트: <https://opencode.ai>
- GitHub: <https://github.com/nicholasgriffintn/opencode>
- 주요 기능: 파일 읽기/쓰기, 코드 실행, 프로젝트 컨텍스트 이해, 세션 기반 대화 연속성

hermux가 사용하는 opencode 인터페이스:

| 인터페이스 | 용도 | 설명 |
|-----------|------|------|
| **SDK transport** (기본) | 프로그래밍 방식 실행 | opencode SDK를 직접 import하여 세션 생성, 프롬프트 실행, 이벤트 스트리밍을 수행한다. 세션 연속성(`sessionId`)을 지원하여 대화 컨텍스트가 유지된다. |
| **Command transport** (폴백) | CLI 기반 실행 | `opencode` CLI를 자식 프로세스로 실행한다. SDK가 사용 불가할 때의 대안이며 `HERMUX_EXECUTION_TRANSPORT=command`로 강제할 수 있다. |

opencode SDK에서 hermux가 소비하는 핵심 이벤트:

- `session.updated` — 세션 상태 변경 (세션 ID 추출에 사용)
- `message.part.delta` — 스트리밍 응답 조각 (실시간 미리보기)
- `message.final` — 최종 응답 텍스트
- `tool.started` / `tool.output` / `tool.completed` — 도구 사용 상태
- `run.started` / `run.completed` / `run.failed` — 실행 수명주기

### Telegram Bot API (downstream channel)

텔레그램은 **클라우드 기반 메시징 플랫폼**이다. hermux의 현재 유일한 downstream channel 구현이며, Telegram Bot API를 사용하여 채팅 인터페이스를 제공한다.

- Bot API 공식 문서: <https://core.telegram.org/bots/api>
- Bot 생성 가이드: <https://core.telegram.org/bots#how-do-i-create-a-bot> (BotFather 사용)

hermux가 사용하는 Telegram Bot API 메서드:

| 메서드 | 용도 |
|--------|------|
| `getUpdates` | 롱 폴링으로 사용자 메시지/콜백 수신 |
| `sendMessage` | 응답 메시지 전송 (HTML/plaintext) |
| `editMessageText` | 스트리밍 중 실시간 미리보기 업데이트 |
| `deleteMessage` | 임시 상태 메시지 정리 |
| `answerCallbackQuery` | 인라인 버튼 콜백 응답 |
| `setMyCommands` | 봇 명령어 목록 등록 |
| `sendPhoto` / `sendDocument` | 미디어 파일 전송 |

텔레그램 API 제약 사항과 hermux의 대응:

- **메시지 길이 제한 (4096자)**: hermux가 자동으로 긴 메시지를 청킹한다
- **HTML 파싱 제한**: Markdown → Telegram-safe HTML 변환 실패 시 plaintext로 폴백한다
- **폴링 충돌 (409)**: 웹훅 활성 상태에서 폴링 시도 시 자동 복구한다

### 사용하는 npm 패키지

| 패키지 | 방향 | 용도 | 링크 |
|--------|------|------|------|
| `node-telegram-bot-api` | downstream (Telegram) | Telegram Bot API 클라이언트 | <https://github.com/yagop/node-telegram-bot-api> |
| `@anthropic-ai/opencode` | upstream (opencode) | opencode SDK (세션/실행 관리) | opencode SDK 문서 참조 |

Note: 새로운 provider/channel 추가 시 해당 SDK 패키지가 여기 추가된다.

## Goals and Non-Goals

### Goals

1. **원격 에이전트 접근**: 텔레그램에서 로컬 AI 코딩 에이전트를 완전히 제어한다.
2. **레포 격리**: 레포별 독립적인 실행 환경과 세션을 유지한다.
3. **세션 연속성**: 대화 컨텍스트가 실행 간에 유지된다.
4. **신뢰할 수 있는 이벤트 전달**: 세션 기반 이벤트 수락으로 메시지 유실을 방지한다.
5. **프로바이더 확장성**: `AgentRuntimeAdapter` 인터페이스로 opencode 외 다른 AI 에이전트(Claude Code, Codex 등)를 플러그인으로 추가할 수 있다.
6. **채널 확장성**: `DeliveryAdapter` 인터페이스로 Telegram 외 다른 메시징 채널(Slack, 웹훅 등)을 플러그인으로 추가할 수 있다.

### Non-Goals

1. **호스팅 서비스가 아님**: hermux는 로컬에서 실행되는 게이트웨이다. 클라우드 서비스로 제공하지 않는다.
2. **에이전트 자체가 아님**: hermux는 코드를 실행하지 않는다. 실행은 opencode가 한다.
3. **레거시 호환성 보장 안 함**: 이전 버전의 별칭 명령어나 임시 출력 포맷은 보장하지 않는다.
4. **다중 사용자가 아님**: 하나의 봇 토큰은 하나의 개발자 환경에 바인딩된다.
5. **웹 UI가 아님**: UI는 텔레그램 채팅이 전부다.

## Architectural Summary

상세한 아키텍처는 `docs/ARCHITECTURE.md`를 참조한다. 핵심 구조만 요약하면:

```
┌─────────────────────────────────────────────────────────┐
│                    hermux gateway                        │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌───────────────────┐  │
│  │ Telegram  │    │ Routing  │    │ Upstream Provider │  │
│  │ Boundary  │───>│ Boundary │───>│ (opencode SDK)    │  │
│  │ (polling) │    │ (chat→   │    │                   │  │
│  │           │<───│  repo)   │<───│ RunViewSnapshot   │  │
│  └──────────┘    └──────────┘    └───────────────────┘  │
│                                                          │
│  Key: 하나의 프로세스, 여러 레포, 레포당 하나의 실행      │
└─────────────────────────────────────────────────────────┘
```

핵심 아키텍처 불변량 (**session-first 원칙**):

> 이벤트 수락/라우팅은 세션 ID 기반이다. 실행 상태(idle, completed 등)는 이벤트 수락의 조건이 될 수 없다. `run.complete`는 세션 종료가 아닌 단계 표시자다. 이 원칙의 정규 명세는 `docs/REBUILD_CONTRACTS.md` 섹션 1에 있다.

## Document Map

이 프로젝트의 문서 체계:

| 문서 | 내용 | 독자 |
|------|------|------|
| `docs/PRODUCT_GUIDE.md` (이 문서) | 제품 개요, 외부 의존성, 목표/비목표 | 모든 사람 |
| `README.md` | 퀵스타트, 명령어 목록, 문서 맵 | 사용자, 에이전트 |
| `docs/ARCHITECTURE.md` | 시스템 경계, 런타임 모델, 데이터 흐름 | 엔지니어, 에이전트 |
| `docs/REBUILD_CONTRACTS.md` | 리빌드 불변량, 인터페이스 계약 | 리빌드 구현자 |
| `docs/specs/UX_SPEC.md` | 사용자 행동 계약, 실패 시맨틱 | 제품, 구현자 |
| `docs/specs/COMPONENT_CONTRACTS.md` | 컴포넌트 인터페이스 계약 | 구현자, 테스터 |
| `docs/specs/SESSION_EVENT_ROUTING_SPEC.md` | 세션 라우팅 정규 명세 | 구현자, 아키텍처 리뷰어 |
| `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md` | 프로바이더/채널 어댑터 목표 아키텍처 | 구현자, 아키텍처 리뷰어 |
| `docs/specs/EVENT_HANDLING_COMPARISON.md` | 레퍼런스 구현 비교 분석 | 아키텍처 리뷰어 |
| `docs/specs/TELEGRAM_E2E_STUB_SPEC.md` | 테스트 스텁 계약 | 구현자, 테스터 |
| `docs/DEVELOPER_GUIDE.md` | 로컬 개발 워크플로우 | 개발자, 에이전트 |
| `docs/rules/DOCUMENTATION_RULES.md` | 문서 거버넌스 | 에이전트, 메인테이너 |
