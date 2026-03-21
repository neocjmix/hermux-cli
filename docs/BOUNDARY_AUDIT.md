# Boundary Audit

이 문서는 현재 코드베이스의 컨텍스트 경계 침범 현황을 기록한다.
리빌드 시 이 침범들이 반복되지 않아야 하며, legacy 아카이브의 참조 시 주의해야 할 지점이다.

## Audit Date

2026-03-21

## Architectural Boundaries (Expected)

```
Core (gateway.js, lib/*, app/*)
  ├─ MUST NOT import from providers/downstream/*
  ├─ MUST NOT import from providers/upstream/*
  ├─ MUST NOT contain provider/channel-specific logic
  └─ MUST NOT pass channel-specific constants to upstream

Upstream (providers/upstream/*)
  ├─ MUST NOT reference downstream channel specifics
  └─ MUST NOT reference Telegram, Slack, etc.

Downstream (providers/downstream/*)
  ├─ MUST NOT reference upstream provider raw events
  └─ MUST NOT import from providers/upstream/*
```

## Violations Found

### CRITICAL

#### 1. Core imports Telegram-specific HTML chunker

- **File**: `src/gateway.js:56`
- **Code**: `const { splitTelegramHtml } = require('./providers/downstream/telegram/html-chunker');`
- **Boundary**: Core → Downstream (Telegram)
- **Impact**: gateway가 Telegram transport 크기 제한을 직접 처리. 다른 downstream 추가 시 gateway 수정 필요.
- **Fix**: 청킹은 downstream Telegram adapter 내부에서 처리. gateway는 `DeliveryAdapter.sendEvent()`만 호출.

#### 2. Core imports Telegram-specific HTML converter

- **File**: `src/gateway.js:16`
- **Code**: `const { md2html, escapeHtml } = require('./lib/md2html');`
- **Module**: `src/lib/md2html.js` — Telegram `<tg-spoiler>` 태그(line 100), `tg://user` 프로토콜(line 25) 포함
- **Boundary**: Core lib에 Telegram-specific 모듈 존재
- **Impact**: Markdown→Telegram HTML 변환이 core에 있어 채널 독립성이 깨짐.
- **Fix**: `md2html.js`를 `src/providers/downstream/telegram/`으로 이동.

#### 3. Core runner is opencode-specific shim

- **File**: `src/lib/runner.js:3`
- **Code**: `const target = '../providers/upstream/opencode/runner';`
- **Boundary**: Core lib에 opencode-specific 모듈 존재
- **Impact**: runner가 opencode에 하드코딩. 다른 upstream provider 사용 시 이 파일 수정 필요.
- **Fix**: `runner.js` 제거 후 `AgentRuntimeAdapter` 인터페이스 + provider resolution으로 교체.

#### 4. Gateway passes Telegram message limit to upstream

- **File**: `src/gateway.js:61, 199, 2805, 3002, 3222`
- **Code**: `const TG_MAX_LEN = 4000;` — upstream snapshot builder에 `maxLen: TG_MAX_LEN`으로 전달
- **Boundary**: Core → Upstream (downstream transport 제한이 upstream에 누출)
- **Impact**: Telegram 메시지 크기 제한이 upstream snapshot 구성에 영향을 미침. 이는 `ADAPTER_STRATEGY_DI_SPEC.md` § 3.2.1의 "Upstream snapshot builders MUST NOT split or truncate messages for Telegram or any other downstream transport limit" 위반.
- **Fix**: upstream은 transport 제한을 모르고 스냅샷을 생성. downstream adapter가 자체적으로 청킹.

#### 5. Gateway processes raw opencode event types

- **File**: `src/gateway.js:1371, 3152-3154`
- **Code**:
  - `if (type === 'message.part.delta')` (payload throttle ranking)
  - `if (type === 'message.part.delta' || type === 'message.part.updated')` (audit formatting)
  - `if (type === 'session.status' || type === 'session.idle' || type === 'session.diff')` (audit formatting)
- **Boundary**: Core → Upstream (raw opencode 이벤트 필드 직접 파싱)
- **Impact**: gateway가 opencode event type을 직접 분기하여 다른 provider 추가 시 gateway를 수정해야 함. `COMPONENT_CONTRACTS.md` § 4의 "gateway MUST NOT accumulate new upstream provider raw payload parsing" 위반.
- **Fix**: 이벤트 타입 분류는 upstream `EventNormalizer`에서 canonical type으로 변환 후, gateway는 canonical type만 사용.

#### 6. Gateway contains Telegram formatting showcase

- **File**: `src/gateway.js:409-443`
- **Code**: `buildTelegramFormattingShowcase()`, `sendTelegramFormattingShowcase()` — Telegram HTML + `<tg-spoiler>` 태그
- **Boundary**: Core → Downstream (Telegram-specific test/debug 기능)
- **Impact**: `/test` 명령의 출력이 Telegram HTML에 하드코딩.
- **Fix**: downstream adapter의 채널별 포맷 쇼케이스로 이동.

### MODERATE

#### 7. App services return Telegram-specific options

- **File**: `src/app/model-control-service.js` (line 34, 47, 60, 76, 93, 116, 127, 148, 171)
- **File**: `src/app/model-command-service.js` (line 27, 57, 65, 101, 111, 119, 134)
- **Code**: `parse_mode: 'HTML'`, `reply_markup: { inline_keyboard: [...] }` 반환
- **Boundary**: App → Downstream (Telegram API 옵션)
- **Impact**: app 서비스가 Telegram-specific 응답 옵션을 직접 구성. 다른 downstream 추가 시 서비스 수정 필요.
- **Fix**: app 서비스는 channel-agnostic 데이터(텍스트, 선택지 목록)만 반환. downstream adapter가 채널별 포맷팅/마크업을 적용.

#### 8. Gateway contains Telegram keyboard builders

- **File**: `src/gateway.js:587-634, 2052-2074`
- **Code**: `buildModelsRootKeyboard()`, `buildStatusKeyboard()`, `buildConnectKeyboard()` 등 — Telegram `inline_keyboard` 구성
- **Boundary**: Core → Downstream (Telegram UI)
- **Impact**: 인라인 키보드 구성이 gateway에 혼재.
- **Fix**: downstream Telegram adapter로 이동. gateway는 선택지 데이터만 전달.

#### 9. Gateway contains Telegram HTML builders

- **File**: `src/gateway.js:558-585, 2077-2101`
- **Code**: `buildModelsSummaryHtml()`, `buildRuntimeStatusHtml()` — `<b>`, `<code>` 등 Telegram HTML 포맷
- **Boundary**: Core → Downstream (Telegram formatting)
- **Impact**: 상태/모델 요약의 HTML 구성이 gateway에 혼재.
- **Fix**: downstream adapter에서 채널별 포맷팅 적용.

#### 10. Config uses channel/provider-specific field names

- **File**: `src/lib/config.js` (여러 줄)
- **Code**: `telegramBotToken`, `opencodeCommand`
- **Boundary**: Core 설정 스키마에 Telegram/opencode-specific 필드명
- **Impact**: 멀티 채널/프로바이더 시 설정 스키마가 어색해짐.
- **Fix**: `channels.telegram.botToken`, `provider.type` + `provider.command` 등으로 변경 가능.

### MINOR

#### 11. md2html contains Telegram protocol handling

- **File**: `src/lib/md2html.js:25`
- **Code**: `if (/^tg:\/\/user\?id=\d+$/i.test(href)) return href;` — `tg://user` 프로토콜
- **Boundary**: Core → Downstream (Telegram-specific protocol)
- **Fix**: md2html 이동 시 함께 해결됨 (§ 2 참조).

### TEST-LEVEL VIOLATIONS (Fixed/Annotated)

#### 12. session-event-handler used Telegram-specific parameter name (Fixed)

- **File**: `src/lib/session-event-handler.js`, `test/session-event-handler.test.js`
- **Was**: `sendRawTelegram` 파라미터명이 core lib에서 사용됨
- **Fix Applied**: `deliverPayload`로 리네이밍 완료. 호환성 shim 없음.

#### 13. gateway-internal test validates raw opencode event parsing (Annotated)

- **File**: `test/gateway-internal.test.js:279-291`
- **Issue**: `readBusySignalFromSessionPayload`가 gateway `_internal`에서 raw opencode 이벤트 타입을 직접 파싱하는 것을 검증
- **Status**: 주석으로 경계 침범 표시. 정규 테스트는 `test/opencode-payload-introspection.test.js`에 있음.

#### 14. app service tests assert Telegram-specific response options (Annotated)

- **File**: `test/model-control-service.test.js`, `test/model-command-service.test.js`
- **Issue**: `parse_mode: 'HTML'`, `reply_markup: { inline_keyboard: [...] }` 반환을 검증
- **Status**: 주석으로 경계 침범 표시. 리빌드 시 channel-agnostic 응답 형태로 변경 필요.

### CLEAN (No Violations)

- **Downstream → Upstream**: `src/providers/downstream/`에서 upstream 모듈 import 없음. **Clean.**
- **Upstream → Downstream**: `src/providers/upstream/`에서 Telegram/채널 참조 없음. **Clean.**

## Contract Document Alignment

### 이미 인지된 침범

- `COMPONENT_CONTRACTS.md` § 6: `md2html.js`가 "channel-specific and belongs under downstream provider in a rebuild"라고 명시.
- `ADAPTER_STRATEGY_DI_SPEC.md` § 1: "Compatibility shims MAY exist temporarily... MUST stay thin"으로 `runner.js`의 일시적 존재를 허용.

### 계약과 코드의 불일치

- `ADAPTER_STRATEGY_DI_SPEC.md` § 3.2.1: "Upstream snapshot builders MUST NOT split or truncate messages for Telegram" — 그러나 실제로 `TG_MAX_LEN`이 upstream에 전달되고 있음 (§ 4).
- `COMPONENT_CONTRACTS.md` § 4: "gateway MUST NOT accumulate new Telegram transport-specific behavior" — 그러나 keyboard builders, HTML builders, formatting showcase가 gateway에 있음 (§ 6, 8, 9).

## Summary

| # | 위반 | 심각도 | 리빌드 시 조치 |
|---|------|--------|---------------|
| 1 | gateway → html-chunker import | CRITICAL | downstream adapter 내부로 이동 |
| 2 | md2html in core lib (tg-spoiler, tg:// 포함) | CRITICAL | downstream/telegram/으로 이동 |
| 3 | runner.js opencode shim in core | CRITICAL | AgentRuntimeAdapter로 교체 |
| 4 | TG_MAX_LEN upstream 누출 | CRITICAL | upstream은 transport 제한 모르게 설계 |
| 5 | gateway에서 raw opencode event type 파싱 | CRITICAL | EventNormalizer로 canonical type 사용 |
| 6 | gateway Telegram formatting showcase | CRITICAL | downstream adapter로 이동 |
| 7 | app services Telegram options 반환 | MODERATE | channel-agnostic 데이터만 반환 |
| 8 | gateway Telegram keyboard builders | MODERATE | downstream adapter로 이동 |
| 9 | gateway Telegram HTML builders | MODERATE | downstream adapter로 이동 |
| 10 | config Telegram/opencode field names | MODERATE | 채널/프로바이더별 설정 구조로 변경 |
| 11 | md2html tg:// protocol | MINOR | md2html 이동 시 함께 해결 |
| 12 | session-event-handler `sendRawTelegram` | FIXED | `deliverPayload`로 리네이밍 완료 |
| 13 | gateway-internal test raw event parsing | ANNOTATED | 주석 추가, 정규 테스트는 opencode-payload-introspection |
| 14 | app service tests Telegram options | ANNOTATED | 주석 추가, 리빌드 시 channel-agnostic으로 변경 |

**CRITICAL 6건, MODERATE 4건, MINOR 1건, FIXED 1건, ANNOTATED 2건. 리빌드의 새 `src/` 구현은 이 위반을 포함해서는 안 된다.**
