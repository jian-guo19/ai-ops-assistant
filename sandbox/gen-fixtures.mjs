/**
 * 生成沙箱 fixture 数据（inventory.json）。
 *
 * 为什么要确定性生成而不是 Math.random()：
 *   Agent 会多轮调用工具取证，如果同一参数的查询结果每次都不一样，
 *   模型会在自己的回答里自相矛盾。这里用「种子哈希 + 伪随机」保证：
 *   同样的 (host, metric) 永远得到同样的曲线。
 * 真实落地时，把这一层换成 Zabbix API / Prometheus API / 云监控 SDK 即可，
 * 工具函数的签名保持不变。
 *
 * 用法：node sandbox/gen-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'inventory.json');

/** 32 位字符串哈希，用于把 host/metric 映射成稳定种子 */
function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而稳定的伪随机数发生器 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POINTS = 60; // 最近 60 个采样点，间隔 1 分钟

/**
 * 生成一条趋势序列。
 * @param {object} spec
 * @param {string} spec.key      种子键
 * @param {number} spec.start    起始值
 * @param {number} spec.end      目标值（最后一段的趋势方向）
 * @param {number} spec.jitter   抖动幅度
 * @param {number} [spec.step]   阶梯/突变发生的节点占比
 */
function series({ key, start, end, jitter, unit, stepAt = 0.6, sudden = false }) {
  const rand = mulberry32(hashCode(key));
  const out = [];
  const now = Date.UTC(2026, 9, 11, 7, 40, 0); // 固定"当前时间"，保证可复现
  let value = start;
  for (let i = 0; i < POINTS; i += 1) {
    const t = i / (POINTS - 1);
    let target;
    if (sudden) {
      target = t < stepAt ? start : end;
    } else {
      // 前 60% 缓慢爬升，之后加速 -> 模拟"逐渐恶化"
      const curve = t < stepAt ? (t / stepAt) * 0.35 : 0.35 + ((t - stepAt) / (1 - stepAt)) * 0.65;
      target = start + (end - start) * curve;
    }
    value = value * 0.65 + target * 0.35; // 平滑跟随目标
    const noise = (rand() - 0.5) * jitter;
    const v = Math.max(0, Number((value + noise).toFixed(2)));
    out.push({ ts: new Date(now - (POINTS - 1 - i) * 60000).toISOString(), value: v });
  }
  return { unit, points: out, latest: out[out.length - 1].value, avg60m: Number((out.reduce((s, p) => s + p.value, 0) / POINTS).toFixed(2)) };
}

const hosts = [
  { id: 'web-01', hostname: 'web-01.prod', role: 'nginx-web', ip: '10.0.1.11', env: 'prod', os: 'CentOS 7.9', zone: 'cn-hangzhou-a', cpu_cores: 8, mem_gb: 16, disk_gb: 100 },
  { id: 'app-02', hostname: 'app-02.prod', role: 'java-app', ip: '10.0.1.12', env: 'prod', os: 'CentOS 7.9', zone: 'cn-hangzhou-a', cpu_cores: 16, mem_gb: 32, disk_gb: 200 },
  { id: 'db-03', hostname: 'db-03.prod', role: 'mysql', ip: '10.0.1.21', env: 'prod', os: 'Ubuntu 20.04', zone: 'cn-hangzhou-b', cpu_cores: 32, mem_gb: 128, disk_gb: 1000 },
  { id: 'cache-04', hostname: 'cache-04.prod', role: 'redis', ip: '10.0.1.22', env: 'prod', os: 'Ubuntu 20.04', zone: 'cn-hangzhou-b', cpu_cores: 8, mem_gb: 64, disk_gb: 100 },
  { id: 'gw-05', hostname: 'gw-05.prod', role: 'gateway', ip: '10.0.1.31', env: 'prod', os: 'CentOS 7.9', zone: 'cn-hangzhou-a', cpu_cores: 8, mem_gb: 16, disk_gb: 100 },
];

/** 每台主机的剧本：这些异常分别对应阶段 1 的五个演示场景 */
const metrics = {
  'web-01': {
    cpu: series({ key: 'web01-cpu', start: 22, end: 38, jitter: 6, unit: '%' }),
    mem: series({ key: 'web01-mem', start: 52, end: 61, jitter: 3, unit: '%' }),
    disk: series({ key: 'web01-disk', start: 74, end: 97.3, jitter: 0.6, unit: '%' }),
    inode: series({ key: 'web01-inode', start: 80, end: 96.1, jitter: 0.3, unit: '%' }),
    net_out: series({ key: 'web01-net', start: 120, end: 140, jitter: 25, unit: 'Mbps' }),
    io_wait: series({ key: 'web01-iow', start: 1.2, end: 3.4, jitter: 1.2, unit: '%' }),
  },
  'app-02': {
    cpu: series({ key: 'app02-cpu', start: 45, end: 88, jitter: 7, unit: '%' }),
    mem: series({ key: 'app02-mem', start: 58, end: 93.6, jitter: 2.5, unit: '%' }),
    disk: series({ key: 'app02-disk', start: 61, end: 68, jitter: 0.5, unit: '%' }),
    swap: series({ key: 'app02-swap', start: 4, end: 62, jitter: 3, unit: '%' }),
    io_wait: series({ key: 'app02-iow', start: 1, end: 6, jitter: 2, unit: '%' }),
    gc_pause: series({ key: 'app02-gc', start: 120, end: 3400, jitter: 300, unit: 'ms', stepAt: 0.75, sudden: false }),
  },
  'db-03': {
    cpu: series({ key: 'db03-cpu', start: 38, end: 72, jitter: 5, unit: '%' }),
    mem: series({ key: 'db03-mem', start: 70, end: 82, jitter: 2, unit: '%' }),
    disk: series({ key: 'db03-disk', start: 69, end: 74.5, jitter: 0.3, unit: '%' }),
    io_wait: series({ key: 'db03-iow', start: 4, end: 41.7, jitter: 4, unit: '%', stepAt: 0.7 }),
    conn: series({ key: 'db03-conn', start: 180, end: 786, jitter: 20, unit: 'count', stepAt: 0.65 }),
    slow_query: series({ key: 'db03-slow', start: 2, end: 148, jitter: 12, unit: 'count/min', stepAt: 0.7 }),
  },
  'cache-04': {
    cpu: series({ key: 'cache04-cpu', start: 18, end: 26, jitter: 4, unit: '%' }),
    mem: series({ key: 'cache04-mem', start: 76, end: 88.4, jitter: 2, unit: '%' }),
    disk: series({ key: 'cache04-disk', start: 40, end: 43, jitter: 0.4, unit: '%' }),
    evicted: series({ key: 'cache04-evict', start: 10, end: 8600, jitter: 400, unit: 'keys/min', stepAt: 0.6 }),
    conn: series({ key: 'cache04-conn', start: 320, end: 0, jitter: 8, unit: 'count', stepAt: 0.72, sudden: true }),
    hit_rate: series({ key: 'cache04-hit', start: 98.2, end: 71.5, jitter: 1.5, unit: '%', stepAt: 0.72, sudden: true }),
  },
  'gw-05': {
    cpu: series({ key: 'gw05-cpu', start: 30, end: 64, jitter: 6, unit: '%' }),
    mem: series({ key: 'gw05-mem', start: 48, end: 55, jitter: 3, unit: '%' }),
    disk: series({ key: 'gw05-disk', start: 44, end: 46, jitter: 0.3, unit: '%' }),
    net_in: series({ key: 'gw05-netin', start: 260, end: 940, jitter: 60, unit: 'Mbps', stepAt: 0.68 }),
    upstream_timeout: series({ key: 'gw05-uto', start: 0, end: 187, jitter: 10, unit: 'count/min', stepAt: 0.68 }),
    http_5xx: series({ key: 'gw05-5xx', start: 1, end: 96, jitter: 8, unit: 'count/min', stepAt: 0.68 }),
  },
};

const services = {
  'web-01': [
    { name: 'nginx', state: 'running', since: '2026-10-09T02:11:03Z', pid: 1187, enabled: true, note: '' },
    { name: 'php-fpm', state: 'running', since: '2026-10-09T02:11:09Z', pid: 1302, enabled: true, note: '' },
    { name: 'filebeat', state: 'failed', since: '2026-10-11T07:02:41Z', pid: null, enabled: true, note: 'code=exited, status=1/FAILURE —— 日志采集已中断 38 分钟' },
  ],
  'app-02': [
    { name: 'order-svc', state: 'running', since: '2026-10-11T07:31:12Z', pid: 4421, enabled: true, note: '近 1 小时已重启 5 次（Exit 137 = OOM Kill）' },
    { name: 'docker', state: 'running', since: '2026-09-28T11:20:00Z', pid: 903, enabled: true, note: '' },
    { name: 'node-exporter', state: 'running', since: '2026-09-28T11:20:05Z', pid: 951, enabled: true, note: '' },
  ],
  'db-03': [
    { name: 'mysqld', state: 'running', since: '2026-09-02T03:00:12Z', pid: 2201, enabled: true, note: 'Threads_connected 786 / max_connections 800' },
    { name: 'mysqld-exporter', state: 'running', since: '2026-09-02T03:01:00Z', pid: 2233, enabled: true, note: '' },
  ],
  'cache-04': [
    { name: 'redis-server', state: 'inactive', since: '2026-10-11T07:21:58Z', pid: null, enabled: true, note: 'dead 已停止 19 分钟，客户端报 Connection refused' },
    { name: 'redis-sentinel', state: 'running', since: '2026-10-11T07:22:03Z', pid: 3301, enabled: true, note: 'sentinel 已切换主节点但未发出告警' },
  ],
  'gw-05': [
    { name: 'nginx', state: 'running', since: '2026-10-05T09:30:00Z', pid: 771, enabled: true, note: 'upstream gw->app-02 大量 timeout' },
    { name: 'certbot-renew.timer', state: 'waiting', since: '2026-10-11T03:00:00Z', pid: null, enabled: true, note: 'TLS 证书将在 7 天后到期' },
  ],
};

const processes = {
  'web-01': [
    { pid: 1187, user: 'root', cpu: 3.2, mem: 1.1, cmd: 'nginx: master process /usr/sbin/nginx' },
    { pid: 1302, user: 'www', cpu: 6.8, mem: 2.4, cmd: 'php-fpm: pool www' },
    { pid: 5521, user: 'root', cpu: 2.1, mem: 0.6, cmd: '/usr/bin/containerd' },
  ],
  'app-02': [
    { pid: 4421, user: 'app', cpu: 186.4, mem: 61.7, cmd: 'java -Xms8g -Xmx24g -jar order-svc.jar' },
    { pid: 903, user: 'root', cpu: 4.2, mem: 1.9, cmd: '/usr/bin/dockerd' },
    { pid: 951, user: 'root', cpu: 1.1, mem: 0.4, cmd: '/usr/bin/node_exporter' },
  ],
  'db-03': [
    { pid: 2201, user: 'mysql', cpu: 240.6, mem: 68.9, cmd: '/usr/sbin/mysqld --innodb-buffer-pool-size=96G' },
    { pid: 2233, user: 'root', cpu: 0.8, mem: 0.2, cmd: '/usr/bin/mysqld_exporter' },
  ],
  'cache-04': [
    { pid: null, user: 'redis', cpu: 0, mem: 0, cmd: '(redis-server 已退出，无进程)' },
    { pid: 3301, user: 'redis', cpu: 0.6, mem: 0.3, cmd: '/usr/bin/redis-sentinel *:26379' },
  ],
  'gw-05': [
    { pid: 771, user: 'root', cpu: 12.4, mem: 2.2, cmd: 'nginx: master process /usr/sbin/nginx' },
    { pid: 990, user: 'root', cpu: 0.3, mem: 0.2, cmd: '/usr/bin/node_exporter' },
  ],
};

const alerts = [
  { id: 'ALRT-1021', host_id: 'web-01', severity: 'critical', name: 'DiskUsageCritical', started_at: '2026-10-11T07:21:00Z', summary: '/ 分区使用率 97.3%，可用 1.8G', labels: { team: 'ops', component: 'filesystem' } },
  { id: 'ALRT-1022', host_id: 'web-01', severity: 'warning', name: 'InodeUsageHigh', started_at: '2026-10-11T07:23:00Z', summary: '/ 分区 inode 使用率 96.1%', labels: { team: 'ops', component: 'filesystem' } },
  { id: 'ALRT-1023', host_id: 'web-01', severity: 'warning', name: 'LogShipperDown', started_at: '2026-10-11T07:02:41Z', summary: 'filebeat 进程退出，日志采集中断', labels: { team: 'ops', component: 'logging' } },
  { id: 'ALRT-1030', host_id: 'app-02', severity: 'critical', name: 'ContainerOOMKilled', started_at: '2026-10-11T07:31:12Z', summary: 'order-svc 被 OOM Killer 终止（Exit 137），近 1h 重启 5 次', labels: { team: 'app', component: 'jvm' } },
  { id: 'ALRT-1031', host_id: 'app-02', severity: 'warning', name: 'MemoryUsageHigh', started_at: '2026-10-11T07:25:00Z', summary: '内存使用率 93.6%，swap 已用 62%', labels: { team: 'app', component: 'memory' } },
  { id: 'ALRT-1040', host_id: 'db-03', severity: 'critical', name: 'SlowQuerySpike', started_at: '2026-10-11T07:18:00Z', summary: '慢查询 148 条/分钟（基线 2 条/分钟）', labels: { team: 'dba', component: 'mysql' } },
  { id: 'ALRT-1041', host_id: 'db-03', severity: 'warning', name: 'IOWaitHigh', started_at: '2026-10-11T07:20:00Z', summary: 'iowait 41.7%，磁盘 IO 存在明显瓶颈', labels: { team: 'dba', component: 'disk' } },
  { id: 'ALRT-1042', host_id: 'db-03', severity: 'warning', name: 'ConnPoolNearLimit', started_at: '2026-10-11T07:26:00Z', summary: 'Threads_connected 786 / max_connections 800', labels: { team: 'dba', component: 'mysql' } },
  { id: 'ALRT-1050', host_id: 'cache-04', severity: 'critical', name: 'RedisDown', started_at: '2026-10-11T07:21:58Z', summary: 'redis-server 停止运行，客户端 Connection refused', labels: { team: 'middleware', component: 'redis' } },
  { id: 'ALRT-1051', host_id: 'cache-04', severity: 'warning', name: 'HitRateDropped', started_at: '2026-10-11T07:22:30Z', summary: '缓存命中率由 98.2% 跌至 71.5%', labels: { team: 'middleware', component: 'redis' } },
  { id: 'ALRT-1060', host_id: 'gw-05', severity: 'critical', name: 'UpstreamTimeoutRateHigh', started_at: '2026-10-11T07:24:00Z', summary: 'upstream app-02 超时 187 次/分钟，5xx 96 次/分钟', labels: { team: 'ops', component: 'nginx' } },
  { id: 'ALRT-1061', host_id: 'gw-05', severity: 'warning', name: 'CertExpiringSoon', started_at: '2026-10-10T03:00:00Z', summary: 'TLS 证书 7 天后到期（2026-10-18）', labels: { team: 'ops', component: 'tls' } },
];

const inventory = {
  generated_at: '2026-10-11T07:40:00Z',
  note: '模拟数据：真实环境请把 tools/sandbox 数据源替换为 Prometheus / Zabbix / 云监控 API',
  hosts,
  metrics,
  services,
  processes,
  alerts,
};

fs.writeFileSync(OUT, JSON.stringify(inventory, null, 2), 'utf8');
console.log(`已生成 fixture：${OUT}`);
console.log(`主机 ${hosts.length} 台 / 告警 ${alerts.length} 条 / 每序列 ${POINTS} 个采样点`);
