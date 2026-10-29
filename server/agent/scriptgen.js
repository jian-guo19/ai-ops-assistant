/**
 * 脚本生成器（阶段 4）。
 *
 * 与「让模型从零写脚本」的区别：这里由**模板 + 参数**生成，
 * 模型只负责挑模板、填参数、说明风险。好处是：
 *   - 骨架恒定安全：set -euo pipefail、trap 清理、变量全引号、默认 dry-run；
 *   - 产物可预期：同类变更每次生成的结构一致，便于评审与 diff；
 *   - 门禁可机检：生成完立刻跑 gateScript，过不了就不允许提交审批。
 *
 * 默认 dry-run 是运维实践里最值得保留的一条约定：
 * 脚本默认只打印它将要做什么，确认无误后显式加 --apply 才真正落地。
 */
import { gateScript } from './executor.js';

function skeleton({ intent, targetHost, approvalHint, body }) {
  return `#!/bin/bash
# ============================================================
# 自动生成 · AI 运维助手
# 意图   : ${intent}
# 目标   : ${targetHost || '未指定（请在执行前确认）'}
# 提示   : ${approvalHint}
# 安全约定：默认 dry-run，确认无误后加 --apply 真正执行
# ============================================================
set -euo pipefail

APPLY="\${APPLY:-0}"
if [ "\${1:-}" = "--apply" ]; then
  APPLY="1"
fi

run() {
  if [ "$APPLY" = "1" ]; then
    echo "[apply]   $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

trap 'echo "[trap] 脚本中断退出，请人工确认已执行到哪一步" >&2' EXIT

${body}

echo ""
echo "完成。当前模式：\${APPLY}（0=dry-run / 1=已真正执行）"
`;
}

/** 模板：键为模板 id，match 用于按意图关键词命中 */
export const TEMPLATES = [
  {
    id: 'diagnose-collect',
    title: '采集诊断信息',
    desc: '只读采集磁盘、内存、进程、服务与关键日志，输出到工作区报告目录',
    keywords: ['采集', '诊断', '排查', '信息收集', 'diagnose', 'collect'],
    risk: 'low',
    render: (ctx) => skeleton({
      intent: ctx.intent,
      targetHost: ctx.targetHost,
      approvalHint: '全部为只读命令，仍建议审批后执行',
      body: `HOST="\${HOST:-${(ctx.targetHost || 'localhost').replace(/"/g, '')}}"
OUT_DIR="./reports"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d%H%M%S)"

echo "== 主机基本信息 =="
run date
run uname -a

echo "== 磁盘 =="
run df -h

echo "== 内存 =="
run free -m

echo "== 进程 TOP =="
run ps aux

echo "== 目录占用 =="
run du -sh "$OUT_DIR"

echo "报告目录：$OUT_DIR（本次时间戳 $STAMP）"`,
    }),
  },
  {
    id: 'log-cleanup',
    title: '清理过期日志（带备份）',
    desc: '按修改时间清理 N 天前的 .log 文件，先备份清单再清理，默认 dry-run',
    keywords: ['清理', '日志', '删除', 'logrotate', '磁盘', '空间', 'cleanup'],
    risk: 'high',
    render: (ctx) => skeleton({
      intent: ctx.intent,
      targetHost: ctx.targetHost,
      approvalHint: '涉及删除动作：默认 dry-run，务必确认清单后再加 --apply',
      body: `DAYS="\${DAYS:-${Number(ctx.params?.days) || 7}}"
LOG_DIRS="\${LOG_DIRS:-/var/log/nginx /var/log/app}"
BACKUP_DIR="./reports/log-backup-$(date +%Y%m%d%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "将清理 ${'$'}{DAYS} 天前的日志文件，目录：$LOG_DIRS"
for d in $LOG_DIRS; do
  if [ ! -d "$d" ]; then
    echo "跳过（目录不存在）：$d"
    continue
  fi
  # 先生成待处理清单，供人工确认
  find "$d" -maxdepth 1 -name '*.log' -type f -mtime "+${'$'}{DAYS}" -print | tee -a "$BACKUP_DIR/candidates.txt"
done

# 用 find -delete 而不是 rm -rf，避免作用范围失控
while IFS= read -r f; do
  run find "$f" -maxdepth 0 -type f -delete
done < "$BACKUP_DIR/candidates.txt"

echo "候选清单已存档：$BACKUP_DIR/candidates.txt"`,
    }),
  },
  {
    id: 'service-restart',
    title: '安全重启服务',
    desc: '重启前记录状态，重启后轮询健康接口，失败打印最近日志',
    keywords: ['重启', 'restart', '服务', 'systemd', '恢复'],
    risk: 'high',
    render: (ctx) => skeleton({
      intent: ctx.intent,
      targetHost: ctx.targetHost,
      approvalHint: '会造成短暂中断：请在业务低峰执行，确认有回滚方案',
      body: `SERVICE="\${SERVICE:-${(ctx.params?.service || 'nginx').replace(/"/g, '')}}"
HEALTH_URL="\${HEALTH_URL:-http://127.0.0.1:8080/health}"

echo "重启前状态："
run systemctl is-active "$SERVICE" || true

run systemctl restart "$SERVICE"

echo "等待服务就绪…"
for i in $(seq 1 30); do
  if run curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "健康检查通过（第 $i 次）"
    break
  fi
  sleep 1
done

echo "重启后状态："
run systemctl is-active "$SERVICE"
run systemctl status "$SERVICE" --no-pager -n 20 || true`,
    }),
  },
  {
    id: 'disk-usage-report',
    title: '磁盘占用 TOP 报告',
    desc: '扫描指定目录并输出占用最大的子目录，便于定位磁盘打满原因',
    keywords: ['磁盘', '占用', '目录', 'du', '空间', 'report'],
    risk: 'low',
    render: (ctx) => skeleton({
      intent: ctx.params?.scanPath || ctx.intent,
      targetHost: ctx.targetHost,
      approvalHint: '只读扫描，大目录可能较慢',
      body: `SCAN_DIR="\${SCAN_DIR:-${(ctx.params?.scanPath || '/var/log').replace(/"/g, '')}}"
DEPTH="\${DEPTH:-2}"
TOPN="\${TOPN:-20}"

echo "扫描目录：$SCAN_DIR（深度 $DEPTH，取前 $TOPN）"
run du -h --max-depth="$DEPTH" "$SCAN_DIR" 2>/dev/null || true
echo ""
echo "提示：如需清理，请单独提交「清理过期日志」变更单，并务必先 dry-run。`,
    }),
  },
  {
    id: 'config-backup',
    title: '配置文件备份',
    desc: '把目标配置文件拷贝到带时间戳的备份目录（只读清单 + 备份动作）',
    keywords: ['备份', 'backup', '配置', '快照'],
    risk: 'medium',
    render: (ctx) => skeleton({
      intent: ctx.intent,
      targetHost: ctx.targetHost,
      approvalHint: '会产生文件写入（备份目录）',
      body: `CONFIGS="\${CONFIGS:-/etc/nginx/nginx.conf /etc/nginx/conf.d}"
BACKUP_DIR="./reports/config-backup-$(date +%Y%m%d%H%M%S)"

mkdir -p "$BACKUP_DIR"
echo "备份到：$BACKUP_DIR"

for c in $CONFIGS; do
  if [ ! -e "$c" ]; then
    echo "跳过（不存在）：$c"
    continue
  fi
  run cp -a -- "$c" "$BACKUP_DIR/"
done

echo "备份完成：$BACKUP_DIR"`,
    }),
  },
  {
    id: 'health-check',
    title: '主机巡检',
    desc: '一次性输出负载、磁盘、内存、运行时长与关键服务状态',
    keywords: ['巡检', '检查', 'health', '状态', '概况', 'check'],
    risk: 'low',
    render: (ctx) => skeleton({
      intent: ctx.intent,
      targetHost: ctx.targetHost,
      approvalHint: '只读巡检',
      body: `echo "== 系统 =="
run uname -a
run hostname
run uptime

echo "== 资源 =="
run df -h
run free -m

echo "== 关键服务 =="
for s in nginx php-fpm mysqld redis-server; do
  printf '%-14s ' "$s"
  run systemctl is-active "$s" 2>/dev/null || echo "unknown"
done`,
    }),
  },
];

/** 模板目录（给前端渲染下拉框） */
export function templateCatalog() {
  return TEMPLATES.map((t) => ({
    id: t.id, title: t.title, desc: t.desc, risk: t.risk, keywords: t.keywords,
  }));
}

/** 按意图挑选模板；没有命中时回落到第一个（采集诊断） */
export function pickTemplate(intent = '') {
  const text = String(intent).toLowerCase();
  const hit = TEMPLATES.find((t) => t.keywords.some((k) => text.includes(k)));
  return hit || TEMPLATES[0];
}

/**
 * 生成脚本草稿，并立即做门禁评估。
 * @returns {{script:string, template:object, gate:object}}
 */
export function generateScript({ intent = '', targetHost = null, params = {} } = {}) {
  const template = pickTemplate(intent);
  const script = template.render({ intent: intent || template.title, targetHost, params });
  const gate = gateScript(script);
  return {
    script,
    template: { id: template.id, title: template.title, desc: template.desc, risk: template.risk },
    gate,
  };
}
