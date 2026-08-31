const { chromium } = require('playwright');
const path = require('path');

// PREVIEW_VIEWPORT="너비x높이" (예: "1280x800", "430x932"). 기본은 데스크톱.
const [vw, vh] = (process.env.PREVIEW_VIEWPORT || '1280x800')
	.split('x')
	.map((n) => parseInt(n, 10));
const VIEWPORT = {
	width: Number.isFinite(vw) ? vw : 1280,
	height: Number.isFinite(vh) ? vh : 800,
};

// .anvil-preview.html (claude가 만든 정적 디자인 목업)을 헤드리스 브라우저로 열어
// 스크린샷을 찍는다. 서버/DB 없이 파일을 그대로 연다 — 목업은 mock 데이터로 자족적이어야 한다.
async function screenshotHtmlFile(htmlPath, outputPngPath) {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: VIEWPORT });
		await page.goto(`file://${path.resolve(htmlPath)}`, { waitUntil: 'networkidle', timeout: 15000 });
		await page.screenshot({ path: outputPngPath, fullPage: true });
	} finally {
		await browser.close();
	}
}

module.exports = { screenshotHtmlFile };
