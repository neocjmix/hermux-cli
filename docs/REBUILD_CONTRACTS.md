# Rebuild Contracts

이 문서는 리빌드 시 반드시 보존해야 하는 불변량과 계약을 통합한다.
리빌드 구현/검증의 **최우선 참조 문서**이며, 모든 독자는 [`docs/INDEX.md`](INDEX.md)에서 여기로 도달한다.

## Why These Contracts Exist

hermux의 이벤트 기반 아키텍처에서 가장 흔한 버그 패턴은:

1. 실행 상태(idle/completed)를 확인하여 **유효한 세션 이벤트를 누락**시킴
2. `run.complete`를 세션 종료로 오해하여 **늦게 도착한 이벤트를 버림**
3. upstream provider(현재 opencode)의 raw 이벤트를 downstream(현재 Telegram)이 직접 파싱하여 **경계가 무너짐**

이 계약들은 이런 패턴이 재발하지 않도록 보호하는 구조적 가드레일이다.

## Critical Invariants

### 1. Session-First Event Acceptance

> **이것이 hermux의 핵심 불변량이며 모든 문서의 정규 정의는 이 섹션이다.**

이벤트 수락은 **session-first**다. 실행 상태(run lifecycle state)는 세션으로 해석된 이벤트의 수락 조건이 될 수 없다.

- 라우터 키는 `(repoScope, sessionId)`다.
- 이벤트는 실행 active/idle/completed 상태와 무관하게 처리되어야 한다.
- 이벤트는 turn 불일치나 실행 종료 상태만으로 버려져서는 안 된다.

**왜 이게 중요한가**: opencode SDK는 `run.complete` 이후에도 세션 수준 이벤트를 전송할 수 있다. 이를 거부하면 사용자에게 불완전한 응답이 전달되거나 세션 상태가 불일치한다.

### 2. Run Complete Semantics

`run.complete`는 **단계 표시자(phase marker)**이며, 세션 종료가 아니다.

- 다음 실행 시작(next-run handoff) 또는 명시적 세션 종료만이 세션 소유권을 해제한다.
- `run.complete` 이후: `/interrupt`는 효과 없음, `/revert`는 사용 가능 상태 유지.
- 완료된 실행의 늦은 이벤트는 next-run handoff까지 수락되어야 한다.

**왜 이게 중요한가**: upstream provider(opencode 등)의 완료 시그널은 "이 단계가 끝났다"를 의미하지 "세션이 끝났다"를 의미하지 않는다. 완료를 세션 종료로 취급하면 마지막 응답 조각이 누락된다.

### 3. Run View Snapshot Boundary

upstream은 provider-agnostic `RunViewSnapshot`을 생성하고, downstream은 **오직 스냅샷만** 소비한다.

```
RunViewSnapshot {
  runId: string
  sessionId: string
  messages: string[]   // ordered logical text blocks
  isFinal: boolean
}
```

- Downstream은 upstream provider의 raw event 필드를 파싱해서는 안 된다.
- Transport 크기 청킹은 downstream 관심사다.
- Upstream은 downstream transport 제한에 맞춰 메시지를 분할/잘라서는 안 된다.

**왜 이게 중요한가**: 이 경계가 없으면 downstream 채널(Telegram, Slack 등)을 추가하거나 upstream provider(opencode, Claude Code 등)를 교체할 때마다 전체 파이프라인을 수정해야 한다. 스냅샷이 유일한 계약 지점이다.

### 4. Per-Repo Isolation

- 레포 컨텍스트당 하나의 활성 실행.
- 대기 프롬프트는 FIFO 큐로 관리.
- 레포별 dispatch lock 직렬화.
- `/interrupt`와 `/restart`는 dispatch lock을 바이패스.

**왜 이게 중요한가**: 동시 실행은 레포 내 파일 충돌을 일으키고, 큐 순서가 보장되지 않으면 사용자 의도와 다른 순서로 작업이 실행된다.

### 5. Session Continuity

- 세션 맵: `(repoName, chatId) -> sessionId`.
- 채팅 리맵은 source와 target 레포 모두의 세션 연속성을 클리어한다.
- `/reset`은 해당 세션의 수명주기를 종료한다.

**왜 이게 중요한가**: 세션 연속성은 대화 컨텍스트(이전 프롬프트/응답 참조)를 유지하는 핵심이다. 잘못된 세션 바인딩은 다른 대화의 컨텍스트가 혼입되는 버그를 만든다.

## Interface Contracts

아래 인터페이스는 현재 구현에서 점진적으로 추출 중인 **목표 아키텍처 인터페이스**다. upstream provider(현재 opencode)와 downstream channel(현재 Telegram)은 각각 이 인터페이스의 구현체이며, 다른 provider/channel 추가 시에도 동일한 인터페이스를 따라야 한다.

### AgentRuntimeAdapter (upstream)
- `capabilities()` -> feature flags
- `startRun(input, onEvent)` -> streamed execution
- `cancelRun(runId, scope?)`
- Optional: `revert(input)`, `unrevert(input)`

### DeliveryAdapter (downstream)
- `sendEvent(target, canonicalEvent)`
- `sendControl(target, text)`
- 정규 이벤트 의미를 변경해서는 안 된다.
- 채널별 동작(재시도, 청킹, 폴백)은 어댑터 내부에서 처리한다.

### SessionRoutingPolicy
- `shouldDeliver(event, currentBinding)` -> boolean
- `nextBinding(event, currentBinding)` -> binding

### SessionStore
- `get(chatKey)`, `set(chatKey, binding)`, `clear(chatKey)`
- clear 연산은 멱등이어야 한다.

### Canonical Event Envelope
```
{
  id: string           // event identity for idempotency
  source: string       // provider id (e.g., "opencode-sdk", "claude-cli")
  ts: string           // ISO timestamp
  runId: string
  type: string         // canonical type
  payload: object
  sessionId?: string
  role?: "user" | "assistant" | "system" | "tool"
}
```

Canonical types: `run.started`, `run.progress`, `run.completed`, `run.failed`, `message.delta`, `message.final`, `tool.started`, `tool.output`, `tool.completed`, `session.updated`, `raw`.

이 이벤트 모델은 **provider-agnostic**이다. 모든 upstream provider는 자체 이벤트를 이 형식으로 정규화해야 한다.

## Data Contracts

### Configuration
```
{
  global: { telegramBotToken: string },
  repos: [{
    name: string,
    enabled: boolean,
    workdir: string,      // absolute path
    chatIds: string[],
    opencodeCommand: string,
    logFile: string
  }]
}
```
- Atomic write (temp + rename).
- Repo upsert keyed by name.
- `addChatIdToRepo` rejects cross-repo duplicate mapping.

Note: `global.telegramBotToken`은 현재 downstream이 Telegram뿐이므로 이 이름이지만, 멀티 채널 지원 시 채널별 설정 구조로 확장될 수 있다.

### Session Map
- Key: `(repoName, chatId) -> sessionId`
- `clearSessionId` is idempotent.
- `clearAllSessions` returns count of removed entries.

## Compatibility Branches (MUST remain explicit)

이 분기들은 단순화를 위해 추상화로 합쳐서는 안 되며, 명시적 분기로 유지해야 한다:

1. **Model-layer bifurcation**: opencode 코어 모델과 oh-my-opencode 에이전트 오버라이드의 별도 제어. **이유**: 두 모델 레이어는 서로 다른 설정 스코프와 업데이트 주기를 가진다.
2. **Control-command fast path**: `/interrupt`와 `/restart`는 dispatch lock을 바이패스한다. **이유**: 장시간 실행 중 즉각적인 제어가 필요하며, 큐 대기는 UX를 파괴한다.
3. **Transport compatibility**: SDK-first with command fallback. **이유**: SDK가 기본이지만, SDK 미설치 환경에서도 CLI 폴백으로 동작해야 한다.
4. **Session continuity by `(repo, chat)`**: 결정론적 연속 스코프. **이유**: 세션 키가 예측 가능해야 디버깅과 감사 추적이 가능하다.

## Event Normalization Requirements

- Upstream 이벤트는 오케스트레이션 전에 canonical type으로 정규화되어야 한다.
- Type 범주: `final_text`, `stream_text`, `reasoning`, `tool`, `system_internal`, `raw_unknown`.
- 각 범주는 가시성 메타데이터를 포함: `user_visible`, `stream_only`, `diagnostic_only`.
- `raw_unknown`과 `system_internal`은 사용자에게 보이는 최종 출력에 포함되면 안 된다.

이 정규화는 **provider-agnostic**이다. 새로운 upstream provider 추가 시에도 동일한 canonical type으로 매핑해야 한다.

## Deterministic Finalization

최종 출력 해석 우선순위:

1. 권위적 meta-final 텍스트
2. 이벤트 스트림의 검증된 final_text
3. 병합된 stream_text 후보
4. 안전한 no-output 폴백

최종 후보는 terminal signal + buffer flush가 완료될 때까지 확정되면 안 된다.

## Error Contract

Provider/channel 에러는 공통 카테고리로 매핑되어야 한다:

- `upstream_unavailable` — upstream provider에 연결할 수 없음
- `upstream_protocol_error` — upstream 응답이 예상 프로토콜에 맞지 않음
- `routing_rejected` — 세션/에포크 검증 실패로 라우팅 거부
- `delivery_failed` — downstream 채널 전송 실패
- `capability_unsupported` — 요청된 기능을 provider가 지원하지 않음

## Verification Checklist

리빌드 마일스톤 완료 전 반드시 통과해야 하는 항목:

- [ ] Session events are processed while run state is idle
- [ ] Events are never dropped solely due to run lifecycle state
- [ ] `run.complete` does not revoke session-event acceptance
- [ ] Late events accepted after `run.complete` until next-run handoff
- [ ] Starting next run atomically terminates previous run lifecycle
- [ ] Per-repo FIFO queue ordering is preserved
- [ ] `/interrupt` and `/restart` bypass dispatch lock
- [ ] Cross-repo duplicate chat mapping is rejected
- [ ] Chat remap clears session continuity for both repos
- [ ] RunViewSnapshot is the only render contract between upstream and downstream
- [ ] Downstream never parses provider-specific raw event fields
- [ ] Final output never contains raw/system_internal content
- [ ] Configuration writes are atomic
