/**
 * 操作审计（阶段 5 的地基，这里提前落地）。
 *
 * 采用 append-only JSONL：每行一条独立 JSON，写入后不再修改。
 * 相比单条 SQL 表，它更适合做「最小可用审计」——不依赖数据库，
 * 但保留了时间、会话、工具、参数、结果状态等关键字段，
 * 后续要接 SIEM / 企业审计系统时只需加一个搬运进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let stats = { written: 0, failed: 0 };
let ensured = false;

function ensureDir() {
  if (ensured) return;
  fs.mkdirSync(path.dirname(config.paths.auditLog), { recursive: true });
  ensured = true;
}

/**
 * 记录一条审计事件。
 *
 * 这里刻意使用同步写入：审计的意义在于「调用返回即已留痕」，
 * 若改成异步 append，进程一旦崩溃，最关键的那几条记录反而最可能丢失。
 * 写入量很小（每次工具调用一行），同步 I/O 的开销可以接受；
 * 若日后写入频率变高，再改为独立进程消费的队列 + 告警。
 */
export function record(event) {
  if (!config.security.auditEnabled) return null;
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    pid: process.pid,
    ...event,
  };
  try {
    fs.appendFileSync(config.paths.auditLog, `${JSON.stringify(entry)}\n`, 'utf8');
    stats.written += 1;
  } catch (err) {
    stats.failed += 1;
    console.warn('[audit] 写入失败：', err.message);
  }
  return entry;
}

/** 审计写入统计（供健康检查与排障） */
export function auditWriteStats() {
  return { ...stats };
}

/** 读取最近 N 条审计记录（倒序，最新的在前） */
export function recentAudit(limit = 100, filter = {}) {
  const file = config.paths.auditLog;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let entries = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (filter.type) entries = entries.filter((e) => e.type === filter.type);
  if (filter.sessionId) entries = entries.filter((e) => e.sessionId === filter.sessionId);

  return entries.slice(-limit).reverse();
}

export function auditStats() {
  const file = config.paths.auditLog;
  if (!fs.existsSync(file)) return { total: 0, sizeBytes: 0, byType: {} };
  const stat = fs.statSync(file);
  const entries = recentAudit(10000);
  const byType = entries.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  return { total: entries.length, sizeBytes: stat.size, byType };
}
