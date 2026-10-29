/**
 * 隔离执行器（阶段 4）。
 *
 * 安全设计（这是本项目最需要克制的一层）：
 *   1. 静态门禁先行：脚本先过 lint + 高危黑名单，命中即拒绝执行（审批也不能放行）。
 *   2. 只走审批单：executeApproved 只接受 approved 状态的审批 ID，不接收裸脚本。
 *   3. 不调用系统 shell：local 模式用「受限解释器」逐行执行白名单命令，
 *      在 Windows / Linux / macOS 上行为一致，且不存在 shell 注入面。
 *   4. 资源闸门：超时 kill、输出长度截断。
 *
 * 三种执行后端：
 *   mock   —— 默认。模拟执行并回显"会发生什么"，不产生任何副作用，适合演示与 CI。
 *   docker —— 真实隔离：`docker run --rm --network=none --memory/--cpus/--pids-limit`
 *             （需要本机安装 Docker）
 *   local  —— 受限解释器：仅执行只读类命令，需要显式 EXEC_ALLOW_LOCAL=true。
 *
 * 生产落地建议：把 local 换掉，改为 SSH 到跳板机 + 受限账号（sudo 白名单），
 * 或直接在一次性容器里执行，并在执行前后打快照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';
import { lintShell } from '../lib/shell-lint.js';
import { Errors } from '../lib/errors.js';

export const EXEC_MODE = (process.env.EXEC_MODE || 'mock').toLowerCase();
export const EXEC_TIMEOUT_MS = Number.parseInt(process.env.EXEC_TIMEOUT_MS ?? '10000', 10);
export const EXEC_ALLOW_LOCAL = /^(1|true|yes)$/i.test(process.env.EXEC_ALLOW_LOCAL ?? '');
const MAX_OUTPUT_CHARS = 8000;

export const WORKSPACE = path.join(config.paths.sandbox, 'workspace');

function ensureWorkspace() {
  for (const dir of [WORKSPACE, path.join(WORKSPACE, 'reports')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureWorkspace();

/* --------------------------- 静态门禁 --------------------------- */

/**
 * 无论是否审批，命中这些模式一律拒绝执行。
 * 与 shell-lint 的区别：lint 是「提示风险」，gate 是「能不能执行」——
 * 两者不能混用，否则模型可能绕过提示直接执行。
 */
const RISK_PATTERNS = [
  // ---- 不可放行：命中即拒绝，审批也无例外 ----
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|-rf|-fr)\b/, why: '强制删除（rm -rf）', level: 'blocked' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, why: '格式化文件系统（mkfs）', level: 'blocked' },
  { re: /\bdd\s+if=/, why: '块级写入（dd）', level: 'blocked' },
  { re: /\bchpasswd\b/, why: '批量修改系统账号密码', level: 'blocked' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, why: '关机或重启', level: 'blocked' },
  { re: /\b(init|telinit)\s+[06]\b/, why: '切换运行级别', level: 'blocked' },
  { re: /\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/, why: '管道直接执行 Shell', level: 'blocked' },
  { re: /\b(curl|wget)\b[^|]*\|\s*\w*sh\b/, why: '下载并执行远端脚本', level: 'blocked' },
  { re: /\b(chmod|chown)\s+(-R\s+)?[0-7]*7[0-7]{2}/, why: '放开权限为 777', level: 'blocked' },
  { re: />\s*\/dev\/(sd|nvme|vd|mapper|xvd)/, why: '直接写入块设备', level: 'blocked' },
  { re: /\bDROP\s+(DATABASE|TABLE)\b/i, why: '删库删表', level: 'blocked' },
  { re: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, why: '无 WHERE 条件的 DELETE', level: 'blocked' },
  { re: /\buserdel\b|\bgroupdel\b/, why: '删除系统账号', level: 'blocked' },
  { re: /\bsystemctl\s+(stop|disable|mask)\b/, why: '停止或禁用系统服务', level: 'blocked' },

  // ---- 可审批后执行：破坏性但可控、可预览 ----
  { re: /\bfind\b[^\n]{0,160}-delete\b/, why: 'find -delete 删除动作', level: 'needs_approval' },
  { re: /\bsystemctl\s+restart\b/, why: '重启服务会造成短暂中断', level: 'needs_approval' },
  { re: /\b(kill|killall|pkill)\b/, why: '终止进程', level: 'needs_approval' },
  { re: /\bcp\s+-[a-zA-Z]*f\b|\bmv\s+-[a-zA-Z]*f\b/, why: '强制覆盖文件', level: 'needs_approval' },
];

/**
 * 剥离注释后再做风险匹配。
 * 不这么做的话，注释里只要出现过 "rm -rf" 这几个字（比如提醒自己别用），
 * 脚本就会被误判为高危而拒绝执行——真实系统里这个误报非常常见。
 */
function stripComments(script) {
  return script
    .split(/\r?\n/)
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** 允许在受限解释器中执行的只读命令 */
const READ_ONLY_COMMANDS = new Set([
  'echo', 'ls', 'cat', 'date', 'pwd', 'df', 'free', 'uptime',
  'id', 'uname', 'head', 'tail', 'wc', 'du', 'ps', 'whoami',
  'hostname', 'stat', 'which', 'env', 'grep', 'find',
]);

/**
 * Shell 内建指令。
 * 它们不是外部程序（Windows 上没有 set.exe），也不产生文件系统副作用，
 * 所以单独识别：既不"执行"，也不应被误报成拦截。
 */
const SAFE_BUILTINS = new Set([
  'set', 'export', 'local', 'readonly', 'trap', 'shift', 'unset', 'cd', 'printf', 'true', 'false',
]);

/**
 * 评估脚本能否执行。
 * @returns {{level:'blocked'|'needs_approval'|'auto_allowed', reasons:string[], lint:object}}
 */
export function gateScript(script) {
  const { issues, stats } = lintShell(script);
  const code = stripComments(script);
  const lines = code.split(/\r?\n/).filter((l) => l.trim());

  const blocked = [];
  const approval = [];

  // 1) 风险模式匹配（基于剥离注释后的代码）
  for (const { re, why, level } of RISK_PATTERNS) {
    if (!re.test(code)) continue;
    if (level === 'blocked') blocked.push(`包含高危操作：${why}`);
    else approval.push(`存在需审批动作：${why}`);
  }

  // 2) lint 判定为 critical 的风险项同样不可放行
  for (const c of issues.filter((i) => i.severity === 'critical')) {
    blocked.push(`静态检查存在致命风险：${c.title}${c.line ? `（第 ${c.line} 行）` : ''}`);
  }

  // counts 供 UI 展示静态检查分布，与 /api/script/lint 的返回结构保持一致
  const blockedResult = () => ({
    level: 'blocked', reasons: [...new Set(blocked)], counts: stats.counts, lint: { issues, stats },
  });

  if (blocked.length) return blockedResult();

  // 3) lint 判定为 high 的动作 -> 需人工审批
  for (const h of issues.filter((i) => i.severity === 'high')) {
    approval.push(`存在高危动作：${h.title}`);
  }

  // 4) 只读取证类脚本：本系统仍要求审批（策略：任何执行都要人点头）
  const readOnly = lines.every((l) => {
    const cmd = l.trim().split(/\s+/)[0];
    return READ_ONLY_COMMANDS.has(cmd) || SAFE_BUILTINS.has(cmd);
  });
  if (!approval.length) {
    approval.push(readOnly ? '只读脚本，仍需人工审批后执行' : '脚本包含非白名单命令，需人工审批');
  }

  return {
    level: 'needs_approval',
    reasons: [...new Set(approval)],
    counts: stats.counts,
    lint: { issues, stats },
  };
}

/* --------------------------- 受限解释器 --------------------------- */

function insideWorkspace(target) {
  const resolved = path.resolve(target);
  const rel = path.relative(WORKSPACE, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveArg(arg) {
  if (arg === '~') return WORKSPACE;
  if (arg.startsWith('~')) return path.join(WORKSPACE, arg.slice(1));
  return path.resolve(WORKSPACE, arg);
}

/** 参数里不允许出现任何 shell 元字符，从源头断掉注入 */
const UNSAFE_ARG = /[;&|`$<>(){}[\]!*?\n\r]/;

function runLine(line, index) {
  const raw = line.trim();
  const parts = raw.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (!READ_ONLY_COMMANDS.has(cmd)) {
    if (SAFE_BUILTINS.has(cmd)) {
      return { line: index + 1, cmd, builtin: true, output: `# shell 内建：${raw}（隔离环境已识别，无副作用）` };
    }
    return { line: index + 1, cmd, skipped: true, output: `隔离环境不允许执行：${cmd}` };
  }
  for (const a of args) {
    if (UNSAFE_ARG.test(a)) {
      return { line: index + 1, cmd, skipped: true, output: `参数含不安全字符，已拒绝：${a}` };
    }
  }

  try {
    switch (cmd) {
      case 'echo':
      case 'printf':
        return { line: index + 1, cmd, output: args.join(' ') };
      case 'pwd':
        return { line: index + 1, cmd, output: WORKSPACE };
      case 'date':
        return { line: index + 1, cmd, output: new Date().toLocaleString('zh-CN', { hour12: false }) };
      case 'whoami':
      case 'id':
        return { line: index + 1, cmd, output: os.userInfo().username };
      case 'hostname':
        return { line: index + 1, cmd, output: os.hostname() };
      case 'uname':
        return { line: index + 1, cmd, output: `${os.type()} ${os.release()} ${os.arch()}` };
      case 'uptime':
        return { line: index + 1, cmd, output: `已运行 ${Math.round(process.uptime())} 秒` };
      case 'ls': {
        const dir = args.filter((a) => !a.startsWith('-')).pop();
        const target = dir ? resolveArg(dir) : WORKSPACE;
        if (!insideWorkspace(target)) throw new Error('目录越界');
        return { line: index + 1, cmd, output: fs.readdirSync(target).sort().join('  ') };
      }
      case 'cat': {
        const file = args.filter((a) => !a.startsWith('-')).pop();
        const target = resolveArg(file || '');
        if (!insideWorkspace(target)) throw new Error('文件越界');
        if (!fs.existsSync(target)) throw new Error(`文件不存在：${file}`);
        return { line: index + 1, cmd, output: fs.readFileSync(target, 'utf8').slice(0, 4000) };
      }
      case 'wc': {
        const file = args.filter((a) => !a.startsWith('-')).pop();
        const target = resolveArg(file || '');
        if (!insideWorkspace(target)) throw new Error('文件越界');
        const n = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean).length;
        return { line: index + 1, cmd, output: `${n} ${file}` };
      }
      case 'head':
      case 'tail': {
        const nArg = args.find((a) => /^-\d+$/.test(a));
        const n = nArg ? Number(nArg.slice(1)) : 10;
        const file = args.filter((a) => !a.startsWith('-')).pop();
        const target = resolveArg(file || '');
        if (!insideWorkspace(target)) throw new Error('文件越界');
        const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
        const picked = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n);
        return { line: index + 1, cmd, output: picked.join('\n') };
      }
      case 'grep': {
        const flags = args.filter((a) => a.startsWith('-'));
        const rest = args.filter((a) => !a.startsWith('-'));
        const pattern = rest.shift() || '';
        const file = rest.pop();
        const target = resolveArg(file || '');
        if (!insideWorkspace(target)) throw new Error('文件越界');
        const ignoreCase = flags.includes('-i');
        const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
        const needle = ignoreCase ? pattern.toLowerCase() : pattern;
        const hits = lines.filter((l) => (ignoreCase ? l.toLowerCase() : l).includes(needle));
        return { line: index + 1, cmd, output: `${hits.length} 行命中${flags.length ? `（忽略的标志：${flags.join(',')}）` : ''}\n${hits.slice(0, 20).join('\n')}` };
      }
      case 'du': {
        const dir = args.filter((a) => !a.startsWith('-')).pop();
        const target = dir ? resolveArg(dir) : WORKSPACE;
        if (!insideWorkspace(target)) throw new Error('目录越界');
        let total = 0;
        const walk = (d) => {
          for (const name of fs.readdirSync(d)) {
            const p = path.join(d, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else total += st.size;
          }
        };
        walk(target);
        return { line: index + 1, cmd, output: `${(total / 1024).toFixed(1)}K\t${target}` };
      }
      default:
        return { line: index + 1, cmd, skipped: true, output: `该命令在隔离环境中未实现：${cmd}` };
    }
  } catch (err) {
    return { line: index + 1, cmd, error: true, output: `执行失败：${err.message}` };
  }
}

/**
 * 后端：受限解释器。
 * 只处理"一行一条命令"的简单脚本；控制结构（if/for/trap）被视为不可执行并跳过，
 * 这样保证无论输入什么，都不可能产生写操作或系统调用。
 */
function executeLocal(script) {
  const lines = script.split(/\r?\n/);
  const results = [];
  const stdout = [];
  const stderr = [];
  let skipped = 0;

  lines.forEach((line, index) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    // 控制结构在受限解释器中无法执行，明确跳过而不是尝试解释
    if (/^(if|then|else|fi|for|while|do|done|case|esac|function|\}|\{)/.test(t)
      || /^[a-zA-Z_]+\(\)$/.test(t)) {
      skipped += 1;
      return;
    }
    // 变量赋值：记录但不执行副作用
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      skipped += 1;
      return;
    }
    const r = runLine(t, index);
    results.push(r);
    if (r.error) stderr.push(r.output);
    else if (!r.skipped) stdout.push(r.output);
    else {
      skipped += 1;
      stderr.push(`[第 ${index + 1} 行] ${r.output}`);
    }
  });

  return {
    exitCode: stderr.filter((l) => !l.includes('[第')).length ? 1 : 0,
    stdout: stdout.join('\n') || '(无标准输出)',
    stderr: stderr.join('\n'),
    skippedLines: skipped,
  };
}

/* --------------------------- Docker 后端 --------------------------- */

function run(cmd, args, { input = null, timeout = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGKILL');
        resolve({ code: -1, out, err: `${err}\n[exec] 执行超时（${timeout}ms）已被强制终止`.trim() });
      }
    }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: 127, out, err: `${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, out, err });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function executeDocker(script) {
  // 一次性容器：无网络、限内存/CPU/进程数，只读挂载工作区
  const args = [
    'run', '--rm', '-i',
    '--network=none',
    '--memory=256m',
    '--cpus=0.5',
    '--pids-limit=64',
    '-v', `${WORKSPACE}:/work:ro`,
    '-w', '/work',
    'alpine:3.19',
    'sh', '-s',
  ];
  const { code, out, err } = await run('docker', args, { input: script });
  return { exitCode: code, stdout: out || '(无标准输出)', stderr: err, backend: 'docker' };
}

/* --------------------------- 模拟后端 --------------------------- */

function simulate(script) {
  const lines = script.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const stdout = [];
  let skipped = 0;

  for (const [index, line] of lines.entries()) {
    const t = line.trim();
    const cmd = t.split(/\s+/)[0];
    // 先判只读命令，再判 shell 内建，两者都不是才拦截
    if (!READ_ONLY_COMMANDS.has(cmd) && !SAFE_BUILTINS.has(cmd)) {
      skipped += 1;
      stdout.push(`[第 ${index + 1} 行] 隔离环境拦截：${cmd} 不在只读命令白名单`);
      continue;
    }
    const r = runLine(t, index);
    if (r.skipped) skipped += 1;
    stdout.push(`$ ${t}\n${r.output}`);
  }

  return {
    exitCode: 0,
    stdout: stdout.join('\n') || '(无标准输出)',
    stderr: '',
    skippedLines: skipped,
    backend: 'mock',
    simulated: true,
  };
}

/* --------------------------- 统一入口 --------------------------- */

/**
 * 执行脚本 —— 只能由已批准的审批单驱动。
 *
 * @param {object} opts
 * @param {string} opts.script     脚本文本
 * @param {string} [opts.mode]     覆盖全局 EXEC_MODE
 * @param {string} opts.actor      操作人
 * @param {string} opts.approvalId 审批单 ID（审计关联用）
 */
export async function executeScript({ script, mode, actor, approvalId } = {}) {
  const target = (mode || EXEC_MODE).toLowerCase();
  const started = Date.now();

  // 二次门禁：即便审批单已批准，也必须在执行前重新校验一次
  const gate = gateScript(script);
  if (gate.level === 'blocked') {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: gate.reasons.join('；'),
      durationMs: Date.now() - started,
      mode: target,
      gate,
      denied: true,
    };
  }

  let result;
  if (target === 'docker') {
    result = await executeDocker(script);
  } else if (target === 'local') {
    if (!EXEC_ALLOW_LOCAL) {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: 'EXEC_MODE=local 未开启：需显式设置 EXEC_ALLOW_LOCAL=true',
        durationMs: Date.now() - started,
        mode: target,
        gate,
        denied: true,
      };
    }
    result = executeLocal(script);
  } else {
    result = simulate(script);
  }

  const stdout = String(result.stdout || '').slice(0, MAX_OUTPUT_CHARS);
  const stderr = String(result.stderr || '').slice(0, MAX_OUTPUT_CHARS);

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    mode: target,
    gate,
    skippedLines: result.skippedLines ?? 0,
    simulated: Boolean(result.simulated),
    actor: actor || null,
    approvalId: approvalId || null,
  };
}
