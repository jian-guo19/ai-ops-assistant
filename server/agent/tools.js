/**
 * 只读运维工具集（阶段 3）。
 *
 * 三条硬性红线，写死在实现里而不是靠提示词约束：
 *   1. 所有工具 readOnly=true，代码里不存在任何 exec / spawn / write 调用；
 *   2. 文件读取必须落在 allowedReadRoots 白名单内，做任何 .. 穿越都会被拒绝；
 *   3. 返回结果统一做长度截断，避免把大文件灌爆模型上下文（同时也是防上下文爆栈）。
 *
 * 工具执行出错时不抛给上层终止会话，而是把错误文本回灌给模型——
 * 真实 Agent 应当具备「读取失败 -> 自我纠正 -> 换个 source 再查」的能力。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { WRITE_TOOL_DEFINITIONS, WRITE_TOOL_IMPLS } from './write-tools.js';

const INVENTORY_PATH = path.join(config.paths.sandbox, 'inventory.json');
const LOGS_DIR = path.join(config.paths.sandbox, 'logs');

let cache = null;
function inventory() {
  if (cache) return cache;
  if (!fs.existsSync(INVENTORY_PATH)) {
    cache = { hosts: [], metrics: {}, services: {}, processes: {}, alerts: [] };
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  return cache;
}

export function invalidateInventoryCache() {
  cache = null;
}

/** 只读返回资产清单快照（供 API 层做下拉候选等） */
export function inventorySnapshot() {
  return inventory();
}

export class ToolError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
  }
}

/* ---------------------------- 参数校验工具 ---------------------------- */

function str(args, key, { required = false, enumValues = null, def = null } = {}) {
  const v = args?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`缺少必填参数 ${key}`);
    return def;
  }
  if (typeof v !== 'string') throw new ToolError(`参数 ${key} 必须是字符串`);
  if (!/^[\w.\-/:* ]{0,128}$/.test(v)) {
    throw new ToolError(`参数 ${key} 含非法字符（仅允许字母数字与 . - _ / : * 空格）`);
  }
  if (enumValues && !enumValues.includes(v)) {
    throw new ToolError(`参数 ${key} 取值必须是 [${enumValues.join(' | ')}] 之一，当前为 ${v}`);
  }
  return v;
}

function int(args, key, { def, min, max } = {}) {
  const v = args?.[key];
  const n = v === undefined || v === '' || v === null ? def : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`参数 ${key} 必须是数字`);
  const c = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, Math.trunc(n)));
  return c;
}

/** 路径白名单校验：拒绝任何形式的路径穿越 */
function assertInsideWhitelist(target) {
  const resolved = path.resolve(target);
  const ok = config.security.allowedReadRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) {
    throw new ToolError(
      '目标路径不在允许读取的白名单目录内',
      `允许的根目录：${config.security.allowedReadRoots.join('、')}`,
    );
  }
  return resolved;
}

function findHost(hostId) {
  const host = inventory().hosts.find((h) => h.id === hostId);
  if (!host) {
    throw new ToolError(`未找到主机 ${hostId}`, `可用主机：${inventory().hosts.map((h) => h.id).join('、')}`);
  }
  return host;
}

/** 列出某台主机可用的日志 source */
function availableSources(hostId) {
  if (!fs.existsSync(LOGS_DIR)) return [];
  return fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith(`${hostId}-`) && f.endsWith('.log'))
    .map((f) => f.slice(hostId.length + 1, -4));
}

/* ------------------------------ 工具定义 ------------------------------ */

const READ_ONLY_DEFINITIONS = [
  {
    name: 'list_hosts',
    readOnly: true,
    description: '列出受管主机清单（含角色、IP、环境、规格）。排查故障前先用它确认有哪些主机可用。',
    parameters: {
      type: 'object',
      properties: {
        env: { type: 'string', description: '按环境过滤：prod / staging / test' },
        role: { type: 'string', description: '按角色过滤：nginx-web / java-app / mysql / redis / gateway' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'query_metrics',
    readOnly: true,
    description:
      '查询主机监控指标的时序数据。可查指标因主机而异，例如 cpu/mem/disk/inode/io_wait/net_in/conn/slow_query/hit_rate/swap/gc_pause/upstream_timeout/http_5xx/evicted。不传 metric 时返回该机全部指标的最新值。',
    parameters: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: '主机 ID，如 web-01 / app-02 / db-03 / cache-04 / gw-05' },
        metric: { type: 'string', description: '指标名，如 disk / mem / io_wait / slow_query' },
        minutes: { type: 'integer', description: '返回最近多少个采样点（默认 30，上限 60）' },
      },
      required: ['host_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_alerts',
    readOnly: true,
    description: '获取当前未恢复的告警列表，可按主机与严重级别过滤。',
    parameters: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: '限定主机 ID' },
        severity: { type: 'string', description: 'critical / warning / info' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'query_logs',
    readOnly: true,
    description:
      '检索指定主机的日志文件。仅能读取沙箱目录内的只读样本；source 取错时会返回该机可用的 source 列表。',
    parameters: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: '主机 ID' },
        source: { type: 'string', description: '日志来源，如 nginx / syslog / app / mysql-slow / redis' },
        keyword: { type: 'string', description: '关键词过滤（大小写不敏感）' },
        lines: { type: 'integer', description: '最多返回多少行（默认 20，上限 200）' },
      },
      required: ['host_id', 'source'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_services',
    readOnly: true,
    description: '检查主机上关键服务的运行状态（等价于 systemctl status 的只读视图）。',
    parameters: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: '主机 ID' },
        name: { type: 'string', description: '只查询某个服务名' },
      },
      required: ['host_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'top_processes',
    readOnly: true,
    description: '查看主机进程资源占用 TOP N（等价于 ps + top 的只读视图）。',
    parameters: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: '主机 ID' },
        sort_by: { type: 'string', description: 'cpu / mem' },
        limit: { type: 'integer', description: '返回条数，默认 5，上限 20' },
      },
      required: ['host_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    readOnly: true,
    description:
      '受限读取沙箱内的文本文件内容（仅限 sandbox 与 samples 目录），用于查看配置片段或示例脚本。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 samples/risky-deploy.sh' },
        max_chars: { type: 'integer', description: '最多读取字符数，默认 4000，上限 20000' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_time',
    readOnly: true,
    description: '获取当前服务器时间，用于理解告警与日志的时间窗口。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

/* ------------------------------ 工具实现 ------------------------------ */

/**
 * 完整工具清单 = 只读工具 + 写入/执行工具。
 * 写入类工具都有 requiredPermission，调用前会做角色校验。
 */
export const TOOL_DEFINITIONS = [...READ_ONLY_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS];

const READ_IMPLS = {
  list_hosts(args) {
    const env = str(args, 'env', { enumValues: ['prod', 'staging', 'test'] });
    const role = str(args, 'role');
    let hosts = inventory().hosts;
    if (env) hosts = hosts.filter((h) => h.env === env);
    if (role) hosts = hosts.filter((h) => h.role.includes(role));
    return {
      total: hosts.length,
      hosts: hosts.map((h) => ({
        id: h.id, hostname: h.hostname, role: h.role, ip: h.ip,
        env: h.env, os: h.os, cpu_cores: h.cpu_cores, mem_gb: h.mem_gb,
      })),
    };
  },

  query_metrics(args) {
    const hostId = str(args, 'host_id', { required: true });
    findHost(hostId);
    const all = inventory().metrics[hostId];
    if (!all) throw new ToolError(`主机 ${hostId} 暂无指标数据`);
    const minutes = int(args, 'minutes', { def: 30, min: 1, max: 60 });
    const metric = str(args, 'metric');

    if (!metric) {
      const summary = Object.entries(all).map(([k, v]) => ({
        metric: k, latest: v.latest, unit: v.unit, avg60m: v.avg60m,
      }));
      return { host_id: hostId, window_minutes: minutes, metrics: summary };
    }
    const series = all[metric];
    if (!series) {
      throw new ToolError(
        `主机 ${hostId} 没有 ${metric} 指标`,
        `可用指标：${Object.keys(all).join('、')}`,
      );
    }
    const points = series.points.slice(-minutes).map((p) => ({ ts: p.ts, value: p.value }));
    const first = points[0]?.value ?? 0;
    const last = points[points.length - 1]?.value ?? 0;
    const trend = last > first * 1.15 ? 'rising' : last < first * 0.85 ? 'falling' : 'stable';
    return {
      host_id: hostId,
      metric,
      unit: series.unit,
      latest: series.latest,
      avg60m: series.avg60m,
      trend,
      change_ratio: first ? Number((((last - first) / first) * 100).toFixed(1)) : 0,
      window_minutes: points.length,
      points,
    };
  },

  get_alerts(args) {
    const hostId = str(args, 'host_id');
    const severity = str(args, 'severity', { enumValues: ['critical', 'warning', 'info'] });
    let alerts = inventory().alerts;
    if (hostId) alerts = alerts.filter((a) => a.host_id === hostId);
    if (severity) alerts = alerts.filter((a) => a.severity === severity);
    return {
      total: alerts.length,
      alerts: alerts.map((a) => ({
        id: a.id, host_id: a.host_id, severity: a.severity,
        name: a.name, started_at: a.started_at, summary: a.summary,
      })),
    };
  },

  query_logs(args) {
    const hostId = str(args, 'host_id', { required: true });
    const source = str(args, 'source', { required: true });
    findHost(hostId);
    const maxLines = config.security.maxLogLines;
    const linesLimit = int(args, 'lines', { def: 20, min: 1, max: maxLines });
    const keyword = str(args, 'keyword');

    const file = path.join(LOGS_DIR, `${hostId}-${source}.log`);
    if (!fs.existsSync(file)) {
      throw new ToolError(
        `未找到 ${hostId} 的 ${source} 日志`,
        `该机可用 source：${availableSources(hostId).join('、') || '无'}`,
      );
    }
    assertInsideWhitelist(file); // 兜底：即便拼接出越界路径也会被拦下

    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let hits = all.map((line, i) => ({ no: i + 1, text: line })).filter((l) => l.text.trim());
    const total = hits.length;
    if (keyword) {
      const kw = keyword.toLowerCase();
      hits = hits.filter((l) => l.text.toLowerCase().includes(kw));
    }
    const matched = hits.length;
    const tail = hits.slice(-linesLimit);
    return {
      host_id: hostId,
      source,
      file: path.relative(config.paths.root, file).replace(/\\/g, '/'),
      total_lines: total,
      matched,
      returned: tail.length,
      keyword: keyword || null,
      lines: tail,
    };
  },

  check_services(args) {
    const hostId = str(args, 'host_id', { required: true });
    findHost(hostId);
    const name = str(args, 'name');
    let services = inventory().services[hostId] || [];
    if (name) services = services.filter((s) => s.name === name);
    return {
      host_id: hostId,
      total: services.length,
      services: services.map((s) => ({
        name: s.name, state: s.state, since: s.since, pid: s.pid, enabled: s.enabled, note: s.note,
      })),
    };
  },

  top_processes(args) {
    const hostId = str(args, 'host_id', { required: true });
    findHost(hostId);
    const sortBy = str(args, 'sort_by', { enumValues: ['cpu', 'mem'], def: 'cpu' });
    const limit = int(args, 'limit', { def: 5, min: 1, max: 20 });
    let procs = [...(inventory().processes[hostId] || [])];
    procs.sort((a, b) => b[sortBy] - a[sortBy]);
    procs = procs.slice(0, limit);
    return { host_id: hostId, sort_by: sortBy, total: procs.length, processes: procs };
  },

  read_file(args) {
    const rel = str(args, 'path', { required: true });
    const maxChars = int(args, 'max_chars', { def: 4000, min: 100, max: 20000 });
    const target = path.resolve(config.paths.root, rel);
    assertInsideWhitelist(target);
    if (!fs.existsSync(target)) throw new ToolError(`文件不存在：${rel}`);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new ToolError(`路径不是文件：${rel}`);
    const content = fs.readFileSync(target, 'utf8').slice(0, maxChars);
    return {
      path: rel,
      size_bytes: stat.size,
      truncated: stat.size > maxChars,
      content,
    };
  },

  get_current_time() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN', { hour12: false }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unix_ms: now.getTime(),
    };
  },
};

/** 只读 + 写入工具实现的汇总表（只读取证工具优先，防止重名被覆盖） */
const IMPLS = { ...WRITE_TOOL_IMPLS, ...READ_IMPLS };

/** 工具执行器的统一 wrapper：计时、异常收敛、结果摘要 */
export async function runTool(name, rawArgs, ctx = {}) {
  const started = Date.now();
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def) {
    return { ok: false, name, error: `未注册的工具：${name}`, hint: `可用工具：${TOOL_DEFINITIONS.map((t) => t.name).join('、')}`, ms: 0 };
  }
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs || '{}');
    } catch {
      return { ok: false, name, error: `工具参数不是合法 JSON：${rawArgs.slice(0, 200)}`, ms: Date.now() - started };
    }
  }
  try {
    const result = await Promise.race([
      Promise.resolve(IMPLS[name](args || {}, ctx)),
      new Promise((_, reject) => setTimeout(() => reject(new ToolError('工具执行超时')), config.agent.toolTimeoutMs)),
    ]);
    return {
      ok: true,
      name,
      readOnly: def.readOnly === true,
      args,
      result,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      name,
      error: err instanceof ToolError ? err.message : `工具内部错误：${err.message}`,
      hint: err instanceof ToolError ? err.hint : null,
      ms: Date.now() - started,
    };
  }
}

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);
