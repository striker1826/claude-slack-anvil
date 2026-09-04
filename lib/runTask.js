const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { screenshotHtmlFile } = require('./screenshot');

// ── 설정 (전부 .env로 제어. .env.example 참고) ──────────────────────────────
const REPO_PATH = process.env.REPO_PATH; // 봇이 작업할 대상 repo의 로컬 클론 경로 (필수)
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/name" — gh PR 생성 + raw 스크린샷 URL에 사용 (필수)
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
// 대상 repo에 커스텀 슬래시 커맨드(예: "/start")가 있으면 여기에. 비워두면 요청 텍스트를 그대로 넘긴다.
const CLAUDE_SLASH_COMMAND = (process.env.CLAUDE_SLASH_COMMAND || '').trim();
const BRANCH_PREFIX = (process.env.BRANCH_PREFIX || 'anvil').replace(/\/+$/, '');
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '900000', 10); // 15분
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '1800000', 10); // 30분 — 이 안엔 "응", 후속 답변이 같은 작업으로 이어붙는다.

// ── 빠른 레인 (작은 텍스트/스타일 수정) ────────────────────────────────────
// Slack 요청이 "style:", "text:", "카피:" 같은 접두사로 시작하면 전체 맥락 파악 없이
// 저렴한 모델 + 탐색 억제 지침 + 턴 상한으로 처리해 토큰 소비를 줄인다.
const FAST_LANE_PATTERN = new RegExp(
	process.env.FAST_LANE_PATTERN || '^(텍스트|문구|카피|스타일|copy|text|style|css)\\s*[:：]\\s*',
	'i'
);
// 빠른 레인에서 쓰는 모델. 기본은 가장 저렴한 Haiku.
const FAST_MODEL = process.env.FAST_MODEL || 'claude-haiku-4-5-20251001';
// 빠른 레인 에이전트 루프 상한 (폭주 탐색 방지).
const FAST_MAX_TURNS = (process.env.FAST_MAX_TURNS || '15').trim();
// 빠른 레인일 때 프롬프트에 붙이는 탐색 억제 지침. .env로 통째로 덮어쓸 수 있다.
const FAST_INSTRUCTION =
	'\n\n' +
	(process.env.FAST_INSTRUCTION ||
		'(이 작업은 작은 텍스트/스타일 수정이다. 아키텍처·데이터 흐름을 탐색하지 말고, Grep으로 대상 문자열·클래스·셀렉터만 찾아 1~2개 파일만 열어 최소 diff로 고쳐라. 테스트·빌드·리팩터링·포매팅 금지. 2~3번 검색해도 대상을 못 찾으면 멈추고 어디를 고쳐야 하는지 되물어라.)');

// 디자인 목업 스크린샷 기능 (opt-in). 대상 repo가 웹 프론트엔드일 때만 의미가 있다.
const PREVIEW_ENABLED = /^(1|true|yes)$/i.test(process.env.PREVIEW_ENABLED || '');
// 화면(UI) 파일이 바뀌었는지 판별하는 정규식. 이게 바뀌었는데 스크린샷이 없으면 별도 단계로 강제 생성한다.
const PREVIEW_UI_PATTERN = new RegExp(
	process.env.PREVIEW_UI_PATTERN || '\\.(tsx?|jsx?|vue|svelte|css|scss|html)$'
);
// claude에게 목업을 만들라고 붙이는 지침. 프로젝트에 맞게 .env로 통째로 덮어쓸 수 있다.
const DESIGN_MOCKUP_INSTRUCTION =
	'\n\n' +
	(process.env.PREVIEW_INSTRUCTION ||
		'(추가 지침 — 화면/디자인 변경이 포함된 작업일 때만 적용) 변경 후 화면이 어떻게 보일지 보여주는 정적 HTML 목업을 프로젝트 루트에 .anvil-preview.html로 만들어라(또는 이미 있으면 최신 상태로 갱신). 서버·DB·로그인 없이 브라우저에서 파일로 바로 열어볼 수 있어야 한다 — mock 데이터를 인라인으로 넣고, 프로젝트의 실제 CSS/디자인 토큰을 최대한 그대로 반영해서 실제 화면과 비슷하게 보이게 할 것. 이 파일 자체는 커밋 대상이 아니다(자동으로 스크린샷만 찍고 정리된다). 디자인/화면 변경이 아닌 작업이면 이 파일을 만들지 않는다.');

const PREVIEW_HTML_PATH = () => path.join(REPO_PATH, '.anvil-preview.html');

// execFile은 셸을 거치지 않고 인자를 배열로 넘기므로, Slack에서 온 사용자 텍스트를
// 그대로 명령 인자에 넣어도 셸 인젝션 위험이 없다. exec()/shell:true는 쓰지 않는다.
function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{
				cwd: REPO_PATH,
				maxBuffer: 1024 * 1024 * 50,
				timeout: TASK_TIMEOUT_MS,
				// stdin을 열어둔 채로 두면(execFile 기본값) claude가 파이프 입력을 기다리다
				// "no stdin data received in 3s" 경고와 함께 비정상 종료하는 경우가 있었다.
				// 아무것도 보낼 게 없으니 처음부터 닫아둔다.
				stdio: ['ignore', 'pipe', 'pipe'],
				...opts,
			},
			(err, stdout, stderr) => {
				if (err) {
					err.stdout = stdout;
					err.stderr = stderr;
					return reject(err);
				}
				resolve({ stdout, stderr });
			}
		);
	});
}

// claude 실행 시 넘기는 환경변수. ANVIL_HEADLESS=1 은 "무인 실행"이라는 신호로,
// 대상 repo에 이 값을 읽는 훅(예: 위험 명령을 자동 차단하는 guard 스크립트)이 있으면 활용된다.
// 그런 훅이 없으면 그냥 무시되는 무해한 변수다.
const claudeEnv = () => ({ ...process.env, ANVIL_HEADLESS: '1' });

function slugify(text) {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.split(/\s+/)
		.slice(0, 5)
		.join('-');
	return slug || 'task';
}

async function gitStatusLines() {
	const { stdout } = await run('git', ['status', '--porcelain']);
	// porcelain 형식은 "XY<space>path" 고정폭이고 X/Y 자리에 공백이 올 수 있다(예: " M path" =
	// 스테이징 안 된 수정). 앞뒤 trim을 하면 이 의미있는 선행 공백이 날아가 상태코드가 밀리므로,
	// 줄바꿈만 제거하고 그대로 둔다.
	return stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
}

// "XY<space>path" 에서 path만 뽑는다. XY는 항상 2글자(공백 포함) + 공백 1개 = 고정 3글자.
function statusLineToPath(line) {
	return line.slice(3);
}

async function cleanupBranch(branch) {
	try {
		await run('git', ['checkout', BASE_BRANCH]);
		await run('git', ['branch', '-D', branch]);
	} catch (_) {
		// best-effort cleanup
	}
}

// claude가 .anvil-preview.html을 만들어뒀으면 스크린샷을 찍어 임시 PNG로 저장하고,
// 목업 html 자체는 지운다(커밋 대상이 아니므로). 없으면 null.
async function capturePreviewIfAny() {
	if (!PREVIEW_ENABLED) return null;
	const htmlPath = PREVIEW_HTML_PATH();
	if (!fs.existsSync(htmlPath)) return null;

	const tmpPng = path.join(os.tmpdir(), `anvil-preview-${Date.now()}.png`);
	try {
		await screenshotHtmlFile(htmlPath, tmpPng);
	} catch (err) {
		fs.rmSync(htmlPath, { force: true });
		return { error: `프리뷰 스크린샷 실패: ${err.message}` };
	}
	fs.rmSync(htmlPath, { force: true });
	return { pngPath: tmpPng };
}

// Slack 채널(=대화 하나)당 진행 중인 작업의 브랜치/세션을 기억한다.
// PR이 만들어지거나 에러로 끝나면 지운다 — 다음 메시지는 새 작업으로 취급.
// 메모리에만 있어서 봇이 재시작되면 사라진다 (그 경우 다음 메시지는 그냥 새 작업으로 시작됨. 무해함).
const pendingTasks = new Map();

function isFreshRequest(text) {
	const t = text.trim();
	return t === '새 작업' || t === '새작업' || t.toLowerCase() === 'reset';
}

// 화면(UI) 파일이 바뀌었는지 — 이게 바뀌었는데 스크린샷이 없으면 별도 단계로 강제 생성한다.
function touchesUi(changedFiles) {
	return changedFiles.some((f) => !f.includes('/api/') && PREVIEW_UI_PATTERN.test(f));
}

async function runTaskInner(channelId, requestText) {
	if (isFreshRequest(requestText)) {
		pendingTasks.delete(channelId);
		return { status: 'no-change', answer: '새 작업으로 초기화했습니다. 다음 메시지부터 새로 시작합니다.' };
	}

	const pending = pendingTasks.get(channelId);
	const isResume = pending && Date.now() - pending.updatedAt < SESSION_TTL_MS;

	let branch, sessionId, originalRequest;
	if (isResume) {
		branch = pending.branch;
		sessionId = pending.sessionId;
		originalRequest = pending.originalRequest;
		await run('git', ['checkout', branch]);
	} else {
		branch = `${BRANCH_PREFIX}/${Date.now()}-${slugify(requestText)}`.slice(0, 60);
		sessionId = crypto.randomUUID();
		originalRequest = requestText;
		await run('git', ['checkout', BASE_BRANCH]);
		await run('git', ['pull', '--ff-only', 'origin', BASE_BRANCH]);
		await run('git', ['checkout', '-b', branch]);
	}

	// claude 실행 전 상태를 스냅샷 — 작업 시작 전부터 이미 있던 untracked/modified 파일을
	// "이번에 만든 변경"으로 오인해 커밋에 쓸어담지 않기 위해서다 (실제로 한 번 걸렸던 버그).
	const beforeLines = await gitStatusLines();

	// 빠른 레인 판정은 최초 요청 텍스트로만 한다 (resume 후속 답변엔 접두사가 없으므로
	// 원래 작업의 레인을 그대로 물려받는다).
	const isFastLane = isResume
		? !!pending.fastLane
		: FAST_LANE_PATTERN.test(requestText);

	const promptText =
		requestText +
		(PREVIEW_ENABLED && !isFastLane ? DESIGN_MOCKUP_INSTRUCTION : '') +
		(isFastLane ? FAST_INSTRUCTION : '');
	const firstPrompt = CLAUDE_SLASH_COMMAND ? `${CLAUDE_SLASH_COMMAND} ${promptText}` : promptText;

	const modelArgs = isFastLane ? ['--model', FAST_MODEL, '--max-turns', FAST_MAX_TURNS] : [];
	const claudeArgs = isResume
		? ['-p', promptText, '--resume', sessionId, '--permission-mode', CLAUDE_PERMISSION_MODE, ...modelArgs]
		: ['-p', firstPrompt, '--session-id', sessionId, '--permission-mode', CLAUDE_PERMISSION_MODE, ...modelArgs];

	let claudeResult;
	try {
		claudeResult = await run(CLAUDE_BIN, claudeArgs, { env: claudeEnv() });
	} catch (err) {
		pendingTasks.delete(channelId);
		if (!isResume) await cleanupBranch(branch);
		return { status: 'error', reason: `claude -p 실행 실패:\n${(err.stderr || err.message || '').slice(-1500)}` };
	}

	// 목업이 있으면 스크린샷부터 떼어내둔다 — 아래 git status 스냅샷 비교에 .anvil-preview.html
	// 자체가 "변경 파일"로 잡히면 안 되므로(커밋 대상이 아님), 스냅샷 비교 전에 지운다.
	const preview = await capturePreviewIfAny();

	const afterLines = await gitStatusLines();
	const beforeSet = new Set(beforeLines);
	const newLines = afterLines.filter((l) => !beforeSet.has(l));
	const changedFiles = newLines.map(statusLineToPath);

	if (changedFiles.length === 0) {
		// 변경이 없다고 끝난 게 아니다 — 질문에 대한 답변이거나, 계획 제안 후 확인을 기다리는
		// 중일 수 있다. 브랜치/세션을 지우지 않고 유지해서 다음 메시지가 이어붙게 한다.
		pendingTasks.set(channelId, { branch, sessionId, originalRequest, fastLane: isFastLane, updatedAt: Date.now() });
		return {
			status: 'no-change',
			answer: claudeResult.stdout.trim().slice(-2500),
			previewPngPath: preview && preview.pngPath ? preview.pngPath : null,
		};
	}

	// 실제 화면 파일이 바뀌었는데 목업을 안 만들었으면(소프트 지침이라 가끔 빼먹는다) —
	// 프롬프트 한 줄에 기대지 말고 별도 단계로 확실하게 만들게 한다. 같은 세션에서 이어서
	// 요청하므로 방금 구현한 코드를 그대로 보고 목업을 만든다.
	let finalPreview = preview;
	if (PREVIEW_ENABLED && !isFastLane && (!preview || !preview.pngPath) && touchesUi(changedFiles)) {
		try {
			await run(
				CLAUDE_BIN,
				[
					'-p',
					'방금 구현한 화면 변경 결과를 보여주는 정적 HTML 목업을 프로젝트 루트에 .anvil-preview.html로 만들어줘. 서버·DB·로그인 없이 파일로 바로 열 수 있어야 해(mock 데이터 인라인). 실제 CSS 변수/클래스를 그대로 반영해서 진짜 화면처럼 보이게 해줘. 다른 파일은 절대 건드리지 마.',
					'--resume',
					sessionId,
					'--permission-mode',
					CLAUDE_PERMISSION_MODE,
				],
				{ env: claudeEnv() }
			);
			finalPreview = await capturePreviewIfAny();
			// 이 단계에서 claude가 실수로 다른 파일까지 건드렸는지 확인해 커밋 대상에 반영한다.
			const afterFollowup = await gitStatusLines();
			const afterSet = new Set(afterLines);
			afterFollowup
				.filter((l) => !afterSet.has(l))
				.map(statusLineToPath)
				.forEach((f) => changedFiles.push(f));
		} catch (err) {
			// 스크린샷 생성 실패는 치명적이지 않다 — 스크린샷 없이 그냥 진행한다.
			finalPreview = null;
		}
	}

	// 프리뷰 스크린샷이 있으면 docs/pr-screenshots/에 넣어서 실제 커밋 대상에 포함시킨다.
	let screenshotRepoPath = null;
	if (finalPreview && finalPreview.pngPath) {
		const dir = path.join(REPO_PATH, 'docs', 'pr-screenshots');
		fs.mkdirSync(dir, { recursive: true });
		const filename = `${branch.replace(/[^a-zA-Z0-9]/g, '-')}.png`;
		screenshotRepoPath = path.join('docs', 'pr-screenshots', filename);
		fs.copyFileSync(finalPreview.pngPath, path.join(REPO_PATH, screenshotRepoPath));
		fs.rmSync(finalPreview.pngPath, { force: true });
		changedFiles.push(screenshotRepoPath);
	}

	// git add -A / . 대신 감지된 파일을 명시적으로 add — 의도치 않은 파일 유입을 막는다.
	await run('git', ['add', '--', ...changedFiles]);
	await run('git', ['commit', '-m', `${originalRequest}\n\nRequested via Slack (peaktree-anvil bot)`]);

	const { stdout: shaOut } = await run('git', ['rev-parse', 'HEAD']);
	const commitSha = shaOut.trim();

	try {
		await run('git', ['push', '-u', 'origin', branch], { env: claudeEnv() });
	} catch (err) {
		// 세션/브랜치는 남겨둔다 — 다음 메시지("다시 push해줘" 등)로 복구를 시도할 수 있게.
		pendingTasks.set(channelId, { branch, sessionId, originalRequest, fastLane: isFastLane, updatedAt: Date.now() });
		return { status: 'error', reason: `push 실패:\n${(err.stderr || err.message || '').slice(-1000)}` };
	}

	// 브랜치명에 슬래시가 있어 raw URL에 넣으면 애매해질 수 있어(<prefix>/타임스탬프-슬러그),
	// 커밋 SHA로 고정한 raw.githubusercontent 링크를 쓴다.
	const screenshotMarkdown = screenshotRepoPath
		? `\n\n![변경된 디자인](https://raw.githubusercontent.com/${GITHUB_REPO}/${commitSha}/${screenshotRepoPath.replace(/\\/g, '/')})`
		: '';

	let prUrl;
	try {
		const { stdout: prOut } = await run('gh', [
			'pr',
			'create',
			'--title',
			originalRequest.slice(0, 72),
			'--body',
			`Slack에서 요청된 작업입니다.\n\n> ${originalRequest}\n\npeaktree-anvil 봇이 생성했습니다. 머지 전 리뷰가 필요합니다 (자동 머지 없음).${screenshotMarkdown}`,
			'--draft',
			'--head',
			branch,
			'--base',
			BASE_BRANCH,
		]);
		prUrl = prOut.trim();
	} catch (err) {
		pendingTasks.set(channelId, { branch, sessionId, originalRequest, fastLane: isFastLane, updatedAt: Date.now() });
		return { status: 'error', reason: `PR 생성 실패 (브랜치는 push됨: ${branch}):\n${(err.stderr || err.message || '').slice(-1000)}` };
	}

	// 작업이 PR로 마무리됐다 — 다음 메시지는 새 작업으로 취급한다.
	pendingTasks.delete(channelId);
	await run('git', ['checkout', BASE_BRANCH]);

	return { status: 'success', prUrl, summary: claudeResult.stdout.slice(-800), hasScreenshot: !!screenshotRepoPath };
}

// 같은 워킹 디렉터리를 공유하므로 동시에 두 작업이 겹치지 않도록 직렬화한다.
let queue = Promise.resolve();
function runTask(channelId, requestText) {
	const result = queue.then(
		() => runTaskInner(channelId, requestText),
		() => runTaskInner(channelId, requestText)
	);
	queue = result.catch(() => {});
	return result;
}

module.exports = { runTask };
