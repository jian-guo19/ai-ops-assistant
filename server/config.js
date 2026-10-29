/**
 * 统一配置层。
 *
 * 设计要点：
 * 1. 零第三方依赖，自己解析 .env（少一个依赖就少一个安装失败点）。
 * 2. 所有敏感值只出现在服务端进程环境里，不写入任何前端代码。
 * 3. LLM_MODE = auto 时：检测到 API Key 就走真实模型，否则自动降级到本地演示模式，
 *    保证没有 Key 也能完整跑通界面与流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/** 极简 .env 解析：支持 KEY=VALUE、# 注释、引号包裹，不覆盖已有环境变量 */
function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv(path.join(ROOT, '.env'));

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const rawMode = (process.env.LLM_MODE || 'auto').toLowerCase();
const apiKey = (process.env.OPENAI_API_KEY || '').trim();

export const config = {
  port: int(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',

  llm: {
    // auto | live | mock
    mode: ['auto', 'live', 'mock'].includes(rawMode) ? rawMode : 'auto',
    // chat_completions | responses —— 两种 OpenAI 协议都实现，便于对比学习
    protocol:
      process.env.LLM_PROTOCOL === 'responses' ? 'responses' : 'chat_completions',
    apiKey,
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: Number.parseFloat(process.env.OPENAI_TEMPERATURE ?? '0.2'),
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 60000),
  },

  agent: {
    // 单轮对话最多进行多少轮「模型决策 -> 工具执行」循环，防止失控或费用失控
    maxTurns: int(process.env.AGENT_MAX_TURNS, 6),
    maxToolCallsPerTurn: int(process.env.AGENT_MAX_TOOL_CALLS, 24),
    maxHistoryMessages: int(process.env.AGENT_MAX_HISTORY, 40),
    toolTimeoutMs: int(process.env.TOOL_TIMEOUT_MS, 8000),
  },

  paths: {
    root: ROOT,
    sandbox: path.join(ROOT, 'sandbox'),
    data: path.join(ROOT, 'data'),
    auditLog: path.join(ROOT, 'data', 'audit.log'),
  },

  security: {
    // 只读工具允许访问的根目录白名单（路径穿越防护的第一道闸门）
    allowedReadRoots: [
      path.join(ROOT, 'sandbox'),
      path.join(ROOT, 'samples'),
    ],
    // 单次日志检索返回的最大行数，避免一次把大文件刷满上下文
    maxLogLines: int(process.env.MAX_LOG_LINES, 200),
    auditEnabled: bool(process.env.AUDIT_ENABLED, true),
  },
};

/** 实际运行模式：auto 模式下根据有无 Key 自动判定 */
export function resolveMode() {
  if (config.llm.mode === 'mock') return 'mock';
  if (config.llm.mode === 'live') {
    return config.llm.apiKey ? 'live' : 'mock';
  }
  return config.llm.apiKey ? 'live' : 'mock';
}

/** 给前端展示的脱敏配置（绝不下发 apiKey） */
export function publicRuntimeInfo() {
  return {
    mode: resolveMode(),
    protocol: config.llm.protocol,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    hasApiKey: Boolean(config.llm.apiKey),
    maxTurns: config.agent.maxTurns,
  };
}
