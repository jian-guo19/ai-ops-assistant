/**
 * 服务入口。
 *
 * 职责边界：只做「装配与生命周期」，不放任何业务逻辑。
 * 业务分别在 routes/（协议）、agent/（编排）、tools/（能力）、llm/（模型）四层。
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/api.js';
import { config, ROOT, publicRuntimeInfo, resolveMode } from './config.js';
import { sweepExpired } from './agent/session.js';
import { record } from './audit.js';
import { normalizeError } from './lib/errors.js';
import { flushApprovals } from './agent/approval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');

/* --------------------------- 基础中间件 --------------------------- */

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 跨域默认关闭：本地 demo 走同源静态托管即可。
// 若前端独立开发（如 Vite dev server），设置 CORS_ORIGIN=http://localhost:5173 后生效。
if (process.env.CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (!req.path.startsWith('/api/health')) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

/* ------------------------------ 能力挂载 ------------------------------ */

app.use('/api', apiRouter);

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      // 页面本身不被缓存，保证改动立刻生效
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `接口不存在：${req.path}` });
  }
  // 非 API 路径一律回退到首页（单页应用路由）。
  // 注意这里返回 200 而不是 404：静态资源已由上面的 static 中间件处理过，
  // 能走到这里的都是前端路由，返回 404 会让 SPA 表现异常。
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const appErr = normalizeError(err);
  const status = appErr.httpStatus >= 400 && appErr.httpStatus < 600 ? appErr.httpStatus : 500;
  console.error(`[server error] ${req.method} ${req.path} ${status} ${appErr.code}: ${appErr.message}`);
  res.status(status).json({
    error: appErr.message,
    code: appErr.code,
    retryable: appErr.retryable,
    hint: appErr.hint,
  });
});

/* ------------------------------ 生命周期 ------------------------------ */

const server = app.listen(config.port, config.host, () => {
  const rt = publicRuntimeInfo();
  console.log('');
  console.log('  AI 运维故障分析与脚本助手 已启动');
  console.log('  ------------------------------------------');
  console.log(`  访问地址   : http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`);
  console.log(`  模型模式   : ${rt.mode === 'mock' ? '演示模式（未检测到 API Key）' : '真实模型'}`);
  console.log(`  协议       : ${rt.protocol}`);
  console.log(`  模型       : ${rt.model}`);
  console.log(`  Agent 轮次 : ${rt.maxTurns}`);
  console.log(`  数据目录   : ${ROOT}`);
  console.log('');
  record({ type: 'server_start', mode: resolveMode(), protocol: rt.protocol, model: rt.model });
});

// 会话回收：长时间未活动的会话会被清理，避免内存无上限增长
const sweeper = setInterval(() => {
  const { swept } = sweepExpired();
  if (swept > 0) console.log(`[session] 已回收 ${swept} 个过期会话`);
}, 30 * 60 * 1000);
sweeper.unref?.();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用，请用 PORT=xxxx npm start 换一个端口`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在优雅退出...`);
  record({ type: 'server_stop', signal });
  flushApprovals(); // 退出前把审批单落盘，避免丢失
  clearInterval(sweeper);
  server.close(() => {
    console.log('服务已停止');
    process.exit(0);
  });
  // 兜底：超过 5 秒强制退出，避免 SSE 长连接导致挂住
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
