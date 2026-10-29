/**
 * 统一错误模型（阶段 5）。
 *
 * 为什么需要：Agent 系统的错误处理最怕「一个 try/catch 兜所有」——
 * 模型超时该重试、参数不合法该提示用户改、权限不足该拒绝并记录，
 * 这些行为完全不同。统一错误码让上层可以据此决定重试、告警还是直接失败。
 *
 * 约定：
 *   - code：稳定枚举，前端与日志都依赖它，不要随意改名
 *   - httpStatus：HTTP 语义
 *   - retryable：是否值得自动重试（超时=是，参数错=否）
 *   - hint：给用户的可执行建议，而不是内部堆栈
 */
export class AppError extends Error {
  constructor(code, message, { httpStatus = 500, retryable = false, hint = null, detail = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.hint = hint;
    this.detail = detail;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      retryable: this.retryable,
      hint: this.hint,
      detail: this.detail,
    };
  }
}

export const Errors = {
  badRequest: (message, hint = null) =>
    new AppError('BAD_REQUEST', message, { httpStatus: 400, hint }),

  payloadTooLarge: (message, hint = null) =>
    new AppError('PAYLOAD_TOO_LARGE', message, { httpStatus: 413, hint }),

  forbidden: (message, hint = null) =>
    new AppError('FORBIDDEN', message, { httpStatus: 403, hint }),

  notFound: (message, hint = null) =>
    new AppError('NOT_FOUND', message, { httpStatus: 404, hint }),

  llmUnavailable: (message, detail = null) =>
    new AppError('LLM_UNAVAILABLE', message, {
      httpStatus: 502,
      retryable: true,
      hint: '检查 OPENAI_API_KEY / OPENAI_BASE_URL 是否正确，或稍后重试',
      detail,
    }),

  toolTimeout: (tool) =>
    new AppError('TOOL_TIMEOUT', `工具 ${tool} 执行超时`, {
      httpStatus: 504,
      retryable: true,
      hint: '缩小查询范围（减少 lines / minutes）后重试',
    }),

  execDenied: (message, hint = null) =>
    new AppError('EXEC_DENIED', message, { httpStatus: 403, retryable: false, hint }),

  internal: (message, detail = null) =>
    new AppError('INTERNAL', message, { httpStatus: 500, detail }),
};

/** 把任意异常收敛成 AppError，避免内部堆栈外泄 */
export function normalizeError(err) {
  if (err instanceof AppError) return err;
  if (err?.name === 'AbortError') {
    return new AppError('ABORTED', '请求已取消', { httpStatus: 499 });
  }
  return Errors.internal(err?.message || '未知错误', err?.stack ? String(err.stack).slice(0, 500) : null);
}
