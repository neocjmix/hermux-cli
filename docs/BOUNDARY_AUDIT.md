# Boundary Audit

이 문서는 현재 코드베이스의 컨텍스트 경계 침범 현황을 기록한다.
리빌드 시 이 침범들이 반복되지 않아야 하며, legacy 아카이브의 참조 시 주의해야 할 지점이다.

## Audit Date

2026-03-21

## Architectural Boundaries (Expected)

```
Core (gateway.js, lib/*)
  ├─ MUST NOT import from providers/downstream/*
  ├─ MUST NOT import from providers/upstream/*
  └─ MUST NOT contain provider/channel-specific logic

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
- **Impact**: gateway가 Telegram transport 크기 제한을 직접 처리한다. 다른 downstream channel 추가 시 gateway를 수정해야 한다.
- **Fix**: HTML 청킹은 downstream Telegram adapter 내부에서 처리해야 한다. gateway는 `RunViewSnapshot` 또는 `DeliveryAdapter.sendEvent()`만 호출해야 한다.

#### 2. Core imports Telegram-specific HTML converter

- **File**: `src/gateway.js:16`
- **Code**: `const { md2html, escapeHtml } = require('./lib/md2html');`
- **Module**: `src/lib/md2html.js`
- **Boundary**: Core lib에 Telegram-specific 모듈 존재
- **Impact**: Markdown→Telegram HTML 변환이 core에 있어 채널 독립성이 깨진다.
- **Fix**: `md2html.js`를 `src/providers/downstream/telegram/`으로 이동해야 한다.

#### 3. Core runner is opencode-specific shim

- **File**: `src/lib/runner.js:3`
- **Code**: `const target = '../providers/upstream/opencode/runner';`
- **Boundary**: Core lib에 opencode-specific 모듈 존재
- **Impact**: runner가 opencode에 하드코딩되어 다른 upstream provider를 사용하려면 이 파일을 수정해야 한다.
- **Fix**: `runner.js`를 제거하고 `AgentRuntimeAdapter` 인터페이스 + provider resolution으로 교체해야 한다.

### MODERATE

#### 4. Config uses `telegramBotToken` as field name

- **File**: `src/lib/config.js` (여러 줄)
- **Boundary**: Core 설정 스키마에 Telegram-specific 필드명
- **Impact**: 멀티 채널 지원 시 설정 스키마가 어색해진다.
- **Fix**: 리빌드 시 `channels.telegram.botToken` 등 채널별 설정 구조로 변경 가능. 단, 현재는 단일 채널이므로 우선순위 낮음.

#### 5. Config uses `opencodeCommand` as field name

- **File**: `src/lib/config.js` (repos 스키마)
- **Boundary**: Core 설정 스키마에 opencode-specific 필드명
- **Impact**: 멀티 프로바이더 지원 시 설정 스키마가 어색해진다.
- **Fix**: 리빌드 시 `provider.type` + `provider.command` 등으로 변경 가능.

### CLEAN (No Violations)

- **Downstream → Upstream**: `src/providers/downstream/`에서 upstream 모듈 import 없음. Clean.
- **Upstream → Downstream**: `src/providers/upstream/`에서 Telegram/채널 참조 없음. Clean.
- **Core lib → Downstream**: `src/lib/`에서 downstream 모듈 import 없음 (md2html 자체가 문제이지 import 방향은 아님). Clean.

## Contract Document Issues

### Component Contracts에서 경계 침범 인정

`docs/specs/COMPONENT_CONTRACTS.md` § 6 (Output Transform Contract)에서 이미 `md2html.js`가 "channel-specific and belongs under downstream provider in a rebuild"라고 명시하고 있다. 이는 알려진 침범이며 리빌드 시 수정 대상이다.

### ADAPTER_STRATEGY_DI_SPEC의 증분 리팩토링 허용

`docs/specs/ADAPTER_STRATEGY_DI_SPEC.md` § 1에서 "Compatibility shims MAY exist temporarily"라고 명시하여 `runner.js` 심의 존재를 허용하고 있다. 단, "MUST stay thin and MUST NOT become new homes for provider-specific behavior"라는 조건이 있다.

## Summary

| 위반 | 심각도 | 리빌드 시 조치 |
|------|--------|---------------|
| gateway → html-chunker import | CRITICAL | downstream adapter 내부로 이동 |
| md2html in core lib | CRITICAL | downstream/telegram/으로 이동 |
| runner.js opencode shim in core | CRITICAL | AgentRuntimeAdapter로 교체 |
| telegramBotToken in config schema | MODERATE | 채널별 설정 구조로 변경 |
| opencodeCommand in config schema | MODERATE | provider별 설정 구조로 변경 |

리빌드의 새 `src/` 구현은 이 위반을 포함해서는 안 된다.
