/**
 * Agent 编排核心（多轮「推理 -> 调用工具 -> 回灌结果 -> 再推理」循环）。
 *
 * 这一层是整个项目最关键的部分，它决定了 Agent 能不能真正完成任务：
 *   - 单轮把工具结果回灌后再问一次模型，模型才会「基于证据」作答；
 *   - 轮次上限防止模型反复取证打转（既防失控，也防费用爆炸）；
 *   - 达到上限时主动注入收敛指令，保证一定给用户一个答案，而不是沉默。
 *
 * 权限（阶段 5）：
 *   - 每次工具调用前按工具的 requiredPermission 做角色校验；
 *   - 校验失败不终止会话，而是把拒绝原因作为工具结果回灌给模型，
 *     让模型知道"这条路走不通"并改用其他方式（这也是真实 Agent 该有的行为）。
 */
import { config } from '../config.js';
import { chatComplete, LLMError } from '../llm/provider.js';
import { MODE_SYSTEM_PROMPT, FORCE_CONCLUDE_HINT } from '../llm/prompts.js';
import { TOOL_DEFINITIONS, runTool } from './tools.js';
import { pushMessage } from './session.js';
import { record } from '../audit.js';
import { assertCan, normalizeRole, can } from '../security/rbac.js';
import { normalizeError } from '../lib/errors.js';

export class AbortedError extends Error {
  constructor() {
    super('请求已被取消');
    this.name = 'AbortedError';
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new AbortedError();
}

/** 工具结果的体积闸门：防止单个大结果把上下文一次性灌满 */
function compactToolResult(toolResult) {
  const MAX_CHARS = 6000;
  const text = JSON.stringify(toolResult.result ?? { ok: false, error: toolResult.error, hint: toolResult.hint });
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}...(结果已截断)` : text;
}

/** 给前端展示的结果预览（不含完整时序点，避免 SSE 帧过大） */
function previewOf(toolResult) {
  if (!toolResult.ok) return { error: toolResult.error, hint: toolResult.hint };
  const r = toolResult.result;
  const copy = JSON.parse(JSON.stringify(r));
  if (Array.isArray(copy.points)) copy.points = `[${copy.points.length} 个采样点]`;
  if (Array.isArray(copy.lines) && copy.lines.length > 5) {
    copy.lines = [...copy.lines.slice(-5), `... 共 ${copy.lines.length} 行`];
  }
  if (typeof copy.content === 'string' && copy.content.length > 800) {
    copy.content = `${copy.content.slice(0, 800)}...(已截断)`;
  }
  return copy;
}

/**
 * 执行一次完整的 Agent 轮次。
 *
 * @param {object} opts
 * @param {object}   opts.session        会话对象（会被就地更新）
 * @param {string}   opts.input          用户输入
 * @param {string}   [opts.mode]         incident | script | agent
 * @param {boolean}  [opts.useTools]     是否挂载只读工具
 * @param {Function} opts.emit           事件推送回调（由路由层转成 SSE）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text:string, turns:number, toolCalls:number, finishReason:string}>}
 */
export async function runAgent({
  session, input, mode = 'incident', useTools = true, emit, signal,
  actor = 'anonymous', role = 'approver',
} = {}) {
  const systemPrompt = MODE_SYSTEM_PROMPT[mode] || MODE_SYSTEM_PROMPT.agent;
  const normalizedRole = normalizeRole(role);
  // 只读取证人人可用；写入/执行类工具额外需要对应权限，届时再校验
  const tools = useTools
    ? TOOL_DEFINITIONS.filter(
      (t) => t.readOnly || can(normalizedRole, t.requiredPermission || 'exec:sandbox'),
    )
    : [];
  const maxTurns = config.agent.maxTurns;

  const userMsg = { role: 'user', content: input };
  pushMessage(session, userMsg);
  record({
    type: 'user_message', sessionId: session.id, mode, chars: input.length, actor, role: normalizedRole,
  });

  let totalToolCalls = 0;
  let finishReason = 'stop';
  let answer = '';
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const ctx = {
    sessionId: session.id, mode, actor, role: normalizedRole,
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    checkAbort(signal);

    const messages = [{ role: 'system', content: systemPrompt }, ...session.messages];

    emit({ type: 'status', phase: 'thinking', turn, totalTurns: maxTurns });

    let result;
    try {
      result = await chatComplete({
        messages,
        tools,
        toolChoice: 'auto',
        previousResponseId: session.responseId,
        task: mode,
        signal,
        onText: (text) => {
          answer += text;
          emit({ type: 'delta', text, turn });
        },
        onToolArgs: () => {
          /* 增量参数仅用于真实模型的流式展示占位，本项目在拿到完整调用后统一展示 */
        },
      });
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      const detail = err instanceof LLMError ? `${err.message}（HTTP ${err.status}）${err.payload ? `\n${err.payload}` : ''}` : err.message;
      emit({ type: 'error', code: 'LLM_ERROR', message: detail });
      session.stats.errors += 1;
      record({ type: 'llm_error', sessionId: session.id, mode, message: err.message });
      throw err;
    }

    usage.promptTokens += result.usage.promptTokens;
    usage.completionTokens += result.usage.completionTokens;
    usage.totalTokens += result.usage.totalTokens;
    if (result.responseId) session.responseId = result.responseId;

    // 把助手本轮的输出（含可能的工具调用）写入会话
    const assistantMsg = { role: 'assistant', content: result.content || null };
    if (result.toolCalls.length) {
      assistantMsg.tool_calls = result.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    pushMessage(session, assistantMsg);

    /* ---- 没有工具调用 = 已给出结论 ---- */
    if (!result.toolCalls.length) {
      finishReason = result.finishReason || 'stop';
      emit({ type: 'usage', usage, total: usage });
      break;
    }

    /* ---- 执行工具并回灌结果 ---- */
    emit({ type: 'status', phase: 'tool_execution', turn, count: result.toolCalls.length });

    // 说明：这里串行执行，UI 能按取证顺序逐条展示；若追求延迟可改成 Promise.all 并发。
    for (const call of result.toolCalls) {
      checkAbort(signal);
      totalToolCalls += 1;
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(call.arguments || '{}');
      } catch {
        parsedArgs = { _raw: call.arguments };
      }

      emit({ type: 'tool_start', id: call.id, name: call.name, args: parsedArgs, turn });

      let toolResult;
      let deniedByPermission = false;
      try {
        // 权限闸门：写入/执行类工具必须校验角色，失败直接抛错
        const def = TOOL_DEFINITIONS.find((t) => t.name === call.name);
        if (def?.requiredPermission) {
          assertCan(normalizedRole, def.requiredPermission, `调用工具 ${call.name}`);
        }
        toolResult = await runTool(call.name, call.arguments, ctx);
      } catch (err) {
        deniedByPermission = true;
        const appErr = normalizeError(err);
        toolResult = {
          ok: false,
          name: call.name,
          error: appErr.message,
          hint: appErr.hint || null,
          code: appErr.code,
          ms: 0,
        };
      }

      emit({
        type: 'tool_result',
        id: call.id,
        name: call.name,
        ok: toolResult.ok,
        ms: toolResult.ms,
        denied: deniedByPermission,
        preview: previewOf(toolResult),
        turn,
      });

      // 审计：每一次工具调用都必须留痕（阶段 4/5 的权限与回溯依赖它）
      record({
        type: deniedByPermission ? 'tool_denied' : 'tool_call',
        sessionId: session.id,
        tool: call.name,
        args: parsedArgs,
        ok: toolResult.ok,
        ms: toolResult.ms,
        actor,
        role: normalizedRole,
        error: toolResult.error || null,
      });

      if (toolResult.ok) session.stats.toolCalls += 1;
      else session.stats.errors += 1;

      pushMessage(session, {
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: compactToolResult(toolResult),
      });
    }

    session.stats.turns += 1;

    /* ---- 轮次用尽：强制收敛出结论 ---- */
    if (turn === maxTurns) {
      emit({ type: 'status', phase: 'concluding', turn, totalTurns: maxTurns });
      try {
        const finalResult = await chatComplete({
          messages: [
            { role: 'system', content: systemPrompt },
            ...session.messages,
            { role: 'user', content: FORCE_CONCLUDE_HINT },
          ],
          tools: [],
          task: mode,
          signal,
          onText: (text) => {
            answer += text;
            emit({ type: 'delta', text, turn: turn + 1 });
          },
        });
        usage.promptTokens += finalResult.usage.promptTokens;
        usage.completionTokens += finalResult.usage.completionTokens;
        usage.totalTokens += finalResult.usage.totalTokens;
        pushMessage(session, { role: 'assistant', content: finalResult.content || null });
        finishReason = 'max_turns';
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        emit({ type: 'error', code: 'CONCLUDE_ERROR', message: err.message });
        finishReason = 'max_turns_error';
      }
      emit({ type: 'usage', usage, total: usage });
      break;
    }
  }

  const summary = {
    text: answer,
    turns: session.stats.turns,
    toolCalls: totalToolCalls,
    finishReason,
    usage,
  };
  emit({ type: 'done', ...summary });
  record({ type: 'agent_done', sessionId: session.id, mode, toolCalls: totalToolCalls, finishReason });
  return summary;
}
