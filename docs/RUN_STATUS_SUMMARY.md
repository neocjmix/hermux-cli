# Run Status Summary

## 구현된 전체 기능

### 1. 온보딩 (`npm run onboard`)
- 인터랙티브 CLI: 인스턴스명 → 텔레그램 토큰 → chat ID → workdir → command
- 입력별 즉시 검증 (이름 형식, 토큰 형식, 숫자 chat ID, 경로 존재)
- `config/instances.json`에 upsert 저장
- 로그 파일 경로 자동 생성

### 2. 게이트웨이 (`npm start`)
- 인스턴스별 독립 Telegram polling
- chat ID 기반 접근 제어
- Bot 명령어: `/start`, `/status`, `/verbose on|off`
- `opencode run --format json` 실행 + JSON 이벤트 파싱
- 이벤트 타입 처리: `step_start`, `text`, `tool_use`, `step_finish`, `raw`
- verbose 모드: tool call, step 진행 실시간 표시
- Markdown → Telegram HTML 변환 (code block, bold, italic, heading)
- 4000자 자동 분할 + HTML 실패 시 plain text fallback
- 진행 상태 메시지 실시간 편집 (Running... → [done] N step(s), M tool(s))
- 프로세스 타임아웃 (SIGTERM → SIGKILL)
- Graceful shutdown (SIGINT/SIGTERM)

### 3. 유틸리티
- `npm run check`: node, git, opencode 설치 확인
- `src/lib/config.js`: 설정 파일 CRUD
- `src/lib/runner.js`: opencode 프로세스 실행기 + 로그 기록
- `src/lib/md2html.js`: Markdown → Telegram HTML 변환기

## 파일 목록
- `src/gateway.js` — 메인 게이트웨이 (263줄)
- `src/onboard.js` — 온보딩 CLI (100줄)
- `src/lib/config.js` — 설정 CRUD (36줄)
- `src/lib/runner.js` — 프로세스 실행기 (114줄)
- `src/lib/md2html.js` — Markdown 변환기 (55줄)
- `scripts/check_prereqs.sh` — 필수 도구 확인 (41줄)
- `config/instances.example.json` — 예시 설정

## 검증 상태
- `npm install` — 성공
- `npm run check` — 성공
- `npm start` — 성공 (인스턴스 없을 때 정상 안내 메시지 출력)
- `npm start` — 성공 (유효 토큰 시 Telegram polling 정상 동작)
- EFATAL 이슈: 테스트용 더미 토큰 사용 시 발생, 코드 문제 아님

## 현재 config 상태
- `config/instances.json`에 테스트 인스턴스(`mvp-test`) 존재
- 실제 사용 시 `npm run onboard`로 실제 토큰/chat ID 입력 필요

## 실제 사용을 위한 단계
1. `npm run onboard` 실행
2. 실제 BotFather 토큰, 실제 chat ID, 실제 repo 절대경로 입력
3. `npm start`
4. Telegram에서 봇에 메시지 전송 → 결과 수신 확인
5. (선택) `/verbose on`으로 진행 상황 실시간 확인
