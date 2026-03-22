# Hermux-CLI Skeleton Rebuild Prompt

## Context

`src/`의 모든 모듈이 `NOT_IMPLEMENTED` 스켈레톤으로 교체되었다. `module.exports` API surface는 유지되어 있고, 구현만 비어 있다. 테스트(`test/*.test.js`)는 전부 `NOT_IMPLEMENTED`로 실패하는 상태다.

목표: **스켈레톤에 구현을 채워 모든 테스트를 통과시키되, 레거시의 경계 침범을 반복하지 않는다.**

---

## 필수 사전 읽기 (이 순서대로)

1. `docs/INDEX.md` — 문서 전체 구조 파악
2. `docs/REBUILD_CONTRACTS.md` — **리빌드 불변식과 검증 체크리스트** (이것이 최상위 권위)
3. `docs/BOUNDARY_AUDIT.md` — 14건의 경계 침범 목록과 각각의 해소 상태 (Skeleton Status 섹션 포함)
4. `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md` — upstream/downstream 어댑터 아키텍처
5. `docs/specs/SESSION_EVENT_ROUTING_SPEC.md` — 세션 우선 라우팅 정규 spec
6. `docs/specs/COMPONENT_CONTRACTS.md` — 컴포넌트별 인터페이스 계약

---

## 레거시 코드 사용 규칙

`legacy/src/`와 `legacy/test/`에 이전 구현이 읽기 전용으로 보존되어 있다. **반드시 아래 규칙을 따른다:**

### 허용
- 알고리즘의 **로직 흐름**을 이해하기 위해 읽는 것
- 엣지 케이스 처리 패턴을 참고하는 것
- 테스트 케이스의 시나리오와 fixture를 참조하는 것

### 금지
- 레거시 코드를 **그대로 복사**하는 것 (경계 침범이 그대로 딸려온다)
- `legacy/` 경로를 새 구현에서 import/require하는 것
- 레거시의 구현 세부사항을 계약보다 우선시하는 것

### 핵심 주의사항
레거시 코드에는 다음 경계 침범이 내재되어 있다. 구현 참고 시 이것들을 **의식적으로 걸러내야** 한다:

| 침범 | 레거시 위치 | 올바른 위치/처리 |
|------|------------|-----------------|
| Telegram html-chunker core import | `gateway.js:56` | downstream adapter 내부에서만 사용 |
| md2html (tg-spoiler, tg://) | `lib/md2html.js` | `providers/downstream/telegram/md2html.js`로 이동 완료 |
| opencode runner shim | `lib/runner.js` | 삭제 완료. upstream runner는 provider 내부에만 존재 |
| TG_MAX_LEN upstream 전달 | `gateway.js:61` | upstream은 transport limit을 모르게 설계 |
| raw opencode event 파싱 | `gateway.js:1371,3152` | EventNormalizer 통해 canonical type 사용 |
| Telegram showcase in core | `gateway.js:409-443` | downstream adapter로 이동 |
| app service Telegram options | `model-*-service.js` | channel-agnostic 데이터만 반환 `{ text, choices? }` |
| Telegram keyboard/HTML builders | `gateway.js` 곳곳 | downstream adapter 내부 |

---

## 리빌드 순서

의존성 그래프의 잎(leaf)부터 시작하여 조합 루트(gateway)로 올라간다. 각 단계에서 해당 모듈의 테스트가 통과해야 다음 단계로 진행한다.

### Phase 1: 순수 유틸 (외부 의존 없음)
1. `src/lib/config.js` → `test/config.test.js`
2. `src/lib/session-map.js` → `test/session-map.test.js`
3. `src/lib/audit-log.js` → `test/audit-log.test.js`
4. `src/lib/output-sanitizer.js` → `test/output-sanitizer.test.js`
5. `src/lib/hermux-version.js` — 이미 구현 완료

### Phase 2: Upstream provider (opencode 전용)
6. `src/providers/upstream/opencode/payload-introspection.js` → `test/opencode-payload-introspection.test.js`
7. `src/providers/upstream/opencode/render-state.js` → `test/opencode-render-state.test.js`
8. `src/providers/upstream/opencode/view-builder.js` → `test/opencode-view-builder.test.js`
9. `src/providers/upstream/opencode/run-view-snapshot.js` → `test/opencode-run-view-snapshot.test.js`
10. `src/providers/upstream/opencode/runner.js` → `test/runner.test.js`

### Phase 3: Downstream provider (telegram 전용)
11. `src/providers/downstream/telegram/md2html.js` → `test/md2html.test.js`
12. `src/providers/downstream/telegram/html-chunker.js` → `test/telegram-html-chunker.test.js`
13. `src/providers/downstream/telegram/transport.js` → `test/telegram-transport.test.js`
14. `src/providers/downstream/telegram/bot-effects.js` → `test/telegram-bot-effects.test.js`
15. `src/providers/downstream/telegram/view-reconciler.js` → `test/telegram-view-reconciler.test.js`

### Phase 4: Core 라우팅/이벤트 (경계 계약 핵심)
16. `src/lib/event-router.js` → `test/event-router.test.js`
17. `src/lib/session-event-handler.js` → `test/session-event-handler.test.js`

### Phase 5: App services (channel-agnostic 계약)
18. `src/app/chat-routing-service.js` → `test/chat-routing-service.test.js`
19. `src/app/model-command-service.js` → `test/model-command-service.test.js`
20. `src/app/model-control-service.js` → `test/model-control-service.test.js`

### Phase 6: Handler & Gateway 조합
21. `src/providers/downstream/telegram/gateway-message-handler.js` → `test/gateway-message-handler.test.js`
22. `src/providers/downstream/telegram/gateway-repo-message-handler.js` → `test/gateway-repo-message-handler.test.js`
23. `src/providers/downstream/telegram/gateway-callback-query-handler.js` → `test/gateway-callback-query-handler.test.js`
24. `src/gateway.js` → `test/gateway-main.test.js`, `test/gateway-internal.test.js`
25. `src/cli.js` → `test/cli.test.js`
26. `src/onboard.js` → `test/onboard.test.js`

---

## 비협상 불변식 (Non-Negotiable Invariants)

구현 중 아래를 위반하면 **즉시 중단하고 spec을 다시 읽는다:**

1. **Session-first**: `run.complete`나 idle 상태가 이벤트 수락을 거부하는 조건이 되어서는 안 된다
2. **RunViewSnapshot 경계**: upstream → downstream 데이터 전달은 오직 `RunViewSnapshot` 통해서만
3. **Canonical events**: gateway/core에서 raw opencode event type (`message.part.delta` 등)을 직접 파싱하지 않는다
4. **Channel-agnostic app services**: `parse_mode`, `reply_markup` 같은 channel 전용 옵션을 반환하지 않는다
5. **Transport limit 격리**: upstream에 `maxLen`, `TG_MAX_LEN` 같은 downstream 제약을 전달하지 않는다

---

## 테스트 주의사항

- 테스트는 현재 레거시 동작을 검증하도록 작성되어 있다
- **일부 테스트는 경계 침범을 전제로 작성되었다** (`test/model-command-service.test.js`, `test/model-control-service.test.js` 등에 `// BOUNDARY_VIOLATION` 주석 존재)
- 이런 테스트는 구현에 맞추어 **테스트도 함께 수정**해야 한다 (channel-agnostic 반환값 검증으로)
- `test/helpers/test-profile.js`를 반드시 먼저 로드하여 테스트 격리를 보장한다
- `test/fixtures/`의 opencode SDK fixture들은 upstream 이벤트 시나리오의 정규 참조다
- 테스트를 삭제하여 통과시키지 않는다. 계약에 맞게 수정한다.

---

## 작업 방식

1. 한 모듈씩 구현한다
2. 레거시 코드를 **읽어서 로직을 이해**한 뒤, **계약 문서를 기준으로 새로 작성**한다
3. 해당 테스트를 실행하여 통과를 확인한다
4. 경계 침범이 없는지 자가 점검한다
5. 다음 모듈로 진행한다
6. 한 Phase가 끝날 때마다 커밋한다

---

## 완료 기준

- [ ] `npm test` 전체 통과
- [ ] `src/`에 `NOT_IMPLEMENTED`가 하나도 남아 있지 않음
- [ ] `BOUNDARY_AUDIT.md`의 14건 경계 침범이 새 구현에서 재발하지 않음
- [ ] `REBUILD_CONTRACTS.md`의 검증 체크리스트 전항목 충족
