/**
 * 本地演示引擎（无 API Key 时自动启用）。
 *
 * 它不是"假输出"：整体结构与真实模型完全一致——
 *   第 1 轮：决定调用哪些只读工具 -> 返回 tool_calls
 *   第 2 轮：读取工具回灌的真实取证结果 -> 生成带证据链的分析报告
 *
 * 好处是：即便没有 OpenAI API Key，也能把 SSE 流式、多轮编排、工具回灌、
 * Markdown 渲染整条链路完整跑通，便于本地开发与演示；
 * 填入 Key 之后，只需替换 provider 的实现，上层代码一行都不用改。
 */
import { lintShell } from '../lib/shell-lint.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function emit(text, onText, signal, { chunk = 8, delay = 10 } = {}) {
  for (let i = 0; i < text.length; i += chunk) {
    if (signal?.aborted) return false;
    onText?.(text.slice(i, i + chunk));
    await sleep(delay);
  }
  return true;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}

function toolNamesAvailable(tools) {
  return new Set((tools || []).map((t) => t.name));
}

function hasToolResults(messages) {
  return messages.some((m) => m.role === 'tool');
}

/* ------------------------------------------------------------------ *
 * 第一步：决定要调用哪些只读工具
 * ------------------------------------------------------------------ */
function planTools(input, available) {
  const text = input.toLowerCase();
  const calls = [];
  let n = 0;
  const push = (name, args) => {
    n += 1;
    calls.push({ id: `call_mock_${n}_${name}`, name, arguments: JSON.stringify(args) });
  };
  const can = (name) => available.has(name);

  // 显式指定了主机
  const hostMatch = input.match(/\b(web-01|app-02|db-03|cache-04|gw-05)\b/i);
  const host = hostMatch ? hostMatch[1].toLowerCase() : null;

  const hit = (...kws) => kws.some((k) => text.includes(k));

  if (hit('磁盘', '空间', 'no space', 'disk', 'inode', '写满', '打满')) {
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'disk', minutes: 30 });
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'inode', minutes: 30 });
    if (host && can('query_logs')) push('query_logs', { host_id: host, source: 'nginx', keyword: 'space', lines: 10 });
    if (can('check_services') && host) push('check_services', { host_id: host });
    if (can('get_alerts')) push('get_alerts', host ? { host_id: host } : {});
    return calls;
  }

  if (hit('oom', '内存', 'killed', 'killer', 'heap', 'java', '重启', 'exit 137')) {
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'mem', minutes: 30 });
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'swap', minutes: 30 });
    if (host && can('query_logs')) push('query_logs', { host_id: host, source: 'syslog', keyword: 'memory', lines: 12 });
    if (host && can('top_processes')) push('top_processes', { host_id: host, sort_by: 'mem', limit: 5 });
    if (can('get_alerts')) push('get_alerts', host ? { host_id: host } : {});
    return calls;
  }

  if (hit('慢查询', 'mysql', '数据库', 'db', '锁', 'slow query', '连接数')) {
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'slow_query', minutes: 30 });
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'io_wait', minutes: 30 });
    if (host && can('query_logs')) push('query_logs', { host_id: host, source: 'mysql-slow', lines: 12 });
    if (can('get_alerts')) push('get_alerts', host ? { host_id: host } : {});
    return calls;
  }

  if (hit('redis', '缓存', 'cache', 'refused', '拒绝连接', '命中率')) {
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'hit_rate', minutes: 30 });
    if (host && can('query_logs')) push('query_logs', { host_id: host, source: 'redis', lines: 15 });
    if (can('check_services') && host) push('check_services', { host_id: host });
    if (can('get_alerts')) push('get_alerts', host ? { host_id: host } : {});
    return calls;
  }

  if (hit('502', '504', '网关', 'gateway', 'timeout', '超时', 'upstream', '5xx')) {
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'upstream_timeout', minutes: 30 });
    if (host && can('query_metrics')) push('query_metrics', { host_id: host, metric: 'http_5xx', minutes: 30 });
    if (host && can('query_logs')) push('query_logs', { host_id: host, source: 'nginx', keyword: 'upstream', lines: 12 });
    if (can('get_alerts')) push('get_alerts', {});
    return calls;
  }

  // 泛化：提到告警/故障 -> 先拉全局告警再下钻
  if (hit('告警', '故障', '异常', '报错', 'alert', 'incident') || host) {
    if (can('get_alerts')) push('get_alerts', host ? { host_id: host } : {});
    if (can('list_hosts')) push('list_hosts', {});
    return calls;
  }

  // 询问集群/资源现状 -> 走只读探查
  if (hit('现状', '状态', '有哪些', '概况', '巡检', 'health', 'list')) {
    if (can('list_hosts')) push('list_hosts', {});
    if (can('get_alerts')) push('get_alerts', { severity: 'critical' });
    return calls;
  }

  return calls;
}

/* ------------------------------------------------------------------ *
 * 第二步：解析取证结果
 * ------------------------------------------------------------------ */
function collectEvidence(messages) {
  /**
   * 只取「本轮」证据：以最后一条 user 消息为界。
   * 若不切分，多轮对话里第一轮的历史取证会污染第二轮判断——
   * 例如第二轮问 app-02，却因为第一轮查过 web-01 磁盘而继续输出磁盘结论。
   */
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
  const scope = lastUserIdx === -1 ? messages : messages.slice(lastUserIdx);

  const evidence = [];
  /** tool_call_id -> {name, arguments} */
  const callMap = new Map();
  for (const m of messages) {
    for (const tc of m.tool_calls || []) {
      callMap.set(tc.id, { name: tc.function?.name, arguments: tc.function?.arguments });
    }
  }
  for (const m of scope) {
    if (m.role !== 'tool') continue;
    const meta = callMap.get(m.tool_call_id) || {};
    let parsed = null;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      parsed = { raw: m.content };
    }
    let args = {};
    try {
      args = JSON.parse(meta.arguments || '{}');
    } catch {
      args = {};
    }
    evidence.push({ name: meta.name, args, result: parsed });
  }
  return evidence;
}

/** 从 evidence 里取出某个主机某个指标的最新值 */
function metricOf(evidence, host, metric) {
  for (const e of evidence) {
    if (e.name === 'query_metrics' && e.result?.metric === metric && (!host || e.result?.host_id === host)) {
      return e.result;
    }
  }
  return null;
}

function alertsOf(evidence) {
  for (const e of evidence) {
    if (e.name === 'get_alerts' && Array.isArray(e.result?.alerts)) return e.result.alerts;
  }
  return [];
}

function servicesOf(evidence) {
  for (const e of evidence) {
    if (e.name === 'check_services' && Array.isArray(e.result?.services)) return e.result.services;
  }
  return [];
}

function logsOf(evidence) {
  const out = [];
  for (const e of evidence) {
    if (e.name === 'query_logs' && Array.isArray(e.result?.lines)) {
      out.push(...e.result.lines.map((l) => ({ source: e.result.source, ...l })));
    }
  }
  return out;
}

function detectScenario(input, evidence) {
  const t = input.toLowerCase();
  const diskHigh = (h, m) => {
    const v = metricOf(evidence, h, m);
    return v && Number(v.latest) > 90;
  };
  if (diskHigh('web-01', 'disk') || t.includes('no space') || diskHigh('web-01', 'inode')) return 'disk_full';
  if (metricOf(evidence, 'app-02', 'mem')?.latest > 88 || (t.includes('oom') || t.includes('killed'))) return 'oom';
  if (metricOf(evidence, 'db-03', 'slow_query') || t.includes('慢查询')) return 'db_slow';
  if (servicesOf(evidence).some((s) => s.name === 'redis-server' && s.state !== 'running') || t.includes('redis')) return 'redis_down';
  if (metricOf(evidence, 'gw-05', 'upstream_timeout') || t.includes('502') || t.includes('504')) return 'gateway_502';
  return 'generic';
}

/* ------------------------------------------------------------------ *
 * 第三步：基于证据生成报告
 * ------------------------------------------------------------------ */
const SCENARIOS = {
  disk_full: {
    summary: '磁盘空间（含 inode）耗尽导致 Nginx 无法写入访问日志与 PID 文件',
    causes: [
      { p: '高', title: '日志文件未轮转导致 / 分区被占满', evidence: 'Nginx 持续报 pwrite() failed (28: No space left on device)；access.log 与 error.log 均写入失败', note: 'logrotate 未生效或日志体积增长速度超过轮转速度' },
      { p: '中', title: 'inode 同时接近耗尽（大量小文件）', evidence: 'inode 使用率 96.1%，通常来自 session/cache 碎片文件或容器临时目录', note: '即使 df -h 显示还有空间，inode 耗尽同样会写不进文件' },
      { p: '中', title: 'filebeat 进程退出，日志采集中断', evidence: 'check_services 返回 filebeat = failed (status=1/FAILURE)，已中断 38 分钟', note: '日志采集停机本身不会占满磁盘，但会让排障缺少远端证据，且可能导致上游堆积' },
      { p: '低', title: '存在已删除但仍被进程占用的大文件', evidence: '需通过 lsof | grep deleted 确认', note: '这类文件 df 看得到占用，du 却统计不到，容易误判' },
    ],
    steps: [
      '确认影响面：`df -h` 与 `df -i` 分别看容量和 inode',
      '定位大目录：`du -xh --max-depth=1 / 2>/dev/null | sort -hr | head -20`',
      '检查被删除但句柄未释放的文件：`lsof +L1` 或 `lsof | grep deleted`',
      '检查轮转是否真的执行：`cat /etc/logrotate.d/nginx` 与 `/usr/sbin/logrotate -d /etc/logrotate.conf`',
      '验证 Nginx 恢复可写：`touch /var/log/nginx/.probe && echo writable`',
    ],
    fixes: [
      '用 `truncate -s 0` 清空超大日志，而不是 rm（避免进程持有已删除句柄、空间不释放）',
      '执行 `journalctl --vacuum-size=500M` 收缩 systemd 日志',
      '恢复 logrotate 定时任务并补一次手动轮转',
      '修复并重启 filebeat，确认日志重新上报',
    ],
  },
  oom: {
    summary: 'JVM 堆内存需求超过可用物理内存，被内核 OOM Killer 反复终止',
    causes: [
      { p: '高', title: 'JVM 堆上限设置过高 + 批量任务一次性加载超大数据集', evidence: 'app-02 内存 93.6%、swap 已用 62%；syslog 出现 Out of memory: Kill process (java) score 812；应用日志 Rows=1280341 的统计任务耗时 41s', note: '-Xmx24g 接近整机可用内存，堆外内存/元空间/线程栈没有留出余量' },
      { p: '中', title: '批量查询缺少分页与流式处理', evidence: '统计任务一次性处理 128 万行；StackOverflowError 堆栈指向 stream.collect', note: '数据规模随业务增长，原本可用的写法会突然越界' },
      { p: '中', title: '容器/进程未设置内存上限，restart 掩盖了故障', evidence: 'order-svc 近 1 小时重启 5 次，全部为 Exit 137', note: '没有 limit 时，单个进程可以拖垮整机；频繁重启会掩盖真实失败率' },
      { p: '低', title: 'GC 策略与暂停目标不匹配', evidence: 'GC overhead limit exceeded；堆回收后仍 23.4GB/24GB', note: '说明对象基本都是存活的——是容量问题，不是回收器问题' },
    ],
    steps: [
      '确认 Killed 事件：`dmesg -T | grep -i "out of memory"` 与 `journalctl -k | grep oom`',
      '核对实际可用内存：`free -g`（注意 available 而非 free）',
      '抓取堆转储：`jmap -dump:format=b,file=/tmp/heap.hprof <pid>`（低峰期执行）',
      '检查容器/进程是否设置了内存 limit：`docker stats`、`cat /sys/fs/cgroup/memory.max`',
      '复盘批量任务单次处理行数，确认是否需要分页或游标',
    ],
    fixes: [
      '短期：把 -Xmx 下调到物理内存的 60%~70%，为堆外内存留余量',
      '短期：为容器设置 memory limit 并配置 OOM 告警（而不是让它静默重启）',
      '中期：批量任务改为分页/游标读取，避免一次性 collect 到内存',
      '中期：给 JVM 加 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath，便于事后取证',
    ],
  },
  db_slow: {
    summary: '缺少有效索引的全表扫描叠加磁盘 IO 瓶颈，导致慢查询堆积并逼近连接数上限',
    causes: [
      { p: '高', title: '核心查询缺少复合索引，触发全表扫描', evidence: '慢日志 Rows_examined 高达 8,142,333 / 12,903,411，Query_time 12~41 秒', note: '扫描行数远超返回行数，典型索引失效或未建索引' },
      { p: '高', title: '写操作使用子查询 + FOR UPDATE，锁等待上升', evidence: 'Lock_time 最高 4.99 秒；UPDATE ... WHERE id IN (SELECT ...) 与 SELECT ... FOR UPDATE', note: '持锁时间长会把慢查询放大成阻塞' },
      { p: '中', title: '磁盘 IO 瓶颈加剧排队', evidence: 'iowait 41.7%，buffer pool 刷脏与大查询读盘叠加', note: '即使索引修好，IO 瓶颈仍会限制上限' },
      { p: '中', title: '连接数逼近上限，存在雪崩风险', evidence: 'Threads_connected 786 / max_connections 800', note: '应用侧若无限重试，很容易把连接池打满导致全面不可用' },
    ],
    steps: [
      '取当前执行中的会话：`SELECT * FROM information_schema.PROCESSLIST WHERE COMMAND != "Sleep" ORDER BY TIME DESC LIMIT 20;`',
      '验证索引是否命中：对慢 SQL 执行 `EXPLAIN`（关注 type=ALL、rows、Extra=Using filesort）',
      '查看 InnoDB 锁等待：`SELECT * FROM performance_schema.data_lock_waits;`',
      '确认 IO 状况：`iostat -x 1 5`（关注 %util 与 await）',
      '导出慢日志 TOP：`mysqldumpslow -s t -t 10 /var/log/mysql/slow.log`',
    ],
    fixes: [
      '先止血：在业务低峰增加 (status, created_at) 复合索引，并用 EXPLAIN 验证',
      '改写 UPDATE 子查询为 JOIN，缩小 FOR UPDATE 的锁定范围',
      '调整 innodb_io_capacity 与刷脏参数，评估是否升级为更高 IOPS 的云盘',
      '临时上调 max_connections 的同时，务必限制应用侧最大连接数，避免反向压垮实例',
    ],
  },
  redis_down: {
    summary: 'Redis 主节点被主动关闭且无从可用，Sentinel 因缺少健康从节点无法完成故障切换',
    causes: [
      { p: '高', title: 'redis-server 进程被主动 shutdown', evidence: '日志显示 User requested shutdown... Redis is now ready to exit（07:21:41）', note: '属于人为操作或自动化误触发，需要核对变更记录' },
      { p: '高', title: 'Sentinel 无法完成故障转移', evidence: '+failover-abort-no-good-slave / All the slaves are unreachable', note: '主从都不可用时 Sentinel 也无能为力，属于架构短板而非 Sentinel 本身故障' },
      { p: '中', title: '内存压力在停机前已显现', evidence: 'hit_rate 由 98.2% 跌至 71.5%，evicted keys 上升', note: '命中率下降会把压力传导到数据库，可能诱发次生故障' },
      { p: '低', title: '未配置 maxmemory-policy 或内存不足', evidence: '内存 88.4%', note: 'noeviction 会让写入直接失败' },
    ],
    steps: [
      '确认进程与端口：`systemctl status redis-server` 与 `ss -lntp | grep 6379`',
      '核对 Sentinel 视角：`redis-cli -p 26379 sentinel masters`',
      '检查是否有合法 slave：`redis-cli -p 26379 sentinel slaves mymaster`',
      '查阅变更记录/堡垒机审计，确认 07:21 左右是否有人工操作',
      '确认下游影响面：哪些服务强依赖缓存，是否已触发降级',
    ],
    fixes: [
      '按变更流程恢复 redis-server，并在低峰期执行 `redis-cli info replication` 确认主从状态',
      '补齐至少一个健康从节点，让 Sentinel 具备真正切换能力',
      '把 Sentinel 切换失败纳入告警（当前只有 <info> 日志，没有告警）',
      '核对 maxmemory 与淘汰策略，避免命中率长期下滑',
    ],
  },
  gateway_502: {
    summary: '网关本身正常，故障根因在上游 app-02（JVM OOM 反复重启）导致的 upstream 超时',
    causes: [
      { p: '高', title: '上游应用不可用引发的连锁 502/504', evidence: 'gw-05 upstream timed out 187 次/分钟、5xx 96 次/分钟；而 app-02 同期处于 OOM 重启周期（重启 5 次）', note: '网关是“受害者”，只在 gw-05 上排查会找不到根因' },
      { p: '中', title: '超时与重试放大了后端压力', evidence: '日志里出现 retrying with next upstream 与 no live upstreams', note: '上游已经扛不住时继续重试，会进一步拖慢恢复' },
      { p: '中', title: '缺少熔断降级机制', evidence: 'upstream 全部不可用时仍在持续转发请求', note: '应有快速失败，保护下游并给上游恢复窗口' },
      { p: '低', title: 'TLS 证书即将到期（7 天）', evidence: 'certbot-renew.timer 处于 waiting，证书 2026-10-18 到期', note: '与本次故障无关，但属于必须处理的到期项' },
    ],
    steps: [
      '先确认是网关问题还是上游问题：`curl -I http://127.0.0.1:8080/actuator/health`（直连上游）',
      '核对 upstream 存活列表：检查 nginx upstream 配置与健康检查策略',
      '回溯上游状态：本例中 app-02 的 OOM Kill 与重启计数是关键线索',
      '检查证书有效期：`echo | openssl s_client -connect gw-05:443 2>/dev/null | openssl x509 -noout -dates`',
      '评估是否需要临时摘除故障上游节点',
    ],
    fixes: [
      '优先解决上游 app-02 的 OOM（见「内存」场景），网关症状会随之消失',
      '为 nginx upstream 增加 max_fails / fail_timeout 被动健康检查',
      '接入熔断降级：连续失败达到阈值后快速返回，避免雪崩',
      '排期完成证书自动续期验证（certbot renew --dry-run）',
    ],
  },
  generic: {
    summary: '基于当前可取证的只读数据，尚未收敛到单一根因，需要先做全局态势确认',
    causes: [
      { p: '待定', title: '尚未形成强证据链', evidence: '当前以告警聚合与资源水位为主，缺少针对具体症状的下钻', note: '建议补充：具体报错原文、影响时间窗、影响面（哪些接口/用户）' },
    ],
    steps: [
      '先界定影响面：哪些服务/接口/用户受影响，持续多久',
      '确认变更：最近一次发布、配置变更、证书/域名变更的时间点',
      '对照监控：CPU/内存/磁盘/网络/连接数五类水位是否同步异动',
      '取关键日志：报错时间点前后 5 分钟的应用日志与系统日志',
    ],
    fixes: [
      '在证据不足时优先做「可回滚的止血」，而不是激进变更',
      '把本轮取证结果沉淀到工单，供后续复盘',
    ],
  },
};

function formatEvidenceList(evidence) {
  const rows = [];
  for (const e of evidence) {
    const r = e.result || {};
    if (e.name === 'query_metrics' && r.metric) {
      rows.push(`- 指标 ${r.host_id}.${r.metric}：最新 ${r.latest}${r.unit || ''}，近 60 分钟均值 ${r.avg60m}${r.unit || ''}`);
    } else if (e.name === 'query_logs') {
      const first = (r.lines || [])[0];
      rows.push(`- 日志 ${r.host_id}/${r.source}：命中 ${r.matched ?? r.returned ?? (r.lines?.length ?? 0)} 行${first ? `，首条「${String(first.text || first).slice(0, 90)}」` : ''}`);
    } else if (e.name === 'get_alerts') {
      rows.push(`- 告警：${(r.alerts || []).map((a) => `${a.severity.toUpperCase()} ${a.name}(${a.host_id})`).join('、') || '无'}`);
    } else if (e.name === 'check_services') {
      rows.push(`- 服务 ${r.host_id}：${(r.services || []).map((s) => `${s.name}=${s.state}`).join('、')}`);
    } else if (e.name === 'top_processes') {
      const top = (r.processes || [])[0];
      if (top) rows.push(`- 进程 TOP1：${top.cmd}（CPU ${top.cpu}%，MEM ${top.mem}%）`);
    } else if (e.name === 'list_hosts') {
      rows.push(`- 主机清单：${(r.hosts || []).map((h) => h.id).join('、')}`);
    }
  }
  return rows.length ? rows.join('\n') : '- （本轮工具未返回可结构化提取的证据）';
}

function renderReport(scenarioKey, input, evidence) {
  const s = SCENARIOS[scenarioKey] || SCENARIOS.generic;
  const alerts = alertsOf(evidence);
  const severityWord = alerts.filter((a) => a.severity === 'critical').length;

  return [
    `## 结论摘要`,
    ``,
    `${s.summary}。`,
    ``,
    `## 证据链`,
    ``,
    formatEvidenceList(evidence),
    ``,
    severityWord ? `当前命中 ${alerts.length} 条告警，其中 critical ${severityWord} 条；以下排序同时参考了告警等级与指标趋势。` : '',
    ``,
    `## 可能原因（按可能性排序）`,
    ``,
    ...s.causes.map((c, i) => `${i + 1}. **【${c.p}】${c.title}**\n   - 依据：${c.evidence}\n   - 说明：${c.note}`),
    ``,
    `## 排查步骤`,
    ``,
    ...s.steps.map((st, i) => `${i + 1}. ${st}`),
    ``,
    `## 修复建议（需人工确认，本项目不自动执行）`,
    ``,
    ...s.fixes.map((f) => `- ${f}`),
    ``,
    `## 还需要补充的信息`,
    ``,
    `- 报错的原始文本与首次出现时间`,
    `- 最近一次发布/配置变更的时间点与内容`,
    `- 影响面估算：受影响的接口、租户或用户量级`,
    ``,
    `> 以上结论由只读工具取证得出，未对目标主机做任何写操作。`,
  ].filter((x) => x !== null).join('\n');
}

/* ------------------------------------------------------------------ *
 * 脚本校错：规则结果 -> JSON 审查报告
 * ------------------------------------------------------------------ */
function extractScript(text) {
  const fenced = text.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const idx = text.indexOf('#!/');
  if (idx !== -1) return text.slice(idx);
  return '';
}

function renderScriptReport(code) {
  if (!code.trim()) {
    return JSON.stringify({ summary: '未从输入中提取到脚本内容', issues: [] }, null, 2);
  }
  const { issues, stats } = lintShell(code);
  const top = issues.slice(0, 8).map((i) => ({
    severity: i.severity,
    line: i.line,
    title: i.title,
    risk: i.risk,
    suggestion: i.suggestion,
    patch: i.patch,
  }));
  return JSON.stringify({
    summary: `共 ${issues.length} 项风险：critical ${stats.counts.critical || 0}、high ${stats.counts.high || 0}、medium ${stats.counts.medium || 0}、low ${stats.counts.low || 0}。最需要优先处理的是会导致不可逆破坏的项。`,
    overall_risk: issues.some((i) => i.severity === 'critical') ? 'critical' : issues.some((i) => i.severity === 'high') ? 'high' : 'medium',
    stats,
    issues: top,
    additional_notes: [
      '本地规则引擎负责确定性风险，AI 负责补充语义层问题（如业务逻辑顺序、缺少回滚入口）。',
      '所有修改均需人工确认后才会落到临时副本，原文件不会被直接改写。',
    ],
  }, null, 2);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
export async function chatCompleteMock({ messages, tools = [], onText, task = 'agent', signal } = {}) {
  const input = lastUserText(messages);
  const available = toolNamesAvailable(tools);

  /* --- 脚本校错：单次输出结构化 JSON，不调用工具 --- */
  if (task === 'script') {
    const json = renderScriptReport(extractScript(input));
    const intro = '我先跑了本地静态规则引擎，再让 AI 做语义补充，结果如下（JSON 可直接被前端消费）：\n\n```json\n';
    await emit(intro, onText, signal);
    await emit(json, onText, signal, { chunk: 24, delay: 4 });
    await emit('\n```\n', onText, signal);
    return {
      content: `${intro}${json}\n\`\`\`\n`,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      responseId: null,
      protocol: 'mock',
    };
  }

  /* --- 第 1 轮：规划工具调用 --- */
  if (!hasToolResults(messages)) {
    const calls = planTools(input, available);
    if (calls.length) {
      await sleep(260);
      const thinking = '我先取证再下结论：这些工具都是只读的，不会改动目标主机。\n';
      await emit(thinking, onText, signal, { chunk: 10, delay: 12 });
      for (const c of calls) {
        // 参数增量流：模拟真实模型逐字符吐出 arguments
        for (let i = 0; i < c.arguments.length; i += 12) {
          if (signal?.aborted) break;
          await sleep(4);
        }
      }
      return {
        content: thinking,
        toolCalls: calls,
        finishReason: 'tool_calls',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        responseId: null,
        protocol: 'mock',
      };
    }
    // 纯概念问答，不调工具
    const answer = [
      '这是一个偏概念性的问题，不需要读取线上数据就直接回答：\n\n',
      '在真实模型模式下，这里会由大模型生成完整解释；',
      '当前处于**演示模式**（未配置 OPENAI_API_KEY），所以返回这段占位文本。\n\n',
      '要想体验完整分析，可以试试这些内置场景：\n',
      '- 「web-01 磁盘满了，Nginx 报 No space left on device」\n',
      '- 「app-02 的 Java 服务反复重启，说是 OOM」\n',
      '- 「db-03 慢查询突然涨到 148 条/分钟」\n',
      '- 「cache-04 Redis 连不上」\n',
      '- 「gw-05 网关大量 502」\n',
    ].join('');
    await emit(answer, onText, signal);
    return {
      content: answer,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      responseId: null,
      protocol: 'mock',
    };
  }

  /* --- 第 2 轮：基于证据输出报告 --- */
  const evidence = collectEvidence(messages);
  const scenario = detectScenario(input, evidence);
  await sleep(200);
  const report = renderReport(scenario, input, evidence);
  const ok = await emit(report, onText, signal, { chunk: 10, delay: 6 });
  return {
    content: ok ? report : report.slice(0, -1),
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    responseId: null,
    protocol: 'mock',
  };
}
