/**
 * 前端浏览器冒烟（开发期辅助脚本，不参与 npm test）。
 * 用无头 Chromium 打开页面，捕获控制台报错，并走一遍三大视图的关键交互。
 *
 * 用法：node test/browser-check.mjs
 * 依赖：npm i --no-save playwright-core
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = 'C:/Users/杜建国/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

const errors = [];
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

console.log('前端浏览器冒烟\n');

await page.goto(BASE, { waitUntil: 'networkidle' });

console.log('== 首屏加载 ==');
check('标题正确', (await page.title()).includes('AI 运维故障分析与脚本助手'));
check('模式徽章已渲染', !(await page.locator('#badge-mode').textContent()).includes('加载中'));
check('演示模式徽章出现', (await page.locator('#badge-mode').textContent()).includes('演示模式'));
check('场景列表已填充', (await page.locator('#scenario-list button').count()) === 5);
// 工具数量随阶段递增，改为与 /api/config 对齐，避免硬编码后失同步
const cfg = await (await fetch(`${BASE}/api/config`)).json();
const toolTotal = cfg.tools.length;
const writeToolNames = cfg.tools.filter((t) => !t.readOnly).map((t) => t.name);
check('工具清单已填充', (await page.locator('#tool-list li').count()) === toolTotal);
check('写操作工具未被误标为只读', writeToolNames.length > 0
  && (await page.locator('#tool-list li .twr').count()) === writeToolNames.length);

console.log('\n== 阶段 1：故障分析 ==');
await page.locator('#scenario-list button').first().click();
check('点击场景后输入框被填充', (await page.locator('#chat-input').inputValue()).includes('磁盘写满'));
await page.locator('#btn-send').click();
await page.waitForSelector('.tool-card', { timeout: 15000 });
const toolCount = await page.locator('.tool-card').count();
check('出现工具调用卡片', toolCount >= 2, `实际 ${toolCount}`);
await page.waitForFunction(() => document.querySelector('#btn-send')?.disabled === false, null, { timeout: 60000 });
const answerText = await page.locator('.msg-assistant .md').first().innerText();
check('回答包含结论摘要', answerText.includes('结论摘要'));
check('回答包含排查步骤', answerText.includes('排查步骤'));
check('回答渲染为 Markdown 结构', (await page.locator('.msg-assistant .md h2').count()) >= 3);
check('工具卡片显示成功状态', (await page.locator('.tool-card .badge-ok').count()) >= 1);
check('会话 ID 已显示', (await page.locator('#session-id').textContent()).length > 5);
check('工具调用计数已累加', Number(await page.locator('#session-toolcalls').textContent()) >= 2);

console.log('\n== 阶段 2：脚本校错 ==');
await page.locator('.tab[data-view="script"]').click();
await page.locator('#btn-load-sample').click();
await page.waitForFunction(() => document.querySelector('#script-input')?.value?.includes('rm -rf'), null, { timeout: 10000 });
check('示例脚本已载入', (await page.locator('#script-input').inputValue()).includes('rm -rf'));
await page.locator('#btn-lint').click();
await page.waitForFunction(() => document.querySelectorAll('#issue-list .issue').length > 0, null, { timeout: 15000 });
const issueCount = await page.locator('#issue-list .issue').count();
check('本地体检列出风险项', issueCount >= 5, `实际 ${issueCount}`);
check('风险摘要显示', (await page.locator('#lint-summary').innerText()).includes('critical'));

await page.locator('#issue-list .issue button[data-apply]').first().click();
await page.waitForSelector('#diff-panel:not([hidden])', { timeout: 10000 });
check('diff 面板出现', await page.locator('#diff-panel').isVisible());
check('diff 含新增行', (await page.locator('#diff-body .diff-add').count()) >= 1);
const before = await page.locator('#script-input').inputValue();
await page.locator('#btn-apply').click();
await sleep(1200);
const after = await page.locator('#script-input').inputValue();
check('确认后脚本被修改', before !== after);
check('修改内容包含加固代码', after.includes('set -euo pipefail') || after.includes('拒绝执行删除') || after.includes('mktemp'));

console.log('\n== 阶段 3：工具沙箱 ==');
await page.locator('.tab[data-view="inspector"]').click();
check('工具下拉已填充', (await page.locator('#ins-tool option').count()) === toolTotal);
check('下拉按读写分组', (await page.locator('#ins-tool optgroup').count()) === 2);
await page.locator('#ins-tool').selectOption('query_metrics');
await page.locator('#btn-invoke').click();
await page.waitForFunction(() => document.querySelector('#ins-result')?.textContent?.includes('latest'), null, { timeout: 15000 });
check('工具返回指标数据', (await page.locator('#ins-result').innerText()).includes('latest'));

await page.locator('#ins-tool').selectOption('read_file');
await page.locator('#ins-args').fill(JSON.stringify({ path: '../../../../Windows/win.ini' }));
await page.locator('#btn-invoke').click();
await page.waitForFunction(() => document.querySelector('#ins-result')?.textContent?.includes('白名单'), null, { timeout: 15000 });
check('路径穿越在 UI 层也被拒绝', (await page.locator('#ins-result').innerText()).includes('白名单'));

console.log('\n== 阶段 4：自动化运维（生成 → 审批 → 隔离执行）==');
await page.locator('.tab[data-view="automation"]').click();
check('自动化视图已打开', await page.locator('#view-automation').isVisible());

await page.locator('#auto-intent').fill('清理 7 天前的过期日志');
await page.locator('#auto-host').fill('web-01');
await page.locator('#btn-auto-generate').click();
await page.waitForFunction(() => document.querySelector('#auto-script')?.value?.length > 0, null, { timeout: 15000 });
check('草稿生成到编辑器', (await page.locator('#auto-script').inputValue()).includes('set -euo pipefail'));
check('展示门禁结论', (await page.locator('#auto-gate').innerText()).length > 0);

await page.locator('#btn-auto-submit').click();
await page.waitForFunction(() => document.querySelectorAll('#approval-list .approval').length > 0, null, { timeout: 15000 });
const apCount = await page.locator('#approval-list .approval').count();
check('审批单进入队列', apCount >= 1);
check('审批统计已渲染', (await page.locator('#approval-stats').innerText()).includes('待审批'));

// 队列里第一个卡片：初始应为 pending -> 可执行按钮应禁用
const firstExec = page.locator('#approval-list .approval button[data-exec]').first();
check('未批准时执行按钮禁用', await firstExec.isDisabled());

// 职责分离：提交人与审批人不能是同一人 —— 此时批准按钮应禁用
const approveBtn = page.locator('#approval-list .approval button[data-approve]').first();
check('自己提交的变更无法自批（按钮禁用）', await approveBtn.isDisabled());

// 切换为另一位审批人后即可批准
await page.locator('#actor-input').fill('duty-lead-2');
await page.locator('#actor-input').dispatchEvent('change');
await page.waitForTimeout(1200);
check('换人后批准按钮可用', (await approveBtn.isDisabled()) === false);

await approveBtn.click();
await page.waitForFunction(
  () => document.querySelector('#approval-list .approval')?.innerText?.includes('approved'),
  null,
  { timeout: 15000 },
);
check('批准后状态流转为 approved', true);

// 执行
await page.locator('#approval-list .approval button[data-exec]').first().click();
await page.waitForSelector('#exec-panel:not([hidden])', { timeout: 15000 });
check('展示执行结果面板', await page.locator('#exec-panel').isVisible());
const stdoutText = await page.locator('#exec-stdout').innerText();
check('执行结果含 stdout 内容', stdoutText.length > 0 && stdoutText !== '—');
check('标注为模拟执行', (await page.locator('#exec-meta').innerText()).includes('模拟执行'));

console.log('\n== 审计抽屉 ==');
await page.locator('#btn-audit').click();
await page.waitForFunction(() => document.querySelector('.audit-item') !== null, null, { timeout: 15000 });
check('审计条目渲染成功', (await page.locator('.audit-item').count()) >= 3);

console.log('\n== 阶段 5：权限控制（角色切换）==');
await page.locator('#role-select').selectOption('viewer');
await page.waitForTimeout(800);
const genDisabled = await page.locator('#btn-auto-generate').isDisabled();
check('观察员无生成脚本权限', genDisabled === true, `disabled=${genDisabled}`);
await page.locator('#role-select').selectOption('approver');
await page.waitForTimeout(800);
check('切回审批人后按钮恢复', (await page.locator('#btn-auto-generate').isDisabled()) === false);

await page.screenshot({ path: path.join(__dirname, '..', 'data', 'ui-screenshot.png'), fullPage: false });

console.log('\n== 控制台错误 ==');
check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

console.log(`\n========================================`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
if (errors.length) {
  console.log('  控制台错误明细：');
  errors.slice(0, 8).forEach((e) => console.log(`   - ${e}`));
}
console.log('========================================\n');
process.exit(failed === 0 ? 0 : 1);
