/**
 * 阶段 4 端到端流程调试：生成 -> 提交 -> 越权拦截 -> 批准 -> 执行
 * 用法：node test/dbg-flow.mjs（会自行拉起服务）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = '8792';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT, HOST: '127.0.0.1', FORCE_MOCK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => {
  const t = d.toString().trim();
  if (t) console.error('[srv]', t);
});

for (let i = 0; i < 40; i += 1) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) break;
  } catch { /* retry */ }
  await sleep(300);
}

const call = async (method, path, body, role = 'approver', actor = 'duty-lead@demo') => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-ops-role': role, 'x-ops-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text: text.slice(0, 400) };
};

console.log('== 1) 生成草稿 ==');
const gen = await call('POST', '/api/script/generate', {
  intent: '清理 7 天前的过期日志', target_host: 'web-01',
});
console.log(gen.status, gen.json?.template?.id, gen.json?.gate?.level);

console.log('\n== 2) 提交审批（提交人 approver@demo）==');
const sub = await call('POST', '/api/approvals', {
  script: gen.json.script, intent: '清理日志', target_host: 'web-01',
}, 'approver', 'approver@demo');
console.log(sub.status, JSON.stringify(sub.json).slice(0, 200));
const id = sub.json?.approval?.id;
console.log('审批单 ID =', id);

console.log('\n== 3) 观察员尝试批准（应 403）==');
const denied = await call('POST', `/api/approvals/${id}/decision`, { decision: 'approve' }, 'viewer', 'watcher@demo');
console.log(denied.status, JSON.stringify(denied.json).slice(0, 200));

console.log('\n== 4) 审批人批准（应 200 -> approved）==');
const ok = await call('POST', `/api/approvals/${id}/decision`, { decision: 'approve', comment: '低峰执行' }, 'approver', 'duty-lead@demo');
console.log(ok.status, JSON.stringify(ok.json).slice(0, 250));

console.log('\n== 5) 执行已批准变更 ==');
const exec = await call('POST', `/api/approvals/${id}/execute`, { mode: 'mock' }, 'approver', 'duty-lead@demo');
console.log(exec.status, JSON.stringify(exec.json).slice(0, 400));

child.kill();
process.exit(0);
