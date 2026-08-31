require('dotenv').config();
const fs = require('fs');
const { App } = require('@slack/bolt');
const { runTask } = require('./lib/runTask');

async function uploadPreviewIfAny(client, channel, pngPath, title) {
	if (!pngPath) return;
	try {
		await client.files.uploadV2({
			channel_id: channel,
			file: fs.createReadStream(pngPath),
			filename: 'preview.png',
			title: title || '디자인 미리보기',
		});
	} catch (err) {
		console.error('[anvil] 프리뷰 업로드 실패', err);
	} finally {
		fs.rm(pngPath, { force: true }, () => {});
	}
}

const ALLOWED_USER = process.env.ALLOWED_SLACK_USER_ID;

if (!ALLOWED_USER) {
	console.error('ALLOWED_SLACK_USER_ID가 설정되지 않았습니다. .env를 확인하세요.');
	process.exit(1);
}
if (!process.env.REPO_PATH) {
	console.error('REPO_PATH가 설정되지 않았습니다. .env를 확인하세요.');
	process.exit(1);
}
if (!process.env.GITHUB_REPO) {
	console.error('GITHUB_REPO("owner/name")가 설정되지 않았습니다. .env를 확인하세요.');
	process.exit(1);
}
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
	console.error('SLACK_BOT_TOKEN / SLACK_APP_TOKEN이 설정되지 않았습니다. .env를 확인하세요.');
	process.exit(1);
}

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
});

app.event('message', async ({ event, client }) => {
	// DM만 처리. 채널 멘션 등은 다루지 않는다.
	if (event.channel_type !== 'im') return;
	// message_changed, message_deleted, bot_message 등 서브타입은 무시.
	if (event.subtype) return;
	if (event.bot_id) return;

	if (event.user !== ALLOWED_USER) {
		console.log(`[anvil] 허용되지 않은 사용자(${event.user})의 메시지 무시`);
		return;
	}

	const text = (event.text || '').trim();
	if (!text) return;

	await client.chat.postMessage({
		channel: event.channel,
		text: `🔨 작업 시작: "${text}"\n분석 중입니다... (완료까지 몇 분 걸릴 수 있어요)`,
	});

	try {
		const result = await runTask(event.channel, text);
		if (result.status === 'no-change') {
			await client.chat.postMessage({
				channel: event.channel,
				text: result.answer ? result.answer : `코드 변경 없이 끝났습니다. (판단 결과 수정이 필요 없었거나, claude가 변경을 만들지 않았어요)`,
			});
			await uploadPreviewIfAny(client, event.channel, result.previewPngPath, '디자인 미리보기 (제안 단계)');
		} else if (result.status === 'success') {
			await client.chat.postMessage({
				channel: event.channel,
				text: `✅ 완료 — Draft PR을 올렸습니다. 리뷰 후 직접 머지해주세요.${result.hasScreenshot ? ' (변경된 화면 스크린샷 포함)' : ''}\n${result.prUrl}`,
			});
		} else {
			await client.chat.postMessage({
				channel: event.channel,
				text: `❌ 실패\n${result.reason}`,
			});
		}
	} catch (err) {
		console.error('[anvil] unexpected error', err);
		await client.chat.postMessage({
			channel: event.channel,
			text: `❌ 예상치 못한 에러: ${err.message}`,
		});
	}
});

(async () => {
	await app.start();
	console.log('⚡️ peaktree-anvil bot running (Socket Mode)');
})();
