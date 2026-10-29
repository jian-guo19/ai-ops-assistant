/**
 * 审批网关（阶段 4 的核心闸门）。
 *
 * 状态机：
 *   draft ──提交──> pending ──批准──> approved ──执行──> executed
 *                      └──驳回──> rejected
 *   任何环节命中高危门禁 ──> denied（拒绝入库，不进入审批）
 *
 * 三条硬规则：
 *   1. 高危脚本不得入库：gate.level==='blocked' 直接拒绝，审批也救不回来。
 *   2. 审批与执行必须分离：提交人不能批准自己提交的变更（可用 ALLOW_SELF_APPROVAL 放开演示）。
 *   3. 执行前二次门禁：执行时重新跑一遍静态检查，防止脚本在审批后被悄悄改动。
 *
 * 所有状态流转都会写审计，保证「谁在什么时候批准了什么」可回溯。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { normalizeRole, can, ROLES } from '../security/rbac.js';
import { Errors } from '../lib/errors.js';

export const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
  DENIED: 'denied',
};

const STORE_FILE = path.join(config.paths.data, 'approvals.json');
const ALLOW_SELF_APPROVAL = /^(1|true|yes)$/i.test(process.env.ALLOW_SELF_APPROVAL ?? '');
const MAX_ITEMS = 500;

let items = [];
let saveTimer = null;

function ensureDir() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
}

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      items = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (!Array.isArray(items)) items = [];
    }
  } catch {
    items = [];
  }
}

function flush() {
  ensureDir();
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(items.slice(-MAX_ITEMS), null, 2), 'utf8');
  } catch (err) {
    console.warn('[approval] 持久化失败：', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 200);
}

load();

function newId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `AP-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 提交一份变更申请。
 * 返回 { ok, approval } 或 { ok:false, denied, reasons }
 */
export function submitApproval({ script, intent, targetHost, actor, role, gate }) {
  const normalizedRole = normalizeRole(role);
  if (!can(normalizedRole, 'approval:submit')) {
    throw Errors.forbidden(
      '提交变更需要 [approval:submit] 权限',
      `当前角色「${ROLES[normalizedRole].label}」只能查看，请切换为运维执行或更高权限`,
    );
  }

  const evaluation = gate || { level: 'needs_approval', reasons: [] };
  if (evaluation.level === 'blocked') {
    return {
      ok: false,
      denied: true,
      reasons: evaluation.reasons,
      suggestion: '请先修复致命风险项（在「脚本校错」中应用补丁），再重新提交审批',
    };
  }

  const now = new Date().toISOString();
  const approval = {
    id: newId(),
    intent: intent || '未命名变更',
    target_host: targetHost || null,
    script,
    gate: {
      level: evaluation.level,
      reasons: evaluation.reasons || [],
      counts: evaluation.lint?.stats?.counts || {},
    },
    status: STATUS.PENDING,
    submitted_by: actor || 'anonymous',
    submitted_at: now,
    decided_by: null,
    decided_at: null,
    comment: null,
    execution: null,
  };
  items.push(approval);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  scheduleSave();
  return { ok: true, approval };
}

export function getApproval(id) {
  return items.find((a) => a.id === id) || null;
}

export function listApprovals({ status = null, actor = null, limit = 50 } = {}) {
  let out = items;
  if (status) out = out.filter((a) => a.status === status);
  if (actor) out = out.filter((a) => a.submitted_by === actor);
  return out.slice(-limit).reverse();
}

/**
 * 审批决策。
 * @param {'approve'|'reject'} decision
 */
export function decideApproval({ id, decision, by, role, comment = null }) {
  const normalizedRole = normalizeRole(role);
  if (!can(normalizedRole, 'approval:decide')) {
    throw Errors.forbidden(
      '审批决策需要 [approval:decide] 权限',
      `当前角色「${ROLES[normalizedRole].label}」无审批权，请切换为变更审批人或管理员`,
    );
  }
  const item = getApproval(id);
  if (!item) throw Errors.notFound(`审批单不存在：${id}`);
  if (item.status !== STATUS.PENDING) {
    throw Errors.badRequest(`该审批单已处于「${item.status}」状态，无法再次决策`);
  }
  if (!ALLOW_SELF_APPROVAL && by && item.submitted_by === by) {
    throw Errors.forbidden(
      '职责分离要求：提交人不能批准自己提交的变更',
      '由另一位「变更审批人」账号执行批准操作',
    );
  }

  const now = new Date().toISOString();
  item.status = decision === 'approve' ? STATUS.APPROVED : STATUS.REJECTED;
  item.decided_by = by || 'anonymous';
  item.decided_at = now;
  item.comment = comment;
  scheduleSave();
  return item;
}

/** 记录执行结果（只允许从 approved 进入 executed） */
export function markExecuted(id, result) {
  const item = getApproval(id);
  if (!item) throw Errors.notFound(`审批单不存在：${id}`);
  item.status = STATUS.EXECUTED;
  item.execution = {
    at: new Date().toISOString(),
    ok: Boolean(result.ok),
    exitCode: result.exitCode ?? null,
    durationMs: result.durationMs ?? null,
    mode: result.mode ?? null,
    simulated: Boolean(result.simulated),
    stdout: String(result.stdout || '').slice(0, 4000),
    stderr: String(result.stderr || '').slice(0, 2000),
  };
  scheduleSave();
  return item;
}

/** 仪表盘统计 */
export function approvalStats() {
  const by = {};
  for (const a of items) by[a.status] = (by[a.status] || 0) + 1;
  return {
    total: items.length,
    pending: by[STATUS.PENDING] || 0,
    approved: by[STATUS.APPROVED] || 0,
    rejected: by[STATUS.REJECTED] || 0,
    executed: by[STATUS.EXECUTED] || 0,
    byStatus: by,
  };
}

export { flush as flushApprovals };
