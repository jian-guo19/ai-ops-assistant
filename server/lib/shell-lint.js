/**
 * Shell 脚本静态风险规则引擎（阶段 2 的“本地第一道闸”）。
 *
 * 设计取舍：
 *   - 纯 AI 审查会漏报也会幻觉；确定性规则能稳定抓住高危模式，且零成本、零延迟。
 *   - 本项目采用「本地规则给出结构化结论 -> AI 做语义补充与排序 -> 人工确认后再落地」三段式。
 *   - 每条规则都附带可机读的 patch，前端据此生成修改后脚本与 diff，避免 AI 自由改写整份文件。
 *
 * patch 语义：
 *   { type:'replace', find, replace }                      逐字替换（find 必须是脚本原文的子串）
 *   { type:'insert',  anchor, position:'before'|'after', text }  在锚点行前后插入
 */

/**  severity 权重，用于排序与统计 */
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

let seq = 0;
function issue(spec) {
  seq += 1;
  return { id: `SH-${String(seq).padStart(3, '0')}`, ...spec };
}

/** 判断是否被单引号/双引号包裹 */
function isQuoted(str, index) {
  const before = str.slice(0, index);
  return /["']$/.test(before) || (before.match(/"/g) || []).length % 2 === 1;
}

export function lintShell(script) {
  seq = 0;
  const issues = [];
  const lines = script.split(/\r?\n/);
  const text = script;

  const hasShebang = lines.some((l) => l.trim().startsWith('#!'));
  const hasStrictMode = /set\s+-[euxo]*e[euxo]*|set\s+-o\s+(errexit|pipefail|nounset)|set\s+-euo\s+pipefail/.test(text);
  const hasTrap = /^\s*trap\s+/m.test(text);
  const hasBackup = /\.bak|\.backup|mv\s+.*\s+.*\.(bak|old)|\bcp\s+-[a-zA-Z]*[ap]/.test(text);

  /* ---------- 缺失类：整体加固 ---------- */
  if (!hasShebang) {
    issues.push(issue({
      severity: 'medium',
      line: 1,
      title: '缺少 shebang 声明',
      risk: '脚本缺少 #!/bin/bash 声明时，由哪个解释器执行取决于调用方式，可能被 dash/sh 解释而行为不一致（例如 [[ ]]、数组、pipefail）。',
      suggestion: '显式声明 #!/bin/bash（或 #!/usr/bin/env bash），并在仓库里用统一的解释器运行。',
      patch: { type: 'insert', anchor: null, position: 'before', text: '#!/bin/bash' },
    }));
  }

  if (!hasStrictMode) {
    issues.push(issue({
      severity: 'high',
      line: hasShebang ? 2 : 1,
      title: '未开启严格模式（缺少 set -euo pipefail）',
      risk: '默认情况下 Shell 遇到错误不会中断。例如 cd 失败后继续执行 rm，就会把文件删到错误的目录；变量未定义时会被当成空串，rm -rf $TARGET 极易变成 rm -rf /。',
      suggestion: '在 shebang 之后立即加入 set -euo pipefail，让错误、未定义变量、管道失败都能立即中止。',
      patch: {
        type: 'insert',
        anchor: hasShebang ? lines.findIndex((l) => l.trim().startsWith('#!')) : -1,
        position: 'after',
        text: '\nset -euo pipefail',
      },
    }));
  }

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    /* ---------- 危险删除 ---------- */
    const rmMatch = line.match(/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*|-rf|-fr)\s+(.+?)\s*$/);
    if (rmMatch) {
      const target = rmMatch[2].trim();
      const usesVar = /\$\w+|\$\{[^}]+\}/.test(target);
      if (usesVar) {
        const unquotedVar = /\$\w+(?!["'}])/.test(target) && !/^["']/.test(target);
        if (unquotedVar) {
          issues.push(issue({
            severity: 'critical',
            line: lineNo,
            title: 'rm -rf 作用于未加引号的变量',
            risk: '变量为空或未定义时，rm -rf $TARGET/* 会退化成 rm -rf /*；变量含空格时也会被错误分词。这是运维事故里最经典的“删库”模式。',
            suggestion: '删除前必须校验变量非空且指向预期路径，并用引号包裹；更进一步改成「先移动到回收目录/备份，确认无误后再清理」。',
            patch: {
              type: 'replace',
              find: trimmed,
              replace: `[[ -n "${'$'}{TARGET:-}" && -d "${'$'}{TARGET}" ]] || { echo "TARGET 无效，拒绝执行删除" >&2; exit 1; }\nrm -rf -- "${'$'}{TARGET:?TARGET 未定义}"/*`,
            },
          }));
        } else {
          issues.push(issue({
            severity: 'high',
            line: lineNo,
            title: 'rm -rf 使用变量且缺少前置校验',
            risk: '即使加了引号，只要变量值不符合预期（例如指向 / 或家目录），后果同样不可逆。',
            suggestion: '加入白名单/非空判断，并在删除前打印目标路径由人工或 dry-run 确认。',
            patch: null,
          }));
        }
      }
      if (/\/\s*$|\/\s*\*/.test(target) && !usesVar) {
        issues.push(issue({
          severity: 'high',
          line: lineNo,
          title: '对根路径或通配路径执行强制删除',
          risk: '直接删除根目录、/* 或 /tmp/* 这类路径，一旦路径写错或包含运行中进程的临时文件，会造成系统级损坏。',
          suggestion: '限定到具体应用目录，并优先使用 truncate 或带时间条件的 find -mtime 清理。',
          patch: null,
        }));
      }
    }

    /* ---------- 远端脚本直接执行 ---------- */
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(line)) {
      issues.push(issue({
        severity: 'critical',
        line: lineNo,
        title: '下载并直接执行远端脚本（curl | bash）',
        risk: '管道右侧的 Shell 会执行未经审计的内容：中间人篡改、上游仓库被污染、网络半包截断导致的命令截断拼接，都无法在执行前发现。同时也无法做版本锁定。',
        suggestion: '先下载到固定路径，执行 sha256 校验，再运行；生产环境应改为制品库分发或配置管理工具下发。',
        patch: {
          type: 'replace',
          find: trimmed,
          replace: `tmp_script="$(mktemp)"; trap 'rm -f "$tmp_script"' EXIT\ncurl -fsSL -o "$tmp_script" https://ops-internal.example.com/bootstrap.sh \\\n  && echo "<预期的sha256>  $tmp_script" | sha256sum -c - \\\n  && bash "$tmp_script"`,
        },
      }));
    }

    /* ---------- 明文凭据 ---------- */
    const passAssign = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(['"])(.+?)\2\s*$/);
    if (passAssign && /(pass|pwd|secret|token|key)/i.test(passAssign[1])) {
      issues.push(issue({
        severity: 'high',
        line: lineNo,
        title: `明文机密写入变量 ${passAssign[1]}`,
        risk: '脚本通常会被提交进 Git、打包进镜像或打印进 CI 日志；一旦落库就是长期有效的凭据泄露。',
        suggestion: '改为从密钥管理服务或受限权限文件读取（如 secrets 文件 mode 600），并确保脚本本身不打印该变量。',
        patch: {
          type: 'replace',
          find: trimmed,
          replace: `# 凭据不写死在脚本内，从受限文件读取\n${passAssign[1]}="$(< /etc/order-svc/db_secret)"`,
        },
      }));
    }

    /* ---------- 命令行参数泄露凭据 ---------- */
    if (/\bmysql\b.*-p\$\{?[A-Za-z_]/.test(line) || /\bmysqladmin\b.*-p\$\{?[A-Za-z_]/.test(line)) {
      issues.push(issue({
        severity: 'high',
        line: lineNo,
        title: '数据库密码通过命令行参数传递',
        risk: '同一主机上任意用户执行 ps -ef / /proc/<pid>/cmdline 都能看到完整命令行，密码即刻泄露；也会进入审计日志和 Shell history。',
        suggestion: '使用 ~/.my.cnf（mode 600）或 MYSQL_PWD 环境变量（次之），避免出现在 argv 里。',
        patch: null,
      }));
    }

    /* ---------- 吞掉错误 ---------- */
    if (/\|\|\s*true\b/.test(line) || /\|\|\s*:\s*$/.test(line)) {
      issues.push(issue({
        severity: 'medium',
        line: lineNo,
        title: '使用 || true 吞掉命令失败',
        risk: '数据库迁移失败也会被标记为成功，后续步骤继续推进，最终上线一个“数据未迁移完成”的版本，且排障时没有失败痕迹。',
        suggestion: '迁移类关键步骤必须让失败向上冒泡；若确实允许失败，先显式记录日志并输出可观测的告警指标。',
        patch: null,
      }));
    }

    /* ---------- kill -9 ---------- */
    if (/xargs\s+.*\bkill\b\s+-9/.test(line) || /\bkillall\b|\bpkill\s+-9/.test(line)) {
      issues.push(issue({
        severity: 'high',
        line: lineNo,
        title: '强制 kill -9 进程',
        risk: 'SIGKILL 无法被进程捕获，来不及做优雅退出：正在写入的数据会丢失，连接池里的请求会中断，Java 应用还可能留下损坏的临时文件。',
        suggestion: '优先使用 systemctl stop 或先发 SIGTERM 并等待退出，超时后再升级。',
        patch: null,
      }));
    }

    /* ---------- 无保护的 grep 自杀线 ---------- */
    if (/ps\s+aux\s*\|[^|]*grep/.test(line) && !/grep\s+-v\s+grep/.test(line)) {
      issues.push(issue({
        severity: 'low',
        line: lineNo,
        title: 'ps | grep 缺少 grep -v grep 过滤',
        risk: '可能把 grep 自身进程一起匹配回来，导致后续操作作用于错误 PID。',
        suggestion: '改用 pgrep -f 或加上 grep -v grep 过滤。',
        patch: null,
      }));
    }

    /* ---------- cd 未校验 ---------- */
    const cdMatch = line.match(/^\s*cd\s+(.+?)\s*$/);
    if (cdMatch) {
      issues.push(issue({
        severity: 'medium',
        line: lineNo,
        title: 'cd 之后未校验是否成功',
        risk: '目录不存在或没权限时 cd 失败，脚本会继续在“原目录”执行后续的相对路径操作——比如把文件复制到完全错误的位置。',
        suggestion: '使用 cd ... || exit 1，或直接用绝对路径配合 pushd/popd。',
        patch: {
          type: 'replace',
          find: trimmed,
          replace: `cd ${cdMatch[1]} || { echo "切换目录失败: ${cdMatch[1]}" >&2; exit 1; }`,
        },
      }));
    }

    /* ---------- sleep 当作健康检查 ---------- */
    if (/^\s*sleep\s+\d+/.test(line)) {
      issues.push(issue({
        severity: 'low',
        line: lineNo,
        title: '用固定 sleep 等待服务就绪',
        risk: 'sleep 只是“等待”，不是“确认”。负载高时 3 秒不够，空闲时又白白浪费时间；后续步骤仍可能在服务未就绪时执行。',
        suggestion: '改为轮询健康接口直到返回预期状态，并设置超时上限。',
        patch: {
          type: 'replace',
          find: trimmed,
          replace: `for _ in $(seq 1 30); do\n  curl -fsS http://127.0.0.1:8080/actuator/health >/dev/null && break\n  sleep 1\ndone`,
        },
      }));
    }

    /* ---------- 凭据回显 ---------- */
    if (/echo\s+.*\$\{?(PASS|PWD|SECRET|TOKEN)/i.test(line)) {
      issues.push(issue({
        severity: 'high',
        line: lineNo,
        title: '把凭据打印进输出/日志',
        risk: '明文口令会进入终端、CI 日志与 log 文件，扩大泄露面。',
        suggestion: '敏感值一律不打印；如需确认存在与否，只输出是否非空。',
        patch: null,
      }));
    }

    /* ---------- chpasswd ---------- */
    if (/\bchpasswd\b/.test(line)) {
      issues.push(issue({
        severity: 'critical',
        line: lineNo,
        title: '批量修改系统账号密码（含 root）',
        risk: '在自动化脚本里改 root 密码，一旦执行时机不对或多机执行，会直接把自己锁在系统外，属于不可回滚的高危操作。',
        suggestion: '账号口令应由配置管理/密钥系统统一托管，脚本不应包含修改 root 密码的逻辑。',
        patch: null,
      }));
    }

    /* ---------- $? 反模式 ---------- */
    if (/if\s+\[\s*\$\?\s+-(eq|ne|gt|lt)\s+\d+\s*\]/.test(line)) {
      issues.push(issue({
        severity: 'low',
        line: lineNo,
        title: '用 $? 判断上一条命令的返回值',
        risk: '中间插入任何一条命令（哪怕只是 echo）都会覆盖 $?，导致判断的是错误的命令结果。',
        suggestion: '直接写成 if command; then ... fi。',
        patch: null,
      }));
    }

    /* ---------- 变量未加引号 ---------- */
    const unquotedVar = line.match(/(?:^|\s)(cp|mv|chmod|chown|tar|mkdir|ln)\s+(?:-[a-zA-Z]+\s+)*\$[A-Za-z_][A-Za-z0-9_]*(?!["'}])/);
    if (unquotedVar && !isQuoted(line, line.indexOf('$'))) {
      issues.push(issue({
        severity: 'medium',
        line: lineNo,
        title: '命令参数中的变量未加双引号',
        risk: '变量含空格或以 - 开头时会被错误分词/当成选项，cp $SRC $DST 在 SRC 为空时甚至会覆盖目标目录的内容。',
        suggestion: '所有变量引用一律用双引号包裹："$VAR"。',
        patch: null,
      }));
    }
  });

  /* ---------- 缺失类：可观测与回滚 ---------- */
  if (!hasBackup) {
    issues.push(issue({
      severity: 'medium',
      line: null,
      title: '缺少备份或回滚入口',
      risk: '部署脚本覆盖了现有发布物但没有备份，一旦新版本不可用，无法在分钟级回滚到上一个已知良好版本。',
      suggestion: '发布前把旧版本目录打时间戳归档（保留最近 N 份），并明确写出回滚命令。',
      patch: {
        type: 'insert',
        anchor: null,
        position: 'before-cp',
        text: `backup_dir="/opt/order-svc-backup/$(date +%Y%m%d%H%M%S)"\nmkdir -p "$backup_dir" && cp -a "$TARGET/." "$backup_dir/"`,
      },
    }));
  }

  if (!hasTrap) {
    issues.push(issue({
      severity: 'low',
      line: null,
      title: '缺少 trap 清理逻辑',
      risk: '脚本被中断或异常退出时，临时文件、挂载点、锁文件会残留，下一次执行可能因此失败或误判。',
      suggestion: '使用 trap 统一处理 EXIT/ERR，至少清理临时资源。',
      patch: null,
    }));
  }

  if (/^\s*set\s+-x\b/m.test(text)) {
    issues.push(issue({
      severity: 'low',
      line: lines.findIndex((l) => /^\s*set\s+-x\b/.test(l)) + 1,
      title: '开启 set -x 可能泄露敏感信息',
      risk: '执行追踪会把变量展开后的值原样输出，包括路径、参数，若脚本内涉及凭据就会一并进日志。',
      suggestion: '仅在排障时临时开启，或用 PS4 做脱敏后再长期开启。',
      patch: null,
    }));
  }

  /* ---------- 汇总 ---------- */
  issues.sort((a, b) => {
    const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    return d !== 0 ? d : (a.line ?? 0) - (b.line ?? 0);
  });

  const stats = {
    lines: lines.length,
    hasShebang,
    hasStrictMode,
    hasTrap,
    hasBackup,
    counts: issues.reduce((acc, i) => {
      acc[i.severity] = (acc[i.severity] || 0) + 1;
      return acc;
    }, {}),
  };

  return { issues, stats };
}

export const __SEVERITY_ORDER = SEVERITY_ORDER;
