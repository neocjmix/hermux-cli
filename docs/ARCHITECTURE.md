# Architecture (MVP)

## 한 줄 요약
Telegram 메시지를 받아 로컬에서 `opencode run --format json`을 실행하고, JSON 이벤트를 파싱하여 Markdown→HTML 변환 후 Telegram으로 전송하는 게이트웨이. 단일 글로벌 봇 + chat ID 기반 repo 라우팅을 사용한다.

## 모듈 구조

```
src/
├── cli.js              # npx/CLI 엔트리 (start/onboard)
├── gateway.js          # 메인 엔트리. 인스턴스별 Telegram polling + 메시지 핸들링
├── onboard.js          # 인터랙티브 온보딩 CLI
└── lib/
    ├── config.js       # config CRUD + legacy normalization
    ├── runner.js       # opencode 프로세스 spawn + JSON 이벤트 파싱 + 로그 기록
    └── md2html.js      # Markdown → Telegram HTML 변환 (code block, bold, italic, heading)
```

## 데이터 흐름

```
사용자 (Telegram)
  │
  ▼
Telegram Bot API (polling)
  │
  ▼
gateway.js — 단일 bot polling + chat id -> repo 라우팅
  │
  ├─ /start, /status, /verbose, /whereami → 즉시 응답
  │
  └─ 일반 프롬프트 →
       │
       ▼
     runner.js — `opencode run --format json <prompt>` spawn
       │  ├── stdout: JSON line 파싱 → 이벤트 콜백
       │  ├── stderr: 로그 파일에만 기록
       │  └── 로그: logs/<instance>.log 에 append
       │
       ▼
     gateway.js — 이벤트 핸들링
       │  ├── step_start  → verbose 모드 시 진행 상태 메시지 edit
       │  ├── tool_use    → verbose 모드 시 tool 정보 전송
       │  ├── text        → finalText 누적 (마지막 text가 최종 응답)
       │  └── step_finish → (현재 무시)
       │
       ▼
     완료 시 (onDone)
       ├── finalText → md2html 변환 → Telegram HTML 전송
       ├── timeout → 타임아웃 메시지 전송
       └── 빈 출력 → "(no output)" 전송
```

## 인스턴스 격리
- 단일 `TelegramBot` 객체 사용
- repo마다 실행 컨텍스트 분리 (`running`, `verbose`, workdir, log)
- 프로세스/환경변수/작업디렉토리 분리
- 각 repo별 독립 `running` 플래그 (동시 실행 방지)
- 문제 발생 시 특정 repo bot만 재시작 가능

## 명령어 체계

| 명령어 | 동작 |
|--------|------|
| `/start` | 인스턴스 정보 + 현재 모드 표시 |
| `/status` | 인스턴스명, workdir, busy 상태, verbose 상태 |
| `/verbose on` | tool call, step 진행 상황 실시간 표시 모드 |
| `/verbose off` | 최종 결과만 표시 모드 (기본값) |
| `/whereami` | 현재 chat ID와 매핑 repo 확인 |
| 일반 텍스트 | `opencode run --format json <텍스트>` 실행 |

## 출력 처리 정책

### JSON 이벤트 파싱
- `opencode run --format json` 출력을 줄 단위로 파싱
- 이벤트 타입: `step_start`, `step_finish`, `text`, `tool_use`, `raw`
- 파싱 실패 시 `raw` 이벤트로 fallback

### Markdown → HTML 변환 (`md2html.js`)
- Fenced code block → `<pre><code>`
- Inline code → `<code>`
- Bold (`**`) → `<b>`
- Italic (`_`) → `<i>` (word-boundary만)
- Heading (`#`) → `<b>` (Telegram에 heading 태그 없음)

### 메시지 전송
- Telegram 4000자 제한 → 줄 바꿈 기준 자동 분할 (`splitByLimit`)
- HTML 전송 실패 시 plain text 재시도 (`safeSend`)
- 메시지 edit 실패 시 "not modified" 오류는 무시

### 진행 상태 표시
- 프롬프트 수신 시 "Running..." 상태 메시지 전송
- verbose 모드: step/tool 진행에 따라 상태 메시지 edit
- 완료 시 상태 메시지를 `[done/exit N/timeout] X step(s), Y tool(s)` 로 edit

## 실패 처리
- opencode 미설치: `proc.on('error')` → 즉시 오류 안내
- workdir 없음: spawn 실패 → 오류 안내
- 실행 시간 초과: `OMG_MAX_PROCESS_SECONDS` (기본 3600초) → SIGTERM → 5초 후 SIGKILL
- HTML 송신 실패: plain text 재시도
- 이미 실행 중: "Already running a task. Please wait." 응답
- chat ID 중복 매핑: 시작 시 즉시 오류 후 종료

## 환경 변수

| 변수 | 기본값 | 설명 | 상태 |
|------|--------|------|------|
| `OMG_MAX_PROCESS_SECONDS` | 3600 | 프로세스 타임아웃 (초) | **사용 중** |
| `OMG_STREAM_FLUSH_MS` | 1500 | 스트리밍 flush 간격 | ~~미구현~~ |
| `OMG_STREAM_CHUNK_BYTES` | 3000 | 스트리밍 청크 크기 | ~~미구현~~ |

## 설계 메모
- MVP에서는 명령 라우팅 최소화 (프롬프트 그대로 전달)
- 고급 명령(/diff, /apply, /branch 등)은 후속 버전
- 지금은 "모바일에서 불편해도 가능한 상태"가 성공 조건
- verbose 모드는 디버깅/모니터링 용도로 추가됨
