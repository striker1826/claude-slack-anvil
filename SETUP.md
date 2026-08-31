# peaktree-anvil 설정 가이드

Slack DM으로 코딩 작업을 요청하면, 서버에 상시 떠 있는 이 봇이 headless `claude -p`를 실행해
대상 repo의 코드를 고치고, 브랜치를 push한 뒤 GitHub에 draft PR을 올린다. 자동 머지는 없다 —
항상 리뷰 후 직접 머지.

```
[내 폰의 Slack DM]
   → Slack Socket Mode (봇이 아웃바운드로 연결, 공개 포트/도메인 불필요)
   → index.js (허용된 사용자 ID인지 확인)
   → lib/runTask.js
       git checkout -b <BRANCH_PREFIX>/... → claude -p "<요청>" (ANVIL_HEADLESS=1)
       → 변경 있으면 git add <구체 파일> → commit → push
       → gh pr create --draft
   → Slack로 PR 링크 회신
```

---

## 1. Slack App 만들기 (Socket Mode)

1. https://api.slack.com/apps → **Create New App** → **From scratch** → 이름(예: `peaktree-anvil`), 워크스페이스 선택.
2. 좌측 **Socket Mode** → Enable Socket Mode 켜기. App-Level Token 생성 시 `connections:write` 스코프 추가 → 생성된 토큰(`xapp-...`)이 `SLACK_APP_TOKEN`.
3. 좌측 **OAuth & Permissions** → **Bot Token Scopes**에 추가:
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `files:write` (`PREVIEW_ENABLED=true`로 디자인 목업 스크린샷을 Slack에 올릴 때 필요)
4. 좌측 **Event Subscriptions** → Enable → **Subscribe to bot events**에 `message.im` 추가. (Socket Mode라 Request URL 입력은 필요 없다.)
5. 좌측 **OAuth & Permissions** 상단 **Install to Workspace** 실행 → 생성된 **Bot User OAuth Token**(`xoxb-...`)이 `SLACK_BOT_TOKEN`.
6. 내 Slack 프로필 클릭 → **More** → **Copy member ID** → `ALLOWED_SLACK_USER_ID`. 이 ID가 아닌 사람이 DM을 보내면 봇이 조용히 무시한다.
7. 이 앱을 설치한 워크스페이스에서 봇에게 DM을 보낼 수 있는지 확인 (앱 홈에서 "메시지 보내기").

## 2. 봇 호스트(서버) 준비

봇을 24/7 돌릴 머신(EC2 등). 예시는 Ubuntu 기준.

```bash
# Node.js 20+, git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# GitHub CLI — PR 생성에 필요. 대상 repo에 push/PR 권한이 있는 계정으로 로그인.
sudo apt-get install -y gh
gh auth login

# Claude Code CLI — 설치 후 로그인 (또는 ANTHROPIC_API_KEY를 env로).
# 설치 방법은 claude.com/code 참고. 로그인 후 아래로 headless 동작을 먼저 직접 확인할 것:
#   claude -p "hello" --permission-mode acceptEdits
# --permission-mode 플래그명/값은 설치된 버전에 따라 다를 수 있으니 `claude -p --help`로 먼저 확인.

# 대상 repo clone
git clone https://github.com/<owner>/<repo>.git /home/ubuntu/<repo>
cd /home/ubuntu/<repo>
# 이 repo의 의존성 설치 / 코드 생성 등 대상 프로젝트가 요구하는 준비를 여기서 해둔다.
# (예: npm install / pnpm install, prisma generate 등 — 대상 repo의 README를 따를 것)
```

**대상 repo에 Stop 훅 등 품질 게이트가 있다면** (`tsc --noEmit`, lint 등), 그게 도는 데 필요한
`node_modules`/`.env`가 이 클론에 갖춰져 있어야 봇이 만든 변경이 게이트를 통과한다. `.env`는 가급적
프로덕션이 아니라 개발/스테이징 리소스를 가리키게 할 것.

### 대상 repo가 기대하는 것 (선택)

봇은 대상 repo에 대해 아무것도 강제하지 않지만, 아래가 있으면 활용한다:

- **커스텀 슬래시 커맨드**: `.claude/commands/<name>.md`가 있고 `CLAUDE_SLASH_COMMAND=/<name>`로
  지정하면, 첫 요청이 `/<name> <요청>` 형태로 전달된다. headless(`-p`) 모드에서도 확장되는지
  첫 실행 로그로 확인할 것.
- **`ANVIL_HEADLESS` 인식 훅**: 봇은 claude 실행 시 `ANVIL_HEADLESS=1`을 넣는다. 대상 repo의
  PreToolUse 훅 등이 이 값을 보고 "확인이 필요한(ask) 위험 명령"을 자동 차단하도록 만들어두면,
  승인해줄 사람이 없는 무인 실행에서 fail-closed로 동작한다. 없으면 그냥 무시된다.
- 이 하네스 파일들(`CLAUDE.md`, `.claude/`)이 **대상 repo에 커밋되어 push**되어 있어야
  봇이 만든 클론에 반영된다. 로컬에만 있으면 봇은 훅 없이 동작한다.

## 3. peaktree-anvil 배포

로컬에서 서버로 복사하거나, 서버에서 이 repo를 직접 clone:
```bash
git clone https://github.com/<owner>/peaktree-anvil.git /home/ubuntu/peaktree-anvil
cd /home/ubuntu/peaktree-anvil
```

서버에서:
```bash
npm install
cp .env.example .env
# .env 채우기 (필수): SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_SLACK_USER_ID,
#                     REPO_PATH=/home/ubuntu/<repo>, GITHUB_REPO=<owner>/<repo>

# PREVIEW_ENABLED=true 로 쓸 때만:
npx playwright install --with-deps chromium

npm install -g pm2   # 없으면
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 출력되는 명령을 그대로 한 번 더 실행 (재부팅 시 자동 시작)
```

## 4. 확인

```bash
pm2 logs peaktree-anvil
```
`⚡️ peaktree-anvil bot running (Socket Mode)` 이 뜨면 정상. Slack에서 봇에게 읽기 위주 요청을
하나 보내서 (예: "src/foo.ts 파일 요약해줘") 전체 흐름이 도는지 먼저 확인한 뒤, 실제 코드 변경
요청을 시도할 것.

## 대화 연속성

Slack 메시지 하나마다 완전히 새 세션을 시작하지 않는다. 채널(대화)당 진행 중인 브랜치/`claude`
세션 ID를 `SESSION_TTL_MS`(기본 30분)간 기억해서, "응", "이렇게 진행해줘" 같은 후속 답변이 이전
계획 제안에 이어붙는다. 코드 변경 없이 끝나면(질문 답변, 계획 제안 등) 세션을 계속 열어두고, PR이
만들어지거나 에러가 나면 그 시점에 닫는다 — 다음 메시지는 새 작업으로 취급된다. "새 작업"이라고
보내면 언제든 강제로 리셋된다.

## 디자인 목업 스크린샷 (`PREVIEW_ENABLED=true`)

화면/디자인이 걸린 작업이면, `claude`에게 프로젝트 루트에 `.anvil-preview.html`(정적, mock 데이터,
서버·DB·로그인 불필요)을 만들라는 지침을 프롬프트에 자동으로 덧붙인다. 이 파일이 생기면 Playwright로
스크린샷을 찍고 원본 html은 지운다.
- 코드 변경 없이 계획만 제안하는 단계라면 → 스크린샷을 Slack에 파일로 바로 업로드.
- 실제 코드 변경까지 갔다면 → `docs/pr-screenshots/<branch>.png`로 커밋해서 PR 본문에
  `raw.githubusercontent.com/.../<commit-sha>/...` 링크로 임베드 (브랜치명에 슬래시가 있어서
  커밋 SHA 기준 URL을 쓴다 — ref 파싱 모호성 회피).
- `PREVIEW_VIEWPORT`(예: `430x932`), `PREVIEW_UI_PATTERN`, `PREVIEW_INSTRUCTION`로 세부 조정.

## 안전장치 정리

- **화이트리스트**: `ALLOWED_SLACK_USER_ID` 외 사용자의 메시지는 무시.
- **fail-closed 신호**: headless 실행 시 `ANVIL_HEADLESS=1`을 넣는다. 대상 repo가 이를 인식하면
  "확인 필요(ask)" 명령까지 자동 차단하게 만들 수 있다 (승인해줄 사람이 없으므로).
- **베이스 브랜치 직접 push 금지**: 항상 새 브랜치 → draft PR. 봇은 `BASE_BRANCH`로 직접 커밋/push하지 않는다.
- **자동 머지 없음**: `gh pr create --draft`만 하고 끝. 머지는 항상 사람이.
- **동시 실행 직렬화**: 같은 워킹 디렉터리를 여러 작업이 동시에 건드리지 않도록 큐로 순서를 강제.
- **셸 인젝션 방지**: Slack 텍스트를 `child_process.execFile`(배열 인자, 셸 미경유)로만 전달 —
  `exec`나 문자열 셸 명령 조립은 쓰지 않는다.

## 알려진 한계 / 다음에 확인할 것

- claude가 "질문으로 끝났는지"(예: 승인 필요한 정책 변경을 스스로 결정하지 않고 되물은 경우)와
  "작업을 완료했는지"를 봇이 구분하지 못한다. 코드 변경이 있으면 무조건 커밋 → draft PR로 이어진다.
  실사용상 draft PR은 항상 리뷰 후 머지하므로 안전 문제는 아니지만, 가끔 애매한 draft PR이 하나
  더 생길 수 있다.
- `.anvil-preview.html` 목업 지침은 `PREVIEW_ENABLED=true`면 모든 요청에 프롬프트로 덧붙는다 —
  화면과 무관한 요청에는 claude가 파일을 안 만들 것으로 기대하지만, 강제하는 장치는 없다.
- 봇이 재시작되면 진행 중이던 세션/브랜치 상태(메모리에만 있음)가 사라진다. 그 시점에 로컬에
  남아있던 브랜치는 고아가 될 수 있음 — 주기적으로 `git branch`로 정리.
- 에러 발생 시 브랜치가 봇 호스트 로컬에 남을 수 있음 (실패 지점에 따라). 주기적으로 `git branch`로 정리.
