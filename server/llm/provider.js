/**
 * OpenAI 兼容接入层（同时实现 Chat Completions 与 Responses 两种流式协议）。
 *
 * 归一化产出，让上层 Agent 循环不关心底层协议：
 *   {
 *     content: string,
 *     toolCalls: [{ id, name, arguments }],
 *     finishReason: 'stop' | 'tool_calls' | ...,
 *     usage: { promptTokens, completionTokens, totalTokens },
 *     responseId: string | null,   // Responses API 的服务端会话锚点
 *   }
 *
 * 知识点对照：
 *   - Chat Completions：工具走 messages 数组里的 role=tool 回灌，属于「客户端自管状态」。
 *   - Responses API：可用 previous_response_id 让服务端记住上下文，属于「服务端托管状态」。
 *     本项目默认自管历史（兼容性最好、可审计），同时保留 previous_response_id 透传能力。
 */
import { config } from '../config.js';
import { parseSSEStream, isDoneSignal, safeJsonParse } from '../lib/sse.js';
import { chatCompleteMock } from './mock.js';

export class LLMError extends Error {
  constructor(message, { status = null, protocol = '', payload = null } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.protocol = protocol;
    this.payload = payload;
  }
}

/* ------------------------------------------------------------------ *
 * 工具 Schema 转换
 * ------------------------------------------------------------------ */

/** 内部统一格式 -> Chat Completions 的 tools 格式 */
export function toChatTools(tools = []) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** 内部统一格式 -> Responses API 的 tools 格式（扁平结构，没有 function 嵌套） */
export function toResponsesTools(tools = []) {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/* ------------------------------------------------------------------ *
 * 请求构造
 * ------------------------------------------------------------------ */

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.llm.apiKey}`,
    Accept: 'text/event-stream',
  };
}

/**
 * 构造请求体。
 * variant = 'full' 使用全部能力字段；'minimal' 剔除兼容性差的字段，用于降级重试。
 * 很多 OpenAI 兼容中转站不支持 parallel_tool_calls / stream_options / tool_choice，
 * 一旦 400 就降级重试一次，能显著提升"换个中转站也能跑"的成功率。
 */
function buildBody({ protocol, variant, messages, tools, toolChoice, previousResponseId }) {
  const minimal = variant === 'minimal';
  const { model, temperature } = config.llm;
  const hasTools = tools && tools.length > 0;

  if (protocol === 'responses') {
    const { instructions, input } = toResponsesInput(messages, Boolean(previousResponseId));
    const body = { model, instructions, input, stream: true };
    if (hasTools) body.tools = toResponsesTools(tools);
    if (!minimal && temperature !== undefined) body.temperature = temperature;
    if (previousResponseId) body.previous_response_id = previousResponseId;
    return body;
  }

  const body = { model, messages, stream: true };
  if (!minimal) {
    body.temperature = temperature;
    body.stream_options = { include_usage: true };
  }
  if (hasTools) {
    body.tools = toChatTools(tools);
    if (!minimal) {
      body.tool_choice = toolChoice || 'auto';
      body.parallel_tool_calls = true;
    }
  }
  return body;
}

/**
 * 把 Chat Completions 形态的 messages 转成 Responses API 的 input/instructions。
 * @param {Array} messages
 * @param {boolean} incremental  true 表示启用 previous_response_id，只携带增量消息
 */
export function toResponsesInput(messages, incremental = false) {
  const instructions = [];
  const source = incremental ? messages.filter((m) => m.role === 'user' || m.role === 'tool').slice(-2) : messages;
  const input = [];
  /** call_id 映射：tool 消息需要回指到它对应的 function_call item */
  const callIndex = new Map();

  // 先扫一遍 assistant tool_calls，建立 id -> call_id 映射
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id) callIndex.set(tc.id, tc.id);
      }
    }
  }

  for (const m of source) {
    if (m.role === 'system' || m.role === 'developer') {
      instructions.push(typeof m.content === 'string' ? m.content : '');
      continue;
    }
    if (m.role === 'user') {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content || '' }] });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const tc of m.tool_calls || []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || '{}',
        });
      }
      continue;
    }
    if (m.role === 'tool') {
      const callId = callIndex.get(m.tool_call_id) || m.tool_call_id;
      input.push({ type: 'function_call_output', call_id: callId, output: String(m.content ?? '') });
    }
  }
  return { instructions: instructions.join('\n\n').trim(), input };
}

/* ------------------------------------------------------------------ *
 * HTTP + 流式处理
 * ------------------------------------------------------------------ */

async function post(url, bodyObj, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), timeoutMs || config.llm.timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 常见的兼容性错误关键词 -> 触发 minimal 重试 */
function looksLikeCompatError(status, text) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /parallel_tool_calls|tool_choice|stream_options|temperature|previous_response_id/i.test(text || '');
}

/* ------------------------------------------------------------------ *
 * Chat Completions 协议
 * ------------------------------------------------------------------ */
async function runChatCompletions({ messages, tools, toolChoice, previousResponseId, callbacks, signal }) {
  const url = `${config.llm.baseUrl}/chat/completions`;
  let response = await post(url, buildBody({ protocol: 'chat_completions', variant: 'full', messages, tools, toolChoice, previousResponseId }), { signal });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (looksLikeCompatError(response.status, text)) {
      response = await post(url, buildBody({ protocol: 'chat_completions', variant: 'minimal', messages, tools, toolChoice, previousResponseId }), { signal });
    }
    if (!response.ok) {
      const retryText = await response.text().catch(() => '');
      throw new LLMError('模型服务返回错误', {
        status: response.status,
        protocol: 'chat_completions',
        payload: (retryText || text || '').slice(0, 800),
      });
    }
  }

  let content = '';
  const toolAccum = new Map(); // index -> { id, name, arguments }
  let finishReason = null;
  let usage = null;

  for await (const ev of parseSSEStream(response)) {
    const data = ev.data;
    if (!data || isDoneSignal(data)) continue;
    const chunk = safeJsonParse(data);
    if (!chunk) continue;

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }
    if (chunk.id && !usage) {
      // 记录 response id，备用（也可作为链路追踪标识）
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      callbacks.onText?.(delta.content);
    }

    for (const piece of delta.tool_calls || []) {
      const idx = piece.index ?? 0;
      const acc = toolAccum.get(idx) || { id: '', name: '', arguments: '' };
      if (piece.id) acc.id += piece.id;
      if (piece.function?.name) acc.name += piece.function.name;
      if (piece.function?.arguments) {
        acc.arguments += piece.function.arguments;
        callbacks.onToolArgs?.({ id: acc.id, name: acc.name, delta: piece.function.arguments });
      }
      toolAccum.set(idx, acc);
    }
  }

  const toolCalls = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments || '{}' }));

  return {
    content,
    toolCalls,
    finishReason: toolCalls.length ? 'tool_calls' : finishReason || 'stop',
    usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    responseId: null,
    protocol: 'chat_completions',
  };
}

/* ------------------------------------------------------------------ *
 * Responses API 协议
 * ------------------------------------------------------------------ */
async function runResponses({ messages, tools, toolChoice, previousResponseId, callbacks, signal }) {
  const url = `${config.llm.baseUrl}/responses`;
  let response = await post(url, buildBody({ protocol: 'responses', variant: 'full', messages, tools, toolChoice, previousResponseId }), { signal });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (looksLikeCompatError(response.status, text)) {
      response = await post(url, buildBody({ protocol: 'responses', variant: 'minimal', messages, tools, toolChoice, previousResponseId }), { signal });
    }
    if (!response.ok) {
      const retryText = await response.text().catch(() => '');
      throw new LLMError('模型服务返回错误', {
        status: response.status,
        protocol: 'responses',
        payload: (retryText || text || '').slice(0, 800),
      });
    }
  }

  let content = '';
  const calls = []; // { id, name, arguments }
  let usage = null;
  let finishReason = 'stop';
  let responseId = null;

  for await (const ev of parseSSEStream(response)) {
    if (!ev.data || isDoneSignal(ev.data)) continue;
    const payload = safeJsonParse(ev.data);
    if (!payload) continue;
    const type = payload.type || ev.event;

    if (type === 'response.created' || type === 'response.completed') {
      if (payload.response?.id) responseId = payload.response.id;
    }

    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      content += payload.delta;
      callbacks.onText?.(payload.delta);
      continue;
    }

    if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
      calls.push({
        id: payload.item.call_id || payload.item.id,
        name: payload.item.name,
        arguments: payload.item.arguments || '',
      });
      continue;
    }

    if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
      const target = calls.find((c) => c.id === payload.item_id) || calls[calls.length - 1];
      if (target) {
        target.arguments += payload.delta;
        callbacks.onToolArgs?.({ id: target.id, name: target.name, delta: payload.delta });
      }
      continue;
    }

    if (type === 'response.completed' && payload.response?.usage) {
      const u = payload.response.usage;
      usage = {
        promptTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
        completionTokens: u.output_tokens ?? u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? 0,
      };
    }
  }

  if (calls.length) finishReason = 'tool_calls';

  return {
    content,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || '{}' })),
    finishReason,
    usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    responseId,
    protocol: 'responses',
  };
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

/**
 * 发起一次带工具能力的对话请求。
 *
 * @param {object}   opts
 * @param {Array}    opts.messages          OpenAI chat 形态的消息数组
 * @param {Array}    [opts.tools]           内部统一格式的工具定义
 * @param {string}   [opts.toolChoice]      auto | none | required
 * @param {string}   [opts.previousResponseId] Responses API 的服务端会话锚点
 * @param {Function} [opts.onText]          文本增量回调（用于 SSE 推送给前端）
 * @param {Function} [opts.onToolArgs]      工具参数增量回调
 * @param {AbortSignal} [opts.signal]
 * @param {string}   [opts.task]            任务类型，仅 Mock 引擎使用：incident | script | agent
 * @returns {Promise<object>} 归一化结果
 */
export async function chatComplete(opts) {
  const {
    messages = [],
    tools = [],
    toolChoice = 'auto',
    previousResponseId = null,
    onText,
    onToolArgs,
    signal,
    task = 'agent',
  } = opts;

  if (process.env.FORCE_MOCK === '1' || !config.llm.apiKey) {
    return chatCompleteMock({ messages, tools, onText, task, signal });
  }

  const callbacks = { onText, onToolArgs };

  if (config.llm.protocol === 'responses') {
    return runResponses({ messages, tools, toolChoice, previousResponseId, callbacks, signal });
  }
  return runChatCompletions({ messages, tools, toolChoice, previousResponseId, callbacks, signal });
}
