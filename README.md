# peaktree-anvil

Slack DM으로 코딩 작업을 요청하면, 서버에 상시 떠 있는 이 봇이 **headless [Claude Code](https://claude.com/code)** (`claude -p`)를 실행해 지정한 repo의 코드를 고치고, 브랜치를 push한 뒤 GitHub에 **draft PR**을 올린다. 자동 머지는 없다 — 항상 사람이 리뷰 후 머지한다.

```
[내 폰의 Slack DM]
   → Slack Socket Mode (봇이 아웃바운드로 연결 — 공개 포트/도메인 불필요)
   → index.js (허용된 Slack 사용자 ID인지 확인 — 화이트리스트)
   → lib/runTask.js
       git checkout -b <prefix>/... → claude -p "<요청>"  (ANVIL_HEADLESS=1)
       → 변경이 있으면 git add <구체 파일> → commit → push
       → gh pr create --draft
   → Slack으로 PR 링크 회신
```

## 특징 / 안전장치

- **화이트리스트**: `ALLOWED_SLACK_USER_ID` 외 사용자의 DM은 조용히 무시.
- **자동 머지 없음**: `gh pr create --draft`까지만. 머지는 항상 사람이.
- **베이스 브랜치 직접 push 금지**: 항상 새 브랜치 → draft PR.
- **명시적 스테이징**: `git add -A`가 아니라 이번 작업으로 바뀐 파일만 골라 add (작업 전부터 있던 변경을 스냅샷 비교로 제외).
- **셸 인젝션 방지**: Slack 텍스트는 `child_process.execFile`(배열 인자, 셸 미경유)로만 전달.
- **동시 실행 직렬화**: 같은 워킹 디렉터리를 여러 작업이 동시에 건드리지 않도록 큐로 순서 강제.
- **대화 연속성**: 채널당 진행 중 브랜치/세션을 30분간 기억해서 "응", "그렇게 해줘" 같은 후속 답변이 이전 작업에 이어붙는다. `새 작업`이라고 보내면 리셋.
- **빠른 레인** (토큰 절약): `style:`, `text:`, `카피:` 등으로 시작하는 요청은 전체 맥락 파악 없이 저렴한 모델(기본 Haiku) + 탐색 억제 지침 + 턴 상한으로 처리한다. 사소한 문구/스타일 수정에 전체 코드베이스를 훑느라 토큰이 새는 걸 막는다. resume 후속 답변은 원래 작업의 레인을 그대로 물려받는다.
- **fail-closed 신호**: claude 실행 시 `ANVIL_HEADLESS=1`을 넣는다. 대상 repo에 이 값을 읽는 훅(위험 명령 자동 차단 등)이 있으면 활용되고, 없으면 무시된다.
- **디자인 목업 스크린샷** (opt-in): 웹 프론트엔드 repo라면 화면 관련 작업 시 정적 HTML 목업을 만들어 스크린샷을 Slack / PR 본문에 첨부.

## 빠른 시작

1. **Slack App**을 Socket Mode로 만들고 토큰 2개(`xoxb-`, `xapp-`)와 내 member ID를 확보한다. → [SETUP.md](SETUP.md) 1단계
2. 봇을 돌릴 서버(EC2 등)에 Node.js 20+, `git`, `gh`(로그인), `claude`(로그인)를 준비하고, 대상 repo를 clone한다. → [SETUP.md](SETUP.md) 2단계
3. 이 repo를 서버에 두고:
   ```bash
   npm install
   cp .env.example .env    # 값 채우기 (아래 참고)
   npx playwright install --with-deps chromium   # PREVIEW_ENABLED=true 일 때만 필요
   npm install -g pm2
   pm2 start ecosystem.config.js && pm2 save && pm2 startup
   ```
4. `pm2 logs peaktree-anvil` 에 `⚡️ peaktree-anvil bot running (Socket Mode)` 가 뜨면 봇에게 DM으로 가벼운 요청부터 시도. → [SETUP.md](SETUP.md) 3~4단계

## 설정 (`.env`)

| 변수 | 필수 | 설명 |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | ✅ | App-Level Token (`xapp-...`, `connections:write`) |
| `ALLOWED_SLACK_USER_ID` | ✅ | 이 Slack 사용자만 봇을 트리거 가능 |
| `REPO_PATH` | ✅ | 봇이 작업할 대상 repo의 로컬 클론 경로 |
| `GITHUB_REPO` | ✅ | 대상 repo 슬러그 `owner/name` |
| `CLAUDE_BIN` | | claude 실행 파일 (기본 `claude`) |
| `CLAUDE_PERMISSION_MODE` | | 기본 `bypassPermissions` |
| `CLAUDE_SLASH_COMMAND` | | 대상 repo의 커스텀 슬래시 커맨드 (예: `/start`). 비우면 요청 텍스트 그대로 |
| `BRANCH_PREFIX` / `BASE_BRANCH` | | 기본 `anvil` / `main` |
| `TASK_TIMEOUT_MS` / `SESSION_TTL_MS` | | 기본 15분 / 30분 |
| `FAST_LANE_PATTERN` | | 빠른 레인 트리거 정규식. 기본 `^(텍스트\|문구\|카피\|스타일\|copy\|text\|style\|css)\s*[:：]\s*` |
| `FAST_MODEL` | | 빠른 레인 모델. 기본 `claude-haiku-4-5-20251001` |
| `FAST_MAX_TURNS` / `FAST_INSTRUCTION` | | 빠른 레인 턴 상한(기본 15) / 탐색 억제 지침 덮어쓰기 |
| `PREVIEW_ENABLED` | | 디자인 목업 스크린샷 기능 on/off (기본 `false`) |
| `PREVIEW_VIEWPORT` / `PREVIEW_UI_PATTERN` / `PREVIEW_INSTRUCTION` | | 프리뷰 세부 설정 |

## 요구사항

- 봇 호스트: Node.js 20+, `git`
- `gh` CLI — 대상 repo에 push/PR 권한이 있는 계정으로 `gh auth login`
- `claude` CLI — 로그인(또는 `ANTHROPIC_API_KEY`). headless 동작을 먼저 `claude -p "hello"` 로 확인
- `PREVIEW_ENABLED=true` 시 Playwright Chromium

## 보완해야 할 지점

- 봇은 claude가 "질문으로 끝났는지"와 "작업을 완료했는지"를 구분하지 못한다. 코드 변경이 있으면 무조건 커밋 → draft PR. (draft라 항상 리뷰 후 머지하므로 안전 문제는 아니지만, 가끔 애매한 draft PR이 하나 더 생길 수 있다.)
- 진행 중 세션/브랜치 상태는 메모리에만 있다. 봇 재시작 시 사라지고, 그 시점 로컬 브랜치는 남게 될 수 있다 — 주기적으로 `git branch`로 정리.
- 에러 지점에 따라 대상 repo 로컬에 브랜치가 남을 수 있다.

## 라이선스

[MIT](LICENSE)
# claude-slack-anvil
