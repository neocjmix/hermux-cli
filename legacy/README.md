# Legacy Archive

이 디렉토리는 리빌드 이전 구현의 **읽기 전용 참조 아카이브**이다.

## Purpose

- 리빌드 시 기존 구현의 동작을 참조하기 위한 용도로만 존재한다.
- 계약과 행동을 이해하기 위해 코드를 읽을 수 있지만, 새 구현이 이 코드에 종속되어서는 안 된다.

## Rules

1. **읽기 전용**: 이 디렉토리의 파일을 수정하지 않는다.
2. **import 금지**: 새 구현(`src/`)에서 `legacy/` 경로를 import/require하지 않는다.
3. **구조 참조만**: 기존 구현의 패턴, 로직, 엣지 케이스 처리를 참조할 수 있다.
4. **계약은 문서가 권위**: 행동 계약의 권위적 출처는 `docs/` 아래의 spec 문서이지, 이 코드가 아니다.
5. **테스트 참조**: `legacy/test/`의 테스트 케이스는 새 구현의 테스트 작성 시 참조할 수 있다. 단, 테스트 대상 import 경로는 새 구현으로 변경해야 한다.

## Structure

```
legacy/
  src/          # 기존 소스 코드 아카이브
  test/         # 기존 테스트 코드 아카이브
  scripts/      # 기존 스크립트 아카이브
  README.md     # 이 문서
```

## What This Archive Contains

### Core
- `src/cli.js` — CLI 진입점
- `src/gateway.js` — 조합 루트, 오케스트레이션
- `src/onboard.js` — 온보딩 마법사
- `src/provider-selection.js` — provider 선택 로직

### Libraries (core)
- `src/lib/config.js` — 설정 로드/저장
- `src/lib/session-map.js` — 세션 맵 CRUD
- `src/lib/runner.js` — 실행 엔트리포인트 (opencode 호환 심)
- `src/lib/event-router.js` — 이벤트 라우팅
- `src/lib/session-event-handler.js` — 세션 이벤트 처리
- `src/lib/audit-log.js` — 감사 로깅
- `src/lib/md2html.js` — Markdown→HTML 변환 (**주의: Telegram 전용이지만 core에 위치**)
- `src/lib/output-sanitizer.js` — 출력 정제
- `src/lib/hermux-version.js` — 버전 정보

### App Services
- `src/app/chat-routing-service.js` — 채팅 라우팅 서비스
- `src/app/model-command-service.js` — 모델 명령 서비스
- `src/app/model-control-service.js` — 모델 제어 서비스

### Upstream Provider (opencode)
- `src/providers/upstream/opencode/runner.js` — opencode 실행기
- `src/providers/upstream/opencode/run-view-snapshot.js` — 스냅샷 변환
- `src/providers/upstream/opencode/render-state.js` — 이벤트 상태 프로젝션
- `src/providers/upstream/opencode/view-builder.js` — 스냅샷 텍스트 빌드
- `src/providers/upstream/opencode/payload-introspection.js` — 페이로드 검사

### Downstream Channel (Telegram)
- `src/providers/downstream/telegram/gateway-message-handler.js` — 메시지 핸들러
- `src/providers/downstream/telegram/gateway-repo-message-handler.js` — 레포 메시지 핸들러
- `src/providers/downstream/telegram/gateway-callback-query-handler.js` — 콜백 핸들러
- `src/providers/downstream/telegram/view-reconciler.js` — 뷰 조정기
- `src/providers/downstream/telegram/transport.js` — 전송 계층
- `src/providers/downstream/telegram/bot-effects.js` — 봇 부수 효과
- `src/providers/downstream/telegram/html-chunker.js` — HTML 청킹

## Known Boundary Issues in Legacy Code

상세 감사 결과는 [`docs/BOUNDARY_AUDIT.md`](../docs/BOUNDARY_AUDIT.md)를 참조한다.

핵심 경계 침범 (CRITICAL 6건):

1. **`src/gateway.js:56`** — Telegram html-chunker를 core에서 직접 import
2. **`src/lib/md2html.js`** — Telegram HTML 변환(`<tg-spoiler>`, `tg://`)이 core lib에 위치
3. **`src/lib/runner.js`** — opencode 전용 호환 심이 core lib에 위치
4. **`src/gateway.js:61`** — `TG_MAX_LEN=4000`을 upstream snapshot builder에 전달 (transport 제한 누출)
5. **`src/gateway.js:1371,3152-3154`** — raw opencode event type(`message.part.delta`, `session.status`)을 gateway에서 직접 파싱
6. **`src/gateway.js:409-443`** — Telegram formatting showcase가 core에 위치

추가 침범 (MODERATE 4건):

7. **`src/app/model-*-service.js`** — `parse_mode: 'HTML'`, `reply_markup` 등 Telegram 옵션 직접 반환
8. **`src/gateway.js:587-634,2052-2074`** — Telegram keyboard builders가 core에 위치
9. **`src/gateway.js:558-585,2077-2101`** — Telegram HTML builders가 core에 위치
10. **`src/lib/config.js`** — `telegramBotToken`, `opencodeCommand` 등 specific 필드명

리빌드에서 이 침범이 반복되지 않도록, 새 구현은 `docs/specs/ADAPTER_STRATEGY_DI_SPEC.md`의 경계 계약을 따라야 한다.
