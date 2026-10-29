/**
 * 会话状态管理。
 *
 * 为什么自己管理历史而不是全部依赖 previous_response_id：
 *   - 可审计：每轮输入/输出都在自己手里，能落盘、能重放、能做敏感信息过滤；
 *   - 可移植：换成任意 OpenAI 兼容服务都不受影响；
 *   - 可控：能做历史裁剪（防止上下文越滚越大导致费用失控）。
 * 同时保留 responseId 字段，在 Responses API 协议下透传 previous_response_id，
 * 便于对比「服务端托管状态」与「客户端托管状态」两种模式的差异。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

/** @typedef {{id:string, tool_call_id?:string, name?:string, content:string, tool_calls?:Array}} Msg */

const sessions = new Map();
const TTL_MS = 1000 * 60 * 60 * 6; // 6 小时无活动后回收

function newId() {
  return crypto.randomBytes(9).toString('hex');
}

export function getSession(id) {
  if (!id) return createSession();
  const s = sessions.get(id);
  if (!s) return createSession(id);
  s.updatedAt = Date.now();
  return s;
}

export function createSession(id = null) {
  const sid = id || newId();
  const session = {
    id: sid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    responseId: null,
    stats: { turns: 0, toolCalls: 0, errors: 0 },
  };
  sessions.set(sid, session);
  return session;
}

export function resetSession(id) {
  sessions.delete(id);
  return createSession(id);
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    createdAt: new Date(s.createdAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
    turns: s.stats.turns,
    toolCalls: s.stats.toolCalls,
  }));
}

/**
 * 追加消息并做历史裁剪。
 * 裁剪策略：保留首条 system 提示（若存在）+ 最近 N 条消息，避免出现 tool 消息孤立
 * （tool 消息必须紧跟在它对应的 assistant tool_calls 之后，否则 API 会报错）。
 */
export function pushMessage(session, msg) {
  session.messages.push(msg);
  session.updatedAt = Date.now();
  trimHistory(session);
  return session;
}

function trimHistory(session) {
  const max = config.agent.maxHistoryMessages;
  if (session.messages.length <= max) return;

  const head = session.messages.filter((m) => m.role === 'system');
  let rest = session.messages.filter((m) => m.role !== 'system');

  // 从尾部保留，直到达到上限；若切断点落在 tool 消息上，往前挪到它所属的 assistant 之前
  let keep = rest.slice(-(max - head.length));
  while (keep.length && keep[0].role === 'tool') {
    keep = keep.slice(1);
  }
  session.messages = [...head, ...keep];
}

/** 回收过期会话（定时器由 index.js 启动） */
export function sweepExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > TTL_MS) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return { swept: removed, remaining: sessions.size };
}

/** 导出会话内容，供前端「导出本次分析」使用 */
export function exportSession(session) {
  return {
    id: session.id,
    createdAt: new Date(session.createdAt).toISOString(),
    stats: session.stats,
    messages: session.messages,
  };
}
