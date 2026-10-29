/**
 * 写入 / 执行类工具（阶段 4）。
 *
 * 与 server/agent/tools.js 里的只读取证工具分开存放，便于一眼看出"哪些会动系统"。
 * 这里的每个工具都带 requiredPermission，由 Agent 循环在调用前做角色校验。
 *
 * 关键约束：
 *   - generate_script / submit_for_approval 只产出内容，绝不执行；
 *   - 执行入口只有 execute_approved，且它只认 approved 状态的审批单 ID，
 *     不接受任何形式的"脚本字符串"参数——从接口形状上杜绝绕过审批。
 */
import { gateScript, executeScript, EXEC_MODE } from './executor.js';
import { generateScript, TEMPLATES } from './scriptgen.js';
import {
  submitApproval, listApprovals, getApproval, decideApproval, markExecuted, STATUS,
} from './approval.js';
import { assertCan } from '../security/rbac.js';
import { Errors } from '../lib/errors.js';

/** 审批通过状态，执行前必须校验 */
const APPROVED = STATUS.APPROVED;

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: 'generate_script',
    readOnly: false,
    requiredPermission: 'script:generate',
    description:
      '根据意图生成一份带安全骨架的 Shell 脚本草稿（set -euo pipefail + trap + 默认 dry-run），并给出静态门禁评估。只生成不执行。',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '要做什么，例如「清理 7 天前的日志」「安全重启 nginx」' },
        target_host: { type: 'string', description: '目标主机 ID' },
        params: { type: 'string', description: 'JSON 字符串形式的参数，如 {"days":7}' },
      },
      required: ['intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_for_approval',
    readOnly: false,
    requiredPermission: 'approval:submit',
    description:
      '把脚本提交为变更申请，进入待审批队列。若脚本命中高危门禁会被直接拒绝入库，需先修复。提交后仍须由审批人批准才能执行。',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '脚本文本' },
        intent: { type: 'string', description: '变更意图简述' },
        target_host: { type: 'string', description: '目标主机 ID' },
      },
      required: ['script'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_approvals',
    readOnly: true,
    requiredPermission: 'audit:read',
    description: '列出变更审批单，可按状态过滤。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending / approved / rejected / executed / denied' },
        limit: { type: 'integer', description: '返回条数，默认 20' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'approve_change',
    readOnly: false,
    requiredPermission: 'approval:decide',
    description:
      '对处于 pending 状态的变更申请做出批准或驳回决策。提交人不能批准自己提交的变更。',
    parameters: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: '审批单 ID' },
        decision: { type: 'string', description: 'approve / reject' },
        comment: { type: 'string', description: '审批意见' },
      },
      required: ['approval_id', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_approved',
    readOnly: false,
    requiredPermission: 'exec:sandbox',
    description:
      '在隔离环境执行"已批准"的变更。执行前会重新跑一遍静态门禁；未经批准或门禁不通过一律拒绝。',
    parameters: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: '审批单 ID' },
        mode: { type: 'string', description: 'mock（默认，模拟执行） / docker（一次性容器） / local（受限解释器）' },
      },
      required: ['approval_id'],
      additionalProperties: false,
    },
  },
];

function parseParams(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export const WRITE_TOOL_IMPLS = {
  generate_script(args, ctx) {
    assertCan(ctx?.role, 'script:generate', '生成脚本');
    const intent = String(args.intent || '').slice(0, 200);
    const targetHost = args.target_host ? String(args.target_host) : null;
    const params = parseParams(args.params);

    const { script, template, gate } = generateScript({ intent, targetHost, params });
    return {
      generated: true,
      template: template.id,
      title: template.title,
      script,
      gate: {
        level: gate.level,
        reasons: gate.reasons,
        counts: gate.lint.stats.counts,
      },
      hint:
        gate.level === 'blocked'
          ? '脚本命中高危门禁，已拒绝提交审批，请先修复致命风险项。'
          : '接下来可调用 submit_for_approval 提交审批。',
    };
  },

  submit_for_approval(args, ctx) {
    assertCan(ctx?.role, 'approval:submit', '提交变更审批');
    const script = String(args.script || '');
    if (!script.trim()) throw Errors.badRequest('script 不能为空');

    const gate = gateScript(script);
    const result = submitApproval({
      script,
      intent: args.intent ? String(args.intent) : '未命名变更',
      targetHost: args.target_host ? String(args.target_host) : null,
      actor: ctx?.actor || 'anonymous',
      role: ctx?.role,
      gate,
    });

    if (!result.ok) {
      return {
        submitted: false,
        denied: true,
        reasons: result.reasons,
        suggestion: result.suggestion,
      };
    }
    return {
      submitted: true,
      approval_id: result.approval.id,
      status: result.approval.status,
      gate: result.approval.gate,
      hint: `已生成审批单 ${result.approval.id}，需由「变更审批人」批准后方可执行。`,
    };
  },

  list_approvals(args, ctx) {
    assertCan(ctx?.role, 'audit:read', '查看审批单');
    const limit = Math.min(100, Number(args.limit) || 20);
    const items = listApprovals({ status: args.status || null, limit });
    return { total: items.length, approvals: items };
  },

  approve_change(args, ctx) {
    assertCan(ctx?.role, 'approval:decide', '审批变更');
    const id = String(args.approval_id || '');
    const decision = String(args.decision || '') === 'approve' ? 'approve' : 'reject';
    const item = decideApproval({
      id,
      decision,
      by: ctx?.actor || 'anonymous',
      role: ctx?.role,
      comment: args.comment ? String(args.comment) : null,
    });
    return {
      approval_id: item.id,
      status: item.status,
      decided_by: item.decided_by,
      decided_at: item.decided_at,
      comment: item.comment,
      hint: item.status === STATUS.APPROVED
        ? '已批准，可调用 execute_approved 在隔离环境执行。'
        : '已驳回，该变更不会被执行。',
    };
  },

  /**
   * 唯一的执行入口。
   *
   * 参数里只有 approval_id，没有 script —— 这是刻意的接口设计：
   * 如果允许传脚本字符串，就意味着存在一条「不经审批直接执行」的路径，
   * 无论后面加多少道校验都可能被绕过。从参数形状上根除，比事后拦截可靠。
   */
  async execute_approved(args, ctx) {
    assertCan(ctx?.role, 'exec:sandbox', '在隔离环境执行');
    const id = String(args.approval_id || '');
    const item = getApproval(id);
    if (!item) throw Errors.notFound(`审批单不存在：${id}`);
    if (item.status !== APPROVED) {
      throw Errors.execDenied(
        `审批单当前状态为「${item.status}」，只有 approved 状态可执行`,
        '先由变更审批人执行批准操作',
      );
    }

    const result = await executeScript({
      script: item.script,
      mode: args.mode || EXEC_MODE,
      actor: ctx?.actor || 'anonymous',
      approvalId: id,
    });

    const updated = markExecuted(id, result);
    return {
      ok: result.ok,
      approval_id: id,
      approval: updated,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      mode: result.mode,
      simulated: result.simulated,
      denied: Boolean(result.denied),
      gate: result.gate,
    };
  },
};

export { TEMPLATES, STATUS };
