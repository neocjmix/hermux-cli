# Architecture

## System Purpose

hermux는 메시징 채널(현재 [텔레그램](https://core.telegram.org/bots/api)) 채팅 입력을 로컬 AI 코딩 에이전트(현재 [opencode](https://opencode.ai)) 실행에 연결하는 게이트웨이다. 레포 단위 격리를 제공하며, 하나의 프로세스에서 여러 레포를 동시에 관리한다.

제품 전체 맥락(외부 의존성, 목표/비목표 등)은 [`docs/PRODUCT_GUIDE.md`](PRODUCT_GUIDE.md)를 참조한다.

## End-to-End Data Flow

```
┌──────────────┐
│  User        │  텔레그램 채팅에서 메시지 전송
│  (Telegram)  │
└──────┬───────┘
       │ getUpdates (long polling)
       ▼
┌──────────────┐
│  Telegram    │  메시지 분류: 슬래시 명령 / 콜백 / 프롬프트
│  Boundary    │  src/gateway.js → gateway-message-handler.js
└──────┬───────┘
       │ chat ID → repo context 라우팅
       ▼
┌──────────────┐
│  Routing     │  세션 맵: (repoName, chatId) → sessionId
│  Boundary    │  src/lib/session-map.js
└──────┬───────┘
       │ 프롬프트 + sessionId
       ▼
┌──────────────┐
│  Execution   │  opencode SDK/CLI로 실행
│  Boundary    │  src/lib/runner.js → opencode SDK
│              │  이벤트 스트림 수신 (message.delta, tool.*, run.*)
└──────┬───────┘
       │ 이벤트 정규화
       ▼
┌──────────────┐
│  Upstream    │  provider 이벤트 → RunViewSnapshot 변환
│  Snapshot    │  src/providers/upstream/opencode/run-view-snapshot.js
│  Boundary    │  render-state.js + view-builder.js
└──────┬───────┘
       │ RunViewSnapshot { runId, sessionId, messages[], isFinal }
       ▼
┌──────────────┐
│  Downstream  │  스냅샷 → Telegram HTML/plaintext 변환
│  Delivery    │  src/providers/downstream/telegram/view-reconciler.js
│  Boundary    │  send / edit / delete / chunk
└──────┬───────┘
       │ sendMessage / editMessageText
       ▼
┌──────────────┐
│  User        │  텔레그램에서 결과 확인
│  (Telegram)  │
└──────────────┘
```

## Runtime Boundaries

| 경계 | 역할 | 현재 구현 위치 |
|------|------|---------------|
| Telegram boundary | 하나의 폴링 봇 프로세스. 메시지 수신/전송 | `src/gateway.js` (봇 초기화), `src/providers/downstream/telegram/*` (핸들러) |
| Routing boundary | chat ID → repo context 해석 | `src/gateway.js` (라우터 구성), `src/lib/config.js` (매핑 테이블) |
| Execution boundary | 레포당 하나의 활성 실행, FIFO 큐 | `src/lib/runner.js`, `src/gateway.js` (실행 락/큐) |
| Backend boundary | SDK transport (기본) 또는 command transport (폴백) | `src/lib/runner.js` |
| Snapshot boundary | provider 이벤트 → `RunViewSnapshot` 변환 | `src/providers/upstream/opencode/*` |
| Delivery boundary | 스냅샷 → 채널별 포맷팅/전송 | `src/providers/downstream/telegram/*` |

## Architecture Status: Current vs Target

### What is stable (current)

현재 안정적으로 작동하는 부분:

- Telegram 폴링, 메시지 라우팅, 명령어 처리
- 레포별 실행 락 + FIFO 큐
- 세션 맵 `(repoName, chatId) → sessionId`
- RunViewSnapshot 기반 렌더링 파이프라인
- 감사 로깅 (`runtime/audit-events.jsonl`)

### What is in transition (refactor target)

[`specs/ADAPTER_STRATEGY_DI_SPEC.md`](specs/ADAPTER_STRATEGY_DI_SPEC.md)에 정의된 목표 아키텍처로의 전환 중:

| 영역 | 현재 상태 | 목표 상태 |
|------|----------|----------|
| `src/gateway.js` | 조합 루트 + 일부 Telegram/opencode 직접 로직 혼재 | 순수 조합 루트. provider/channel 로직은 어댑터 뒤로 이동 |
| `src/lib/runner.js` | SDK+CLI 호환 심 | 제거 후 `AgentRuntimeAdapter` 인터페이스로 교체 |
| Telegram 전송 로직 | 일부가 gateway에 남아 있음 | 전부 `src/providers/downstream/telegram/*`으로 이동 |
| opencode 이벤트 파싱 | 일부가 gateway에 남아 있음 | 전부 `src/providers/upstream/opencode/*`으로 이동 |
| 멀티 프로바이더 | opencode만 지원 | `AgentRuntimeAdapter` 인터페이스로 Claude Code, Codex 등 추가 가능 |
| 멀티 채널 | Telegram만 지원 | `DeliveryAdapter` 인터페이스로 Slack, 웹훅 등 추가 가능 |

### What MUST NOT change in any refactor

[`REBUILD_CONTRACTS.md`](REBUILD_CONTRACTS.md)에 정의된 불변량. 핵심:

1. Session-first 이벤트 수락 (실행 상태로 이벤트를 거부하지 않음)
2. `run.complete`는 단계 표시자 (세션 종료가 아님)
3. `RunViewSnapshot`가 upstream↔downstream 유일한 렌더 계약
4. 레포당 하나의 활성 실행 + FIFO 큐
5. 세션 연속성 `(repoName, chatId) → sessionId`

## Module Boundaries

```text
src/
  cli.js                          # CLI 진입점 (start, onboard, init, help)
  onboard.js                      # 온보딩 마법사
  gateway.js                      # 조합 루트, 런타임 오케스트레이션
  gateway-message-handler.js      # (레거시 위치, 아래로 이동 중)
  gateway-repo-message-handler.js # (레거시 위치, 아래로 이동 중)
  gateway-callback-query-handler.js # (레거시 위치, 아래로 이동 중)
  lib/
    config.js                     # 설정 로드/저장, 레포 매핑
    session-map.js                # 세션 연속성 맵
    runner.js                     # 실행 엔트리포인트 (호환 심, 제거 예정)
    md2html.js                    # Markdown → Telegram HTML 변환 (downstream으로 이동 예정)
    audit-log.js                  # 구조화된 감사 로깅
  providers/
    upstream/
      opencode/
        run-view-snapshot.js      # 이벤트 → RunViewSnapshot 변환
        render-state.js           # 이벤트 상태 프로젝션
        view-builder.js           # 스냅샷 텍스트 빌드
    downstream/
      telegram/
        gateway-message-handler.js      # 메시지 분류 및 라우팅
        gateway-repo-message-handler.js # 레포 바인딩 명령어/프롬프트 처리
        gateway-callback-query-handler.js # 콜백 쿼리 처리
        view-reconciler.js              # 스냅샷 → Telegram 전송/편집/삭제
```

## Control Flow

### Current control flow

1. CLI가 gateway 또는 onboarding을 시작한다.
2. Gateway가 설정을 로드하고 chat 라우터를 구성한다.
3. Telegram 폴링으로 메시지를 수신한다.
4. 메시지 핸들러가 슬래시 명령/콜백/프롬프트를 분류한다.
5. 프롬프트는 매핑된 레포의 runner로 전달된다.
6. Runner가 opencode SDK로 실행하고 이벤트를 스트리밍한다.
7. 이벤트가 RunViewSnapshot으로 정규화된다.
8. 스냅샷이 Telegram view-reconciler를 통해 전송/편집된다.

### Target control flow (refactor)

1. Telegram 어댑터가 인바운드 업데이트를 디코딩하여 app/orchestration 서비스로 라우팅한다.
2. Gateway가 의존성을 조합하고 run/session 수명주기를 조정한다.
3. Upstream provider 모듈이 provider-specific 이벤트 파싱과 `RunViewSnapshot` 구성을 담당한다.
4. Downstream provider 모듈이 transport-specific send/edit/delete/draft/chat-action 동작을 담당한다.
5. App/service 모듈이 설정 변경, 채팅 매핑, 명령어 비즈니스 정책을 담당한다.

## Event Handling Topology

이벤트 진입은 Telegram 업데이트 수준에서 통합된 후 command/callback/prompt 경로로 분기된다.

- **Telegram transport**: `bot.on('message', handleMessage)` + `bot.on('callback_query', handleCallbackQuery)` — `src/gateway.js`
- **Message classification**: 슬래시 명령 파싱 → 온보딩/설정 명령은 즉시 처리, 나머지는 레포 바인딩 핸들러로 전달 — `src/providers/downstream/telegram/gateway-message-handler.js`
- **Repo-bound dispatch**: 런타임 명령 (`/status`, `/models`, `/interrupt`, `/restart`) + 프롬프트 제출 — `src/providers/downstream/telegram/gateway-repo-message-handler.js`
- **Callback classification**: 구조화된 콜백 데이터 (`connect:*`, `verbose:*`, model 콜백) — `src/providers/downstream/telegram/gateway-callback-query-handler.js`
- **Runtime event adapter**: opencode SDK/CLI → 내부 이벤트 프리미티브 정규화 — `src/lib/runner.js`
- **Completion path**: 실행 완료는 in-run 단계로 기록, 실행 수명주기 종료는 same-session next-run handoff 또는 명시적 session end에서만 발생 — `src/gateway.js`

### Run View Snapshot Boundary

upstream↔downstream 렌더링의 정규 경계는 `RunViewSnapshot`이다.

- **Upstream 책임**: provider 이벤트를 파싱하여 논리적 렌더 블록으로 스냅샷 상태를 물질화한다.
- **Downstream 책임**: 스냅샷 텍스트 블록을 소비하고, 채널 포맷팅을 적용한 뒤, 채널 안전한 diff/send/edit/delete와 필요한 후처리 청킹을 수행한다.

경계 규칙:

- Downstream 모듈은 opencode raw event 필드(`message.part.delta`, `session.status` 등)에 의존해서는 안 된다.
- Gateway는 스냅샷 흐름을 오케스트레이션하며, provider-agnostic 논리적 스냅샷 메시지만 downstream에 전달해야 한다.
- Transport 크기 청킹은 downstream 관심사이며 upstream 스냅샷 구성에 누출되면 안 된다.
- Gateway는 run-view 적용 타이밍을 조정할 수 있지만, transport 재시도/draft-materialize 정책/chat-action 효과는 downstream 어댑터에서 완결되어야 한다.

### Event Concurrency Contract

- 레포별 직렬화: `withStateDispatchLock` — `src/gateway.js`, `src/providers/downstream/telegram/gateway-message-handler.js`
- 제어 명령 바이패스: `/interrupt`, `/restart`는 dispatch lock을 건너뛴다
- 프롬프트 큐: 레포별 FIFO 큐 (`state.queue`) + 하나의 활성 실행 (`state.running`)

## Observability

- 구조화된 감사 로깅: `src/lib/audit-log.js` → `runtime/audit-events.jsonl`
- 커버리지: 인바운드 업데이트, 라우팅 결정, 런타임 이벤트, 완결, 전달 결과

## Isolation Model

레포 컨텍스트별 상태 (레포 간 공유되지 않음):

- 실행 락 + 큐
- verbosity 모드
- 프로세스/세션 참조
- wait/interrupt 상태

## Runtime Executor Lifecycle

복구 보장:

- 스코프별 활성 실행 추적
- restart/shutdown 시 전역 executor 정리
- timeout kill 폴백

## Failure Semantics

- 매핑되지 않은 채팅: setup/connect 안내 반환
- 실행 에러/타임아웃: 명시적 에러 응답 반환
- interrupt/restart: 명령 수준에서 멱등
- restart/shutdown: 런타임 executor 정리 선행

## Reference Contracts

- 사용자 행동 계약: [`specs/UX_SPEC.md`](specs/UX_SPEC.md)
- 인터페이스 계약: [`specs/COMPONENT_CONTRACTS.md`](specs/COMPONENT_CONTRACTS.md)
- 세션/이벤트 라우팅 계약: [`specs/SESSION_EVENT_ROUTING_SPEC.md`](specs/SESSION_EVENT_ROUTING_SPEC.md)
- 어댑터/DI 계약: [`specs/ADAPTER_STRATEGY_DI_SPEC.md`](specs/ADAPTER_STRATEGY_DI_SPEC.md)
- 리빌드 불변량: [`REBUILD_CONTRACTS.md`](REBUILD_CONTRACTS.md)
