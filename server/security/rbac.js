/**
 * 角色权限模型（阶段 5）。
 *
 * 现实对应：
 *   viewer   一线/新人：能看分析、能用只读工具查数据，但不能发起变更
 *   operator 运维执行：能生成脚本并提交审批，但不能自己批准自己执行
 *   approver 变更审批人（值班负责人）：能批准/驳回
 *   admin    管理员：含审批与执行权限（演示环境保留，生产建议拆分）
 *
 * 演示项目用请求头 `x-ops-role` 传入角色；生产环境必须换成
 * 真实身份体系（SSO / OIDC / 堡垒机）下发的身份，绝不能信任客户端自称的角色。
 */

import { Errors } from '../lib/errors.js';

export const PERMISSIONS = [
  'chat:read',      // 使用对话分析
  'tool:invoke',    // 调用只读取证工具
  'script:lint',    // 脚本本地体检
  'script:generate',// 生成脚本草稿
  'approval:submit',// 提交审批
  'approval:decide',// 审批决策
  'exec:sandbox',   // 在隔离环境执行
  'audit:read',     // 查看审计
];

// 审计日志本身是只读的，所以作为基础权限下发给所有角色；
// 能否「发起变更」和「批准变更」才是需要逐级收紧的部分。
const VIEWER = ['chat:read', 'tool:invoke', 'script:lint', 'audit:read'];
const OPERATOR = [...VIEWER, 'script:generate', 'approval:submit'];
const APPROVER = [...OPERATOR, 'approval:decide', 'exec:sandbox'];

export const ROLES = {
  viewer: { label: '观察员', desc: '可查看分析与调用只读工具，不能发起变更', permissions: VIEWER },
  operator: { label: '运维执行', desc: '可生成脚本并提交审批', permissions: OPERATOR },
  approver: { label: '变更审批人', desc: '可批准或驳回变更，并在隔离环境执行', permissions: APPROVER },
  admin: { label: '管理员', desc: '全部权限（演示用，生产建议再拆细）', permissions: [...APPROVER] },
};

export const DEFAULT_ROLE = process.env.DEFAULT_ROLE || 'approver';

/** 角色是否合法（未知角色一律降级为 viewer，遵循最小权限） */
export function normalizeRole(role) {
  const r = String(role || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(ROLES, r) ? r : 'viewer';
}

export function can(role, permission) {
  const r = normalizeRole(role);
  return ROLES[r].permissions.includes(permission);
}

/**
 * 权限断言：不满足时抛 403 AppError 并带上角色说明。
 * 每个受保护接口的入口都应该调用它，而不是依赖前端隐藏按钮——
 * 前端隐藏只是体验，服务端校验才是安全。
 */
export function assertCan(role, permission, action = '该操作') {
  if (!can(role, permission)) {
    const r = normalizeRole(role);
    throw Errors.forbidden(
      `${action}需要 [${permission}] 权限，当前角色「${ROLES[r].label}」不具备`,
      '切换到「变更审批人」或「管理员」角色后再试',
    );
  }
  return true;
}

/** 便于前端渲染角色选择器的元数据 */
export function roleCatalog() {
  return Object.entries(ROLES).map(([id, v]) => ({
    id,
    label: v.label,
    desc: v.desc,
    permissions: v.permissions,
  }));
}

export function permissionsOf(role) {
  return ROLES[normalizeRole(role)].permissions;
}
