/**
 * SSE（Server-Sent Events）解析器。
 *
 * 为什么手写而不用 SDK：
 *   1. 零依赖，避免安装失败与版本地狱；
 *   2. 流式协议本身是本项目要理解的核心知识点，手搓一遍最扎实；
 *   3. OpenAI 兼容的中转站行为各异，自己解析更容易做容错。
 *
 * 关键陷阱：网络分包不按行切。一个 TCP 包可能只到半行，也可能塞了三行，
 * 所以必须用缓冲区累积，按 "\n\n" 边界切分，而不是逐 chunk 处理。
 */

/** 把 /r/n/r/n 与 /n/n 统一成一种边界 */
function normalize(raw) {
  return raw.replace(/\r\n/g, '\n');
}

/** 解析单个 SSE 事件块 -> { event, data, id } */
function parseEventBlock(block) {
  const result = { event: 'message', data: '', id: null };
  const lines = block.split('\n');
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // 心跳注释行
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim();
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') result.event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') result.id = value;
  }
  result.data = dataLines.join('\n');
  return result;
}

/**
 * 把 Response 的可读流转成 SSE 事件异步迭代器。
 * @param {Response} response fetch 的响应对象
 * @yields {{event:string, data:string}}
 */
export async function* parseSSEStream(response) {
  if (!response.body) {
    throw new Error('响应没有可读的 body，无法流式解析');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += normalize(decoder.decode(value, { stream: true }));

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim()) yield parseEventBlock(block);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) yield parseEventBlock(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 忽略取消异常 */
    }
  }
}

/** 判断 SSE data 是否为流结束标记 */
export function isDoneSignal(data) {
  return data.trim() === '[DONE]';
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
