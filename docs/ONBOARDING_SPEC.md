# Onboarding Spec

목표: 사용자가 Telegram 연동을 위해 JSON 파일을 직접 만지지 않게 한다.

## UX 목표
1. `npx hermux onboard` 1회 실행으로 글로벌 봇 + repo 매핑 설정 완료
2. 입력 검증 즉시 수행 (토큰 형식, chat IDs 형식/중복, workdir 존재, opencode 설치 여부)
3. 완료 즉시 설정 파일 생성/업데이트 (repo 이름 기준 upsert)

## 질문 순서 (구현 완료)
1. **Global Telegram bot token** — 이미 있으면 교체 여부 확인 후 필요 시 재입력
2. **Repo 이름** — 영숫자, `-`, `_`만 허용 (`/^[a-zA-Z0-9_-]+$/`)
3. **허용 chat IDs** — 쉼표 구분 입력, 각 항목 숫자 검증 (`/^-?\d+$/`)
4. **Repo workdir 경로** — 절대경로 필수 + 디렉토리 존재 확인
5. **opencode 명령어** — 기본값: `opencode run`

> **참고**: 로그 파일 경로는 질문하지 않고 `./logs/<repo-name>.log`으로 자동 생성.

## 검증 흐름
각 입력마다 즉시 검증 → 통과 시 `✓`, 실패 시 `✗` + 오류 메시지 출력 후 종료.
- opencode PATH 확인은 경고만 (없어도 진행 가능 — 다른 경로에 설치되었을 수 있음)

## 저장 정책
- 저장 위치: `config/instances.json`
- 스키마:
  - `global.telegramBotToken`
  - `repos[]` (repo별 `chatIds[]` 포함)
- 동일 이름 repo → 덮어쓰기 (upsert)
- 새 repo → 배열에 추가
- 모든 repo 기본 `enabled: true`
- 민감값 저장: v0에서는 로컬 파일 허용 (개인용 전제)
- 추후 v1에서 키체인/시크릿 스토어 옵션 검토

## 런타임 정책
- 활성 repo(`enabled: true`)만 라우팅 대상
- 단일 봇 인스턴스로 polling 후 chat ID 기반 repo 라우팅
- chat ID 미매핑 요청은 무시 (`/start`, `/whereami`는 온보딩 힌트 응답)
- 프로세스 실행 시 repo workdir을 cwd로 사용 (spawn)
- repo당 동시 1개 작업만 실행 허용
- 중복 chat ID가 repo 간 충돌하면 시작 실패(fail fast)

## 실패 처리
- 검증 실패: 오류 메시지 + `process.exit(1)`
- 전체 온보딩 실패: catch → 오류 메시지 출력 후 종료
- 완료 시 다음 단계 안내: `npx hermux start`, `npx hermux onboard`
