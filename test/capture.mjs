/**
 * 界面截图：node test/capture.mjs
 * 需要先起服务（npm start），输出 docs/shots/*.png
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const EXE = process.env.CHROME_EXE
  || 'C:/Users/杜建国/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('saved', `${name}.png`);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#tool-list li');
await shot('01-incident');

/* ---------------- 阶段 1：故障分析 ---------------- */
await page.locator('#scenario-list button').first().click();
await page.locator('#btn-send').click();
await page.waitForSelector('.tool-card', { timeout: 15000 });
await page.waitForFunction(
  () => document.querySelector('#btn-send')?.disabled === false,
  null,
  { timeout: 60000 },
);
await sleep(400);
await shot('02-incident-result');

/* ---------------- 阶段 2：脚本校错 ---------------- */
await page.locator('.tab[data-view="script"]').click();
await page.locator('#btn-load-sample').click();
await page.waitForFunction(
  () => document.querySelector('#script-input')?.value?.includes('rm -rf'),
  null,
  { timeout: 10000 },
);
await page.locator('#btn-lint').click();
await page.waitForFunction(
  () => document.querySelectorAll('#issue-list .issue').length > 0,
  null,
  { timeout: 15000 },
);
await sleep(300);
await shot('03-review-lint');

await page.locator('#issue-list .issue button[data-apply]').first().click();
await page.waitForSelector('#diff-panel:not([hidden])', { timeout: 10000 });
await sleep(300);
await shot('04-review-diff');

/* ---------------- 阶段 3：工具沙箱 ---------------- */
await page.locator('.tab[data-view="inspector"]').click();
await page.locator('#ins-tool').selectOption('query_metrics');
await page.locator('#btn-invoke').click();
await page.waitForFunction(
  () => document.querySelector('#ins-result')?.textContent?.includes('latest'),
  null,
  { timeout: 15000 },
);
await sleep(300);
await shot('05-inspector');

/* ---------------- 阶段 4：自动化运维 ---------------- */
await page.locator('.tab[data-view="automation"]').click();
await page.waitForSelector('#auto-intent');

// 先演示「高危脚本被门禁拒绝」
await page.locator('#auto-script').fill(
  '#!/usr/bin/env bash\nrm -rf /data/app\n',
);
await page.locator('#btn-auto-lint').click();
await page.waitForFunction(
  () => (document.querySelector('#auto-gate')?.textContent || '').includes('门禁拒绝'),
  null,
  { timeout: 10000 },
);
await sleep(300);
await shot('06-gate-blocked');

// 生成正常草稿
await page.locator('#auto-intent').fill('清理 7 天前的过期日志');
await page.locator('#auto-host').fill('web-01');
await page.locator('#btn-auto-generate').click();
await page.waitForFunction(
  () => (document.querySelector('#auto-script')?.value || '').includes('set -euo'),
  null,
  { timeout: 15000 },
);
await sleep(400);
await shot('07-generated');

// 提交审批
await page.locator('#btn-auto-submit').click();
await page.waitForFunction(
  () => document.querySelectorAll('#approval-list li:not(.empty)').length > 0,
  null,
  { timeout: 15000 },
);
await sleep(500);
await shot('08-approval-pending');

// 自己不能批自己（截图展示禁用态）
await shot('09-self-approval-blocked');

// 换人 -> 批准
const actorInput = page.locator('#actor-input');
await actorInput.fill('release-manager@demo');
await actorInput.dispatchEvent('change');
await sleep(500);

const approveBtn = page.locator('#approval-list button[data-approve]:not([disabled])').first();
if (await approveBtn.count()) {
  await approveBtn.click();
  await sleep(800);
}
await shot('10-approved');

// 执行
const execBtn = page.locator('#approval-list button[data-exec]:not([disabled])').first();
if (await execBtn.count()) {
  await execBtn.click();
  await page.waitForSelector('#exec-panel:not([hidden])', { timeout: 15000 });
  await sleep(700);
}
await shot('11-executed');

/* ---------------- 阶段 5：权限与审计 ---------------- */
await actorInput.fill('intern@demo');
await actorInput.dispatchEvent('change');
await page.locator('#role-select').selectOption('viewer');
await page.locator('#role-select').dispatchEvent('change');
await sleep(500);
await shot('12-rbac-viewer');

await page.locator('#btn-audit').click();
await page.waitForSelector('#audit-drawer:not([hidden])', { timeout: 10000 });
await sleep(700);
await shot('13-audit');

await browser.close();
console.log('\nall shots ->', OUT);
