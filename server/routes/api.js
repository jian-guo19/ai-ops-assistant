/**
 * HTTP API 层。
 *
 * 全部对话走 SSE（Server-Sent Events）而非 WebSocket：
 *   - Agent 场景天然是「服务端单向持续推送」，不需要客户端反向上行流；
 *   - SSE 基于 HTTP，天然穿透代理、支持断线重连，排障也更容易（curl 就能看）。
 */
import { Router } from 'express';
import { config, publicRuntimeInfo, resolveMode } from '../config.js';
import { runAgent, AbortedError } from '../agent/loop.js';
import { getSession, createSession, resetSession, listSessions, exportSession } from '../agent/session.js';
import { TOOL_DEFINITIONS, runTool, inventorySnapshot } from '../agent/tools.js';
import { record, recentAudit, auditStats } from '../audit.js';
import { lintShell } from '../lib/shell-lint.js';
// 只导入实现：工具定义已由 tools.js 汇总进 TOOL_DEFINITIONS，此处不重复引入
import { WRITE_TOOL_IMPLS } from '../agent/write-tools.js';
import { gateScript, executeScript, EXEC_MODE } from '../agent/executor.js';
import { generateScript, templateCatalog } from '../agent/scriptgen.js';
import {
  submitApproval, listApprovals, getApproval, decideApproval, markExecuted,
  approvalStats, STATUS as APPROVAL_STATUS,
} from '../agent/approval.js';
import { normalizeRole, can, ROLES, roleCatalog } from '../security/rbac.js';
import { Errors, normalizeError } from '../lib/errors.js';

const router = Router();

/**
 * 从请求头解析操作人身份。
 *
 * 演示项目允许客户端自称身份，但生产环境严禁这样做：
 * 必须由网关/SSO 注入可信身份头，或者直接换成服务端 session。
 */
function actorOf(req) {
  const role = normalizeRole(req.get('x-ops-role') || process.env.DEFAULT_ROLE || 'approver');
  const actor = (req.get('x-ops-actor') || '').trim() || `${role}@demo`;
  return { actor, role };
}

/** 权限守卫：不满足时抛 403（会被下面的错误中间件转成统一 JSON） */
function requirePermission(req, permission, action = '该操作') {
  const { actor, role } = actorOf(req);
  if (!can(role, permission)) {
    throw Errors.forbidden(
      `${action}需要 [${permission}] 权限，当前角色「${ROLES[role].label}」不具备`,
      '在右上角切换为更高权限角色后重试',
    );
  }
  return { actor, role };
}

/**
 * Express 4 不会自动捕获 async 路由里抛出的异常，
 * 一旦 async handler reject，就变成未处理的 Promise 拒绝。
 * 统一包一层，把错误交给错误中间件。
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const MODES = ['incident', 'script', 'agent'];
const MAX_INPUT = 20000;

/** 内置演示场景：点击即可把典型故障原文填进输入框 */
const SCENARIOS = [
  {
    id: 'disk', title: '磁盘写满', mode: 'incident', host: 'web-01',
    prompt: 'web-01 磁盘写满了，Nginx 一直报 No space left on device，帮我分析原因并给排查步骤。',
  },
  {
    id: 'oom', title: 'Java 服务 OOM', mode: 'incident', host: 'app-02',
    prompt: 'app-02 上的 Java 服务反复重启，日志里说是 Out of memory，近 1 小时重启了 5 次，怎么排查？',
  },
  {
    id: 'slowsql', title: '慢查询暴涨', mode: 'incident', host: 'db-03',
    prompt: 'db-03 的慢查询突然涨到 148 条/分钟，业务下单接口变慢，分析一下可能原因。',
  },
  {
    id: 'redis', title: 'Redis 连不上', mode: 'incident', host: 'cache-04',
    prompt: 'cache-04 的 Redis 连不上，应用报 Connection refused，缓存命中率也从 98% 掉到 71%。',
  },
  {
    id: 'gateway', title: '网关大量 502', mode: 'incident', host: 'gw-05',
    prompt: 'gw-05 网关出现大量 502 和 upstream timed out，帮我判断是网关的问题还是上游的问题。',
  },
];

/* ----------------------------- SSE 辅助 ----------------------------- */

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 关闭 Nginx 反向代理缓冲，否则会被攒着一起返回
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n'); // 注释行：立刻建立连接，避免客户端超时
}

function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/* ------------------------------ 路由 ------------------------------ */

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'ai-ops-assistant',
    version: '0.3.0',
    llm: publicRuntimeInfo(),
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

router.get('/config', (req, res) => {
  const { actor, role } = actorOf(req);
  res.json({
    runtime: publicRuntimeInfo(),
    auth: {
      actor,
      role,
      roleLabel: ROLES[role].label,
      permissions: ROLES[role].permissions,
      catalog: roleCatalog(),
    },
    exec: { mode: EXEC_MODE },
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      requiredPermission: t.requiredPermission || null,
      parameters: t.parameters,
    })),
    scenarios: SCENARIOS,
    scriptTemplates: templateCatalog(),
    hostCatalog: (inventorySnapshot().hosts || []).map((h) => ({
      id: h.id, hostname: h.hostname, role: h.role, ip: h.ip, env: h.env, os: h.os,
    })),
    limits: {
      maxInput: MAX_INPUT,
      maxTurns: config.agent.maxTurns,
      maxLogLines: config.security.maxLogLines,
    },
  });
});

/**
 * 核心对话接口（SSE 流式）。
 * body: { sessionId?, message, mode?, useTools? }
 */
router.post('/chat', asyncHandler(async (req, res) => {
  const { sessionId, message, mode = 'incident', useTools = true } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    throw Errors.badRequest('message 不能为空');
  }
  if (message.length > MAX_INPUT) {
    throw Errors.payloadTooLarge(`输入过长，上限 ${MAX_INPUT} 字符`);
  }
  if (!MODES.includes(mode)) {
    throw Errors.badRequest(`mode 必须是 ${MODES.join(' | ')} 之一`);
  }

  // 权限闸门：对话分析也需要 chat:read
  const { actor, role } = requirePermission(req, 'chat:read', '发起对话分析');

  const session = sessionId ? getSession(sessionId) : createSession();
  openSSE(res);
  // 每个 SSE payload 都带 type 字段（与 SSE event name 保持一致），
  // 前端统一 switch(data.type) 即可，不必同时处理 event name 与 payload 两套结构。
  sendSSE(res, 'session', { type: 'session', sessionId: session.id, mode, llmMode: resolveMode() });
  sendSSE(res, 'status', { type: 'status', phase: 'start', sessionId: session.id });

  // 客户端断开时中止后端推理，避免白白烧 token。
  // 注意必须监听 res 的 close：Node 16+ 里 req 的 'close' 会在请求体读完时
  // 就触发一次，若用 req 会把正常请求误判为断开，推理被立即取消。
  const controller = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    controller.abort();
  });

  const emit = (event) => {
    if (clientClosed || res.writableEnded) return;
    sendSSE(res, event.type, event);
  };

  try {
    await runAgent({
      session,
      input: message,
      mode,
      useTools: useTools && mode !== 'script',
      emit,
      signal: controller.signal,
      actor,
      role,
    });
  } catch (err) {
    if (!(err instanceof AbortedError)) {
      emit({ type: 'error', code: 'AGENT_ERROR', message: err.message });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}));

/**
 * 脚本本地静态体检（不走模型，毫秒级返回）。
 * 与 /chat?mode=script 的 AI 审查形成互补：本地规则抓确定性风险，AI 补语义层。
 */
router.post('/script/lint', (req, res) => {
  requirePermission(req, 'script:lint', '脚本体检');
  const script = req.body?.script;
  if (typeof script !== 'string' || !script.trim()) {
    throw Errors.badRequest('script 不能为空');
  }
  if (script.length > MAX_INPUT) {
    throw Errors.payloadTooLarge(`脚本过长，上限 ${MAX_INPUT} 字符`);
  }
  const result = lintShell(script);
  record({ type: 'local_lint', issues: result.issues.length, severities: result.stats.counts });
  res.json({ ok: true, ...result });
});

/**
 * 阶段四静态门禁：与提交审批时使用的是同一个 gateScript()，
 * UI 先跑一遍，用户就能在提交前知道会不会被拒，而不是提交后才吃 403。
 */
router.post('/script/gate', (req, res) => {
  requirePermission(req, 'script:lint', '静态门禁体检');
  const script = req.body?.script;
  if (typeof script !== 'string' || !script.trim()) {
    throw Errors.badRequest('script 不能为空');
  }
  if (script.length > MAX_INPUT) {
    throw Errors.payloadTooLarge(`脚本过长，上限 ${MAX_INPUT} 字符`);
  }
  const gate = gateScript(script);
  record({ type: 'gate_check', level: gate.level, reasons: gate.reasons });
  res.json({ ok: true, gate, ...gate.lint });
});

/** 读取示例脚本 */
router.get('/samples/script', (req, res) => {
  res.json({ name: 'risky-deploy.sh', content: SAMPLE_SCRIPT });
});

/** 工具直连测试：便于在 UI 里单独验证某个只读工具是否正常工作 */
router.post('/tools/invoke', asyncHandler(async (req, res) => {
  const { name, args } = req.body || {};
  if (!name) throw Errors.badRequest('缺少工具名称');

  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (def?.requiredPermission) {
    // 借用权限守卫，保证手动调用与 Agent 调用走同一套规则
    requirePermission(req, def.requiredPermission, `调用工具 ${name}`);
  }
  const { actor, role } = actorOf(req);
  const result = await runTool(name, args || {}, { source: 'http', actor, role });
  record({
    type: 'tool_call_manual', tool: name, args, ok: result.ok, ms: result.ms, actor, role,
  });
  res.json(result);
}));

router.get('/tools', (req, res) => {
  res.json({ total: TOOL_DEFINITIONS.length, tools: TOOL_DEFINITIONS });
});

/* --------------------------- 会话与审计 --------------------------- */

router.get('/sessions', (req, res) => {
  res.json({ total: listSessions().length, sessions: listSessions() });
});

router.post('/sessions', (req, res) => {
  const s = createSession();
  res.json({ sessionId: s.id });
});

router.delete('/sessions/:id', (req, res) => {
  const existed = Boolean(listSessions().find((s) => s.id === req.params.id));
  resetSession(req.params.id);
  res.json({ ok: true, existed });
});

router.get('/sessions/:id/export', (req, res) => {
  const s = getSession(req.params.id);
  res.json(exportSession(s));
});

router.get('/audit', (req, res) => {
  requirePermission(req, 'audit:read', '查看审计日志');
  const limit = Math.min(500, Number.parseInt(req.query.limit ?? '100', 10) || 100);
  res.json({
    stats: auditStats(),
    entries: recentAudit(limit, { type: req.query.type, sessionId: req.query.sessionId }),
  });
});

/**
 * 审计导出（阶段 5）：返回完整 JSON 供存档或接 SIEM。
 * 生产环境建议改为按日期滚动的文件 + 独立的搬运进程。
 */
router.get('/audit/export', (req, res) => {
  const { actor, role } = requirePermission(req, 'audit:read', '导出审计日志');
  const entries = recentAudit(10000, { type: req.query.type, sessionId: req.query.sessionId });
  record({ type: 'audit_export', actor, role, count: entries.length });
  res.setHeader('Content-Disposition', 'attachment; filename="audit-export.json"');
  res.json({ exportedAt: new Date().toISOString(), stats: auditStats(), entries });
});

/* ================== 阶段 4：脚本生成与审批执行 ================== */

/**
 * 生成脚本草稿（不执行）。
 * body: { intent, target_host?, params? }
 */
router.post('/script/generate', (req, res) => {
  const { actor, role } = requirePermission(req, 'script:generate', '生成脚本');
  const { intent, target_host: targetHost = null, params = {} } = req.body || {};
  if (typeof intent !== 'string' || !intent.trim()) {
    throw Errors.badRequest('intent 不能为空');
  }

  const result = generateScript({ intent, targetHost, params });
  record({
    type: 'script_generate',
    actor,
    role,
    template: result.template.id,
    gate: result.gate.level,
  });
  res.json({ ok: true, ...result });
});

/** 审批单列表 */
router.get('/approvals', (req, res) => {
  requirePermission(req, 'audit:read', '查看审批单');
  const limit = Math.min(100, Number.parseInt(req.query.limit ?? '50', 10) || 50);
  res.json({ stats: approvalStats(), approvals: listApprovals({ status: req.query.status || null, limit }) });
});

/**
 * 提交变更审批。
 * body: { script, intent?, target_host? }
 */
router.post('/approvals', (req, res) => {
  const { actor, role } = requirePermission(req, 'approval:submit', '提交变更审批');
  const { script, intent = '', target_host: targetHost = null } = req.body || {};
  if (typeof script !== 'string' || !script.trim()) {
    throw Errors.badRequest('script 不能为空');
  }
  if (script.length > MAX_INPUT) {
    throw Errors.payloadTooLarge(`脚本过长，上限 ${MAX_INPUT} 字符`);
  }

  const gate = gateScript(script);
  const result = submitApproval({
    script,
    intent: intent || '未命名变更',
    targetHost,
    actor,
    role,
    gate,
  });

  if (!result.ok) {
    record({ type: 'approval_denied', actor, role, reasons: result.reasons });
    return res.status(403).json({
      error: '脚本未通过静态门禁，已拒绝入库',
      code: 'GATE_BLOCKED',
      reasons: result.reasons,
      suggestion: result.suggestion,
    });
  }

  record({ type: 'approval_submit', actor, role, approvalId: result.approval.id });
  res.json({ ok: true, submitted: true, approval: result.approval });
});

/**
 * 审批决策。
 * body: { decision: 'approve'|'reject', comment? }
 */
router.post('/approvals/:id/decision', (req, res) => {
  const { actor, role } = requirePermission(req, 'approval:decide', '审批变更');
  const { decision, comment = null } = req.body || {};
  if (decision !== 'approve' && decision !== 'reject') {
    throw Errors.badRequest('decision 必须是 approve 或 reject');
  }
  const item = decideApproval({
    id: req.params.id,
    decision,
    by: actor,
    role,
    comment: comment ? String(comment) : null,
  });
  record({
    type: 'approval_decision',
    actor,
    role,
    approvalId: item.id,
    decision,
    comment: item.comment,
  });
  res.json({ ok: true, approval: item });
});

/**
 * 执行已批准的变更。
 * body: { mode?: 'mock'|'docker'|'local' }
 */
router.post('/approvals/:id/execute', asyncHandler(async (req, res) => {
  const { actor, role } = requirePermission(req, 'exec:sandbox', '执行变更');
  const id = req.params.id;
  const item = getApproval(id);
  if (!item) throw Errors.notFound(`审批单不存在：${id}`);

  // 统一走工具的唯一执行实现：审批状态校验与二次门禁都在那里，避免两处逻辑漂移
  const result = await WRITE_TOOL_IMPLS.execute_approved(
    { approval_id: id, mode: req.body?.mode },
    { actor, role },
  );
  record({
    type: 'exec_finished',
    actor,
    role,
    approvalId: id,
    ok: result.ok,
    exitCode: result.exitCode,
    mode: result.mode,
    durationMs: result.durationMs,
  });
  res.json({ ok: result.ok, approval: result.approval, result });
}));


const SAMPLE_SCRIPT = `#!/bin/bash
# 这是一个"故意写得很危险"的示例脚本，用于演示脚本校错能力。
APP_DIR=/opt/order-svc
TARGET=$1

cd $APP_DIR/source

echo "开始部署，目标目录: $TARGET"
rm -rf $TARGET/*
cp -r ./release/* $TARGET/

DB_PASS='P@ssw0rd123'
mysql -uroot -p$DB_PASS -h 10.0.1.21 order_db < ./sql/migrate.sql || true

systemctl restart order-svc
sleep 3

curl -sSL https://ops-internal.example.com/bootstrap.sh | bash

ps aux | grep java | grep -v grep | awk '{print $2}' | xargs kill -9

echo "root:$DB_PASS" | chpasswd

if [ $? -eq 0 ]; then
    echo "deploy ok" >> /var/log/deploy.log
fi
`;

/**
 * 统一错误处理中间件（阶段 5）。
 * 放在所有路由之后，把 AppError 转成带 code/hint/retryable 的结构化响应，
 * 其余未知异常一律不回传内部堆栈。
 */
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const appErr = normalizeError(err);
  if (res.headersSent) return next(appErr);
  const status = appErr.httpStatus >= 400 && appErr.httpStatus < 600 ? appErr.httpStatus : 500;
  console.error(`[api error] ${req.method} ${req.path} ${status} ${appErr.code}: ${appErr.message}`);
  res.status(status).json({
    error: appErr.message,
    code: appErr.code,
    retryable: appErr.retryable,
    hint: appErr.hint,
  });
});

export default router;
