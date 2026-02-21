# Implementation Status

> 최종 업데이트: 2026-02-17

## 구현 완료

| 항목 | 파일 | 상태 |
|------|------|------|
| 인터랙티브 온보딩 CLI | `src/onboard.js` | **완료** |
| 입력 검증 (이름, 토큰, chat ID, workdir) | `src/onboard.js` | **완료** |
| opencode PATH 확인 | `src/onboard.js` | **완료** |
| 인스턴스 설정 CRUD (upsert) | `src/lib/config.js` | **완료** |
| enabled 인스턴스만 로드 | `src/lib/config.js` | **완료** |
| 인스턴스별 Telegram polling | `src/gateway.js` | **완료** |
| chat ID 기반 접근 제어 | `src/gateway.js` | **완료** |
| `/start` 명령어 | `src/gateway.js` | **완료** |
| `/status` 명령어 | `src/gateway.js` | **완료** |
| `/verbose on\|off` 모드 | `src/gateway.js` | **완료** |
| 단일 작업 동시성 제어 (running lock) | `src/gateway.js` | **완료** |
| `opencode serve` 기반 실행 | `src/lib/runner.js` | **완료** |
| JSON 이벤트 파싱 (step_start, text, tool_use, step_finish) | `src/lib/runner.js` | **완료** |
| 프로세스 타임아웃 (SIGTERM → SIGKILL) | `src/lib/runner.js` | **완료** |
| 로그 파일 기록 (append) | `src/lib/runner.js` | **완료** |
| Markdown → Telegram HTML 변환 | `src/lib/md2html.js` | **완료** |
| 4000자 메시지 자동 분할 | `src/gateway.js` | **완료** |
| HTML 전송 실패 → plain text fallback | `src/gateway.js` | **완료** |
| 진행 상태 메시지 실시간 편집 | `src/gateway.js` | **완료** |
| verbose 모드 tool call 실시간 전송 | `src/gateway.js` | **완료** |
| 완료 요약 메시지 (step/tool count) | `src/gateway.js` | **완료** |
| Graceful shutdown (SIGINT/SIGTERM) | `src/gateway.js` | **완료** |
| 필수 도구 확인 스크립트 | `scripts/check_prereqs.sh` | **완료** |
| 예시 설정 파일 | `config/instances.example.json` | **완료** |
| .gitignore (instances.json, logs, .env) | `.gitignore` | **완료** |

## 미구현 (계획에 있었으나 아직 안 됨)

| 항목 | 원래 계획 | 현재 상태 | 비고 |
|------|-----------|-----------|------|
| 시간 기반 스트리밍 flush | ARCHITECTURE.md 초안: 1~2초 간격 | **미구현** | `.env.example`에 `OMG_STREAM_FLUSH_MS` 정의만 있고 코드에서 미사용 |
| 크기 기반 스트리밍 flush | ARCHITECTURE.md 초안: 2~4KB | **미구현** | `.env.example`에 `OMG_STREAM_CHUNK_BYTES` 정의만 있고 코드에서 미사용 |
| 온보딩 로그 파일 경로 질문 | ONBOARDING_SPEC.md: 질문 #6 | **대체** | 자동 생성으로 대체 (`./logs/<name>.log`) |
| 송신 실패 시 로그 경로 통지 | ARCHITECTURE.md: 로컬 파일 저장 후 경로 통지 | **미구현** | 현재는 plain text fallback만 |
| 온보딩 실패 상세 안내 | ONBOARDING_SPEC.md: 누락 항목, 재실행 명령, 수동 경로 | **부분** | 오류 메시지 + exit만 구현 |
| 키체인/시크릿 스토어 | ONBOARDING_SPEC.md: v1 검토 | **미구현** | v1으로 보류 |

## 의도적 미구현 (후속 버전으로 보류)

| 항목 | 비고 |
|------|------|
| `/diff` 명령어 | ARCHITECTURE.md: "고급 명령은 후속 버전" |
| `/apply` 명령어 | 동상 |
| `/branch` 명령어 | 동상 |
| OpenClaw 에이전트 연동 | NON_GOALS_AND_GUARDRAILS.md: "절대 하지 않음" |
| LLM 이중 호출 구조 | 동상 |

## 계획에 없었지만 추가 구현된 기능

| 항목 | 파일 | 설명 |
|------|------|------|
| `/start` 명령어 | `src/gateway.js` | 인스턴스 정보 + 현재 모드 표시 |
| `/status` 명령어 | `src/gateway.js` | workdir, busy 상태, verbose 상태 |
| `/verbose on\|off` | `src/gateway.js` | tool call 실시간 표시 토글 |
| JSON 이벤트 파싱 | `src/lib/runner.js` | `/event` SSE 출력 구조적 파싱 |
| Markdown→HTML 변환기 | `src/lib/md2html.js` | code block, bold, italic, heading 지원 |
| 진행 상태 메시지 편집 | `src/gateway.js` | "Running..." → "[done] N step(s), M tool(s)" |
| Tool call 브리핑 | `src/gateway.js` | command/filePath/pattern 기반 요약 표시 |

## 코드베이스 통계

| 항목 | 값 |
|------|-----|
| 총 JS 파일 | 5개 |
| 총 코드 줄 수 | ~568줄 |
| 의존성 | 1개 (`node-telegram-bot-api`) |
| Node.js 순수 모듈 사용 | `readline`, `fs`, `path`, `child_process` |
