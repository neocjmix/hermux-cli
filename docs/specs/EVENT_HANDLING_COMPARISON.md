# Event Handling Comparison

이 문서는 레퍼런스 구현 리뷰에서 얻은 아키텍처 비교 인사이트를 기록한다.
리빌드의 **설계 배경 컨텍스트**이며, 규범적 명세가 아니다.

비교 대상은 모두 opencode+Telegram 조합이지만, hermux가 도출한 아키텍처 결정(이벤트 정규화, 결정론적 완결, 호환성 분기)은 **provider/channel-agnostic 원칙**에 기반한다.

## Compared Implementations

- `hermux` (this repository)
- `grinev/opencode-telegram-bot`
- `Tommertom/opencode-telegram`

## Dispatch Model Comparison

| Aspect | grinev | tommertom | hermux |
| --- | --- | --- | --- |
| Event dispatch | Centralized aggregator with callback fan-out | Direct event-type map to handlers | Normalized runtime primitives + queue-driven run loop |
| Concurrency | Interaction-state guard; single active interaction | Per-user session map with direct sends | Per-repo execution lock + FIFO queue; control-command bypass |
| Callback handling | Broad ecosystem (session/project/question/permission/model) | Minimal (`esc`/`tab`) | Operational set (`connect`, `verbose`, `interrupt`, model layers) |
| Event-response UX | Rich staged notifications (thinking/tool/question/permission) | Simple direct messages per event | Status panel + stream preview + final response + queue progress |

## Essential Architectural Decisions for Rebuild

### 1. Event normalization boundary

Upstream provider events MUST be normalized into canonical types before reaching orchestration.
Canonical types: `final_text`, `stream_text`, `reasoning`, `tool`, `system_internal`, `raw_unknown`.
Each type carries visibility metadata (`user_visible`, `stream_only`, `diagnostic_only`).

### 2. Deterministic finalization

Final output resolution MUST follow a deterministic precedence:
1. Authoritative meta-final text (if available)
2. Validated final_text from event stream
3. Merged stream_text candidate
4. Safe no-output fallback

Final candidate MUST NOT be frozen until terminal signal + buffer flush is complete.

### 3. Raw/system quarantine

`raw_unknown` and `system_internal` events MUST NOT appear in user-visible final output.
They belong in diagnostics/trace only.

### 4. Mandatory compatibility branches

These divergences MUST remain explicit branches in any rebuild:

1. **Model-layer bifurcation**: Separate control for OpenCode core model vs oh-my-opencode agent model overrides.
2. **Control-command fast path**: `/interrupt` and `/restart` MUST bypass dispatch lock.
3. **Transport compatibility**: SDK-first with command fallback.
4. **Session continuity by `(repo, chat)`**: Deterministic continuation scope for workflows.

## Non-Goals for Rebuild

- Do NOT silently discard unknown provider events; quarantine + observe.
- Do NOT collapse compatibility branches into generic abstractions that hide operational intent.
- Do NOT couple event normalization to UI rendering (keep separate boundaries).
