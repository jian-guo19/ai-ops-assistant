/**
 * 零依赖冒烟测试：node test/smoke.mjs
 *
 * 覆盖三大主线：
 *   阶段 1 故障分析   -> /api/chat mode=incident 的 SSE 事件流
 *   阶段 2 脚本校错   -> /api/script/lint 的本地规则 + /api/chat mode=script 的 AI 审查
 *   阶段 3 工具调用   -> /api/tools/invoke 的正常路径与安全护栏（路径穿越必须被拒绝）
 *
 * 测试自带服务启动与回收，跑完自动关闭子进程，端口固定 8788 以免与 dev 冲突。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSSEStream } from '../server/lib/sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || '8788';
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` -> ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 服务还没起来，继续重试 */
    }
    await sleep(300);
  }
  throw new Error('服务启动超时');
}

/** 读取一次 SSE 流，返回事件数组 */
async function collectSSE(res) {
  const events = [];
  let buffer = { type: null, data: '' };
  for await (const ev of parseSSEStream(res)) {
    events.push({ event: ev.event, data: ev.data });
    buffer.data += ev.data;
  }
  return events;
}

function parseEvents(rawEvents) {
  return rawEvents
    .map((e) => {
      try {
        return JSON.parse(e.data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT, HOST: '127.0.0.1', FORCE_MOCK: '1', LLM_MODE: 'auto', AUDIT_ENABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (t && !t.includes('ExperimentalWarning')) console.error('[server:err]', t);
  });
  await waitForHealth();
  return child;
}

async function main() {
  console.log('AI 运维故障分析与脚本助手 —— 冒烟测试');
  console.log(`目标：${BASE}`);
  const child = await startServer();

  try {
    /* ---------------- 基础可用性 ---------------- */
    section('基础可用性');
    const health = await (await fetch(`${BASE}/api/health`)).json();
    check('健康检查返回 ok', health.ok === true);
    check('运行在演示模式（无 Key）', health.llm.mode === 'mock', `实际 ${health.llm.mode}`);

    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    // 8 个只读取证工具 + 5 个写入/执行工具
    check('工具清单加载完整', cfg.tools.length === 13, `实际 ${cfg.tools.length}`);
    // 只读 = 8 个取证工具 + list_approvals（查询审批单同样是只读）
    check('只读工具数量为 9', cfg.tools.filter((t) => t.readOnly).length === 9, `实际 ${cfg.tools.filter((t) => t.readOnly).length}`);
    check('写入/执行类工具为 4 个', cfg.tools.filter((t) => !t.readOnly).length === 4);
    check(
      '写入类工具均声明所需权限',
      cfg.tools.filter((t) => !t.readOnly).every((t) => typeof t.requiredPermission === 'string'),
    );
    check('返回当前角色与权限', Boolean(cfg.auth?.role) && Array.isArray(cfg.auth?.permissions));
    check('返回脚本模板目录', Array.isArray(cfg.scriptTemplates) && cfg.scriptTemplates.length >= 5);
    check('内置演示场景可用', Array.isArray(cfg.scenarios) && cfg.scenarios.length === 5);

    /* ---------------- 阶段 3：只读工具与安全护栏 ---------------- */
    section('阶段 3 · 只读工具与安全护栏');
    const metricRes = await fetch(`${BASE}/api/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'query_metrics', args: { host_id: 'web-01', metric: 'disk', minutes: 10 } }),
    });
    const metric = await metricRes.json();
    check('query_metrics 调用成功', metric.ok === true, metric.error || '');
    check('query_metrics 返回时序点', metric.result?.points?.length === 10, `实际 ${metric.result?.points?.length}`);
    check('query_metrics 识别出磁盘高水位', Number(metric.result?.latest) > 90, `latest=${metric.result?.latest}`);

    const logsRes = await fetch(`${BASE}/api/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'query_logs', args: { host_id: 'web-01', source: 'nginx', keyword: 'space', lines: 5 } }),
    });
    const logs = await logsRes.json();
    check('query_logs 命中关键词', logs.ok === true && logs.result.matched > 0);

    const badSource = await (await fetch(`${BASE}/api/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'query_logs', args: { host_id: 'web-01', source: 'not-exist' } }),
    })).json();
    check('错误 source 被拒绝且给出可用列表', badSource.ok === false && String(badSource.hint).includes('nginx'));

    const traversal = await (await fetch(`${BASE}/api/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'read_file', args: { path: '../../../../Windows/win.ini' } }),
    })).json();
    check('路径穿越被白名单拦截', traversal.ok === false, JSON.stringify(traversal.result || {}));

    const unknown = await (await fetch(`${BASE}/api/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rm_rf', args: {} }),
    })).json();
    check('未注册工具被拒绝', unknown.ok === false);

    /* ---------------- 阶段 1：故障分析链路 ---------------- */
    section('阶段 1 · 故障分析（多轮工具取证）');
    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'web-01 磁盘写满了，Nginx 报 No space left on device，帮我分析原因。', mode: 'incident' }),
    });
    check('SSE 响应头正确', chatRes.headers.get('content-type')?.includes('text/event-stream') === true);
    const raw = await collectSSE(chatRes);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);
    check('收到 session 事件', types.includes('session'));
    check('收到流式文本 delta', types.includes('delta'));
    check('触发工具调用 tool_start', types.filter((t) => t === 'tool_start').length >= 2, `实际 ${types.filter((t) => t === 'tool_start').length}`);
    check('工具调用均返回 tool_result', types.filter((t) => t === 'tool_start').length === types.filter((t) => t === 'tool_result').length);
    check('收到结束事件 done', types.includes('done'));

    const toolNames = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
    check('取证工具与磁盘场景匹配', toolNames.includes('query_metrics') || toolNames.includes('query_logs'), toolNames.join(','));

    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    check('输出包含结论摘要', text.includes('结论摘要'));
    check('输出包含排查步骤', text.includes('排查步骤'));
    check('输出包含修复建议', text.includes('修复建议'));
    check('输出包含 df -h 之类的可执行命令', /df -h|df -i|du -xh/.test(text));

    const sessionId = events.find((e) => e.type === 'session')?.sessionId;
    check('返回了会话 ID', Boolean(sessionId));

    /* ---------------- 多轮会话状态 ---------------- */
    section('会话状态（多轮上下文）');
    const followRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '那 app-02 的服务为什么一直在重启？', mode: 'incident' }),
    });
    const followEvents = parseEvents(await collectSSE(followRes));
    const followTypes = followEvents.map((e) => e.type);
    check('第二轮复用同一会话', followEvents.find((e) => e.type === 'session')?.sessionId === sessionId);
    check('第二轮正常结束', followTypes.includes('done'));
    const followText = followEvents.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    check('第二轮切到 OOM 场景', followText.includes('OOM') || followText.includes('内存'), followText.slice(0, 80));

    /* ---------------- 阶段 2：脚本校错 ---------------- */
    section('阶段 2 · 脚本校错');
    const sample = await (await fetch(`${BASE}/api/samples/script`)).json();
    check('提供示例脚本', typeof sample.content === 'string' && sample.content.includes('rm -rf'));

    const lint = await (await fetch(`${BASE}/api/script/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: sample.content }),
    })).json();
    check('本地规则发现风险项', lint.issues.length >= 5, `实际 ${lint.issues.length}`);
    check('识别出 critical 级风险', (lint.stats.counts.critical || 0) >= 1);
    check('识别出 rm -rf 变量未加引号', lint.issues.some((i) => i.title.includes('rm -rf')));
    check('识别出 curl | bash', lint.issues.some((i) => i.title.includes('curl') || i.title.includes('远端脚本')));
    check('识别出明文口令', lint.issues.some((i) => i.title.includes('明文') || i.title.includes('密码')));
    check('补丁带 find/replace 便于定位', lint.issues.some((i) => i.patch?.type === 'replace' && typeof i.patch.find === 'string'));

    const safeScript = '#!/bin/bash\nset -euo pipefail\ntrap \'echo cleanup\' EXIT\necho "hello"\n';
    const safeLint = await (await fetch(`${BASE}/api/script/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: safeScript }),
    })).json();
    check('规范脚本不误报 critical/high', !safeLint.issues.some((i) => ['critical', 'high'].includes(i.severity)), JSON.stringify(safeLint.stats.counts));

    const reviewRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `请审查以下脚本：\n\`\`\`bash\n${sample.content}\n\`\`\``, mode: 'script' }),
    });
    const reviewEvents = parseEvents(await collectSSE(reviewRes));
    const reviewText = reviewEvents.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    check('AI 审查返回 JSON 块', reviewText.includes('```json'));
    const jsonMatch = reviewText.match(/```json\n([\s\S]*?)```/);
    if (jsonMatch) {
      let parsed = null;
      try {
        parsed = JSON.parse(jsonMatch[1]);
      } catch {
        parsed = null;
      }
      check('JSON 可被解析', parsed !== null);
      check('JSON 含 issues 数组', Array.isArray(parsed?.issues));
      check('JSON 含 overall_risk 字段', typeof parsed?.overall_risk === 'string');
    } else {
      check('AI 审查返回 JSON 块', false, '未匹配到 ```json 代码块');
    }

    /* ---------------- 阶段 4：脚本生成 ---------------- */
    section('阶段 4 · 脚本生成与审批执行');

    const gen = await (await fetch(`${BASE}/api/script/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: '清理 7 天前的过期日志', target_host: 'web-01', params: { days: 7 } }),
    })).json();

    check('脚本生成成功', gen.ok === true);
    check('命中日志清理模板', gen.template?.id === 'log-cleanup', gen.template?.id);
    check('生成脚本含安全骨架', String(gen.script || '').includes('set -euo pipefail'));
    check('生成脚本默认 dry-run', String(gen.script || '').includes('APPLY='));
    check('返回门禁评估', ['blocked', 'needs_approval', 'auto_allowed'].includes(gen.gate?.level));

    /* ---- 高危脚本必须被门禁拒绝入库 ---- */
    const dangerous = '#!/bin/bash\nset -euo pipefail\nrm -rf /data/*\n';

    // 门禁体检接口：结论必须与提交时的真实判定一致（曾因 UI 走错接口而误报"需审批"）
    const gateRes = await fetch(`${BASE}/api/script/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: dangerous }),
    });
    const gateJson = await gateRes.json();
    check('门禁体检接口可用', gateRes.status === 200 && gateJson.ok === true, `status=${gateRes.status}`);
    check('门禁体检判定与提交一致', gateJson.gate?.level === 'blocked', gateJson.gate?.level);
    check('门禁体检给出原因', (gateJson.gate?.reasons || []).length > 0);
    check('门禁体检附静态检查统计', gateJson.gate?.counts && gateJson.gate.lint?.stats);

    const badSubmit = await fetch(`${BASE}/api/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: dangerous, intent: '清理数据目录' }),
    });
    const badJson = await badSubmit.json().catch(() => ({}));
    check('高危脚本被门禁拒绝', badSubmit.status === 403 && badJson.code === 'GATE_BLOCKED', `status=${badSubmit.status} code=${badJson.code}`);
    check('拒绝时给出具体原因', Array.isArray(badJson.reasons) && badJson.reasons.length > 0);

    /* ---- 安全脚本可以入库 ---- */
    const cleanupScript = String(gen.script || '');
    const submitRes = await fetch(`${BASE}/api/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: cleanupScript, intent: '清理 7 天前日志', target_host: 'web-01' }),
    });
    const submitJson = await submitRes.json();
    check('安全脚本提交成功', submitJson.ok === true && submitJson.submitted === true, submitJson.error || '');

    const approvalId = submitJson.approval?.id;
    check('返回审批单 ID', Boolean(approvalId));
    check('审批单初始为 pending', submitJson.approval?.status === 'pending');

    /* ---- 未批准不得执行 ---- */
    const execBefore = await fetch(`${BASE}/api/approvals/${approvalId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('未批准的变更不可执行', execBefore.status === 403, `status=${execBefore.status}`);

    /* ---- 越权审批被拒 ---- */
    const viewerDecide = await fetch(`${BASE}/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-role': 'viewer' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const viewerJson = await viewerDecide.json().catch(() => ({}));
    check('越权审批被拒绝', viewerDecide.status === 403 && viewerJson.code === 'FORBIDDEN', `status=${viewerDecide.status}`);

    /* ---- 提交人不能自批 ---- */
    const selfApprove = await fetch(`${BASE}/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-role': 'approver', 'x-ops-actor': 'approver@demo' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const selfJson = await selfApprove.json().catch(() => ({}));
    check('提交人不能批准自己的变更', selfApprove.status === 403 && selfJson.code === 'FORBIDDEN', `status=${selfApprove.status}`);

    /* ---- 换成另一位审批人即可批准 ---- */
    const okDecide = await fetch(`${BASE}/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-role': 'approver', 'x-ops-actor': 'duty-lead' },
      body: JSON.stringify({ decision: 'approve', comment: '低峰执行，已确认回滚方案' }),
    });
    const okJson = await okDecide.json();
    check('审批人批准后状态变为 approved', okJson.ok === true && okJson.approval?.status === 'approved', okJson.error || '');

    /* ---- 执行已批准的变更 ---- */
    const execRes = await fetch(`${BASE}/api/approvals/${approvalId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-role': 'approver', 'x-ops-actor': 'duty-lead' },
      body: JSON.stringify({ mode: 'mock' }),
    });
    const execJson = await execRes.json();
    check('已批准的变更可执行', execRes.status === 200 && execJson.ok === true, execJson.error || '');
    check('执行结果含 stdout', typeof execJson.result?.stdout === 'string' && execJson.result.stdout.length > 0);
    check('执行结果标记为模拟执行', execJson.result?.simulated === true);
    check('审批单流转到 executed', execJson.approval?.status === 'executed');

    /* ---------------- 审计日志 ---------------- */
    section('审计留痕（阶段 5 地基）');
    const audit = await (await fetch(`${BASE}/api/audit?limit=200`)).json();
    check('审计产生工具调用记录', (audit.stats.byType.tool_call || 0) >= 3, JSON.stringify(audit.stats.byType));
    check('审计记录了用户提问', (audit.stats.byType.user_message || 0) >= 2);
    check('审计条目含会话 ID', audit.entries.some((e) => e.sessionId === sessionId));
    check('审计记录审批提交', (audit.stats.byType.approval_submit || 0) >= 1);
    check('审计记录审批决策', (audit.stats.byType.approval_decision || 0) >= 1);
    check('审计记录执行结果', (audit.stats.byType.exec_finished || 0) >= 1);

    /* ---------------- 参数与错误处理 ---------------- */
    section('参数校验与错误处理');
    const empty = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    check('空输入返回 400', empty.status === 400);

    const badMode = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', mode: 'hack' }),
    });
    check('非法 mode 返回 400', badMode.status === 400);

    const notFound = await fetch(`${BASE}/api/not-exist`);
    check('未知接口返回 404', notFound.status === 404);
  } finally {
    child.kill();
    await sleep(300);
  }

  console.log('\n========================================');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('  失败明细：');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('========================================\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exit(1);
});
