# AI 运维故障分析与脚本助手（阶段 1-5 全部落地）

> 想深入看设计原理，读 **[docs/技术设计文档.md](docs/技术设计文档.md)**：
> 按"这个系统能做什么 → 它怎么做到的 → 为什么这么设计"三层展开，含 7 个关键设计决策的取舍分析。
>
> 只想知道**怎么用、规则是什么、边界在哪**，读 **[docs/使用规则与能力说明.md](docs/使用规则与能力说明.md)**：
> 能力清单、五类使用规则、门禁与体检规则全表、六条能力边界。

一个可本地运行的运维 Agent 应用：**日志告警分析 → Shell 脚本校错 → 只读工具取证 →
生成脚本 → 人工审批 → 隔离环境执行**，全程人工确认、全程审计留痕。
没有 API Key 也能完整跑通界面与流程（内置演示模式）。

```
┌────────────────────────── 浏览器（原生 HTML/CSS/JS）──────────────────────────┐
│ 故障分析  脚本校错  工具沙箱  自动化运维（生成→门禁→审批→隔离执行）  审计抽屉 │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ POST /api/chat  (SSE: delta / tool_start / tool_result / done)
┌───────────────▼──────────────────────────────────────────────────────────────┐
│ Express 路由层   Agent 编排循环（含权限过滤）  会话状态（内存+TTL）  审计    │
├───────────────────────────────────────────────────────────────────────────────┤
│ 安全层：RBAC 权限矩阵（viewer/operator/approver/admin）+ 静态高危门禁        │
│ 审批层：draft→pending→approved/rejected→executed，提交人不可自批             │
│ 执行层：mock（默认·模拟）/ docker（--network=none 限额）/ local（受限解释器） │
│ LLM 层：OpenAI 兼容双协议（Chat Completions / Responses API）+ 演示引擎      │
│ 工具层：9 只读 + 4 写操作（共 13），读写分组，路径白名单防护                │
│ 数据层：sandbox/ 确定性模拟数据（可一键替换为 Prometheus / Zabbix / 云监控） │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
# 1. 安装依赖（仅 express，无其他运行时依赖）
npm install

# 2. 直接启动 —— 没配 Key 会自动进入"演示模式"
npm start
# 打开 http://127.0.0.1:8787

# 3. 接真实模型：复制 .env.example 为 .env，填入 Key 即可
cp .env.example .env
#   OPENAI_API_KEY=sk-xxx
#   OPENAI_BASE_URL=https://api.openai.com/v1     # 官方或任意 OpenAI 兼容网关
#   OPENAI_MODEL=gpt-4o-mini
#   LLM_PROTOCOL=chat_completions                  # 或 responses

# 4. 测试
npm test                      # 后端冒烟：74 项断言，覆盖五大阶段与安全/权限/审批护栏
node test/unit-exec.mjs       # 门禁与执行器单元测试（免起服务）
node test/browser-check.mjs   # 前端浏览器冒烟：41 项（需先 npm i --no-save playwright-core）
node test/capture.mjs         # 全流程界面截图 -> docs/shots/（需先 npm start）
```

> 想看效果：直接 `npm start` 打开页面，切到「自动化运维」标签页，
> 从场景下拉选一条 → 生成脚本 → 看门禁结论 → 提交审批 → **换一个身份**点批准 → 执行。
> 全程不需要 API Key。

演示模式下，Agent 依然会真实执行「规划工具 → 取证 → 回灌 → 成文」的多轮循环，
只是"推理"由本地规则引擎完成——链路、事件流、界面与真实模型完全一致。

## 五个阶段的实现方式

### 阶段 1 · 故障分析（输入日志/告警 → 可能原因 + 排查步骤）

- 输出固定结构：**结论摘要 / 证据链 / 可能原因（按可能性排序）/ 排查步骤 / 修复建议 / 还需补充的信息**；
- 每条结论必须引用工具返回的指标数值或日志原文，不允许无依据输出；
- 内置 5 个演示场景（磁盘写满 / Java OOM / 慢查询暴涨 / Redis 下线 / 网关 502），点击即填入。

### 阶段 2 · 脚本校错（AI 检查 → 你确认后才修改）

采用「确定性规则 + AI 语义补充 + 人工确认」三段式：

1. **本地静态体检**（`server/lib/shell-lint.js`，毫秒级）：识别 rm -rf 变量未加引号、
   `curl | bash`、明文口令、`|| true` 吞错、`kill -9`、缺 `set -euo pipefail`、缺回滚等 20+ 类风险；
2. **AI 审查**：按约定 JSON Schema 返回 `{summary, overall_risk, issues[{severity,line,risk,suggestion,patch}]}`；
3. **人工确认**：每条修复先生成 **diff 预览**，点「确认应用到编辑器」才会落地，原文件永不被直接改写。

每条补丁是 `{type:'replace', find, replace}` 或 `{type:'insert', anchor, position, text}`，
前端逐字定位替换，避免让 AI 自由改写整份文件。

### 阶段 3 · 工具调用（只读取证）

只读工具 9 个：`list_hosts` / `query_metrics` / `get_alerts` / `query_logs` /
`check_services` / `top_processes` / `read_file` / `get_current_time` / `list_approvals`。

安全红线（写死在代码里，不靠提示词约束）：

- 只读工具服务端不存在任何 `exec/spawn/write` 分支；
- `read_file`/`query_logs` 走 **路径白名单**（sandbox/ 与 samples/），任何 `..` 穿越直接拒绝；
- 工具结果统一截断，防止单次大结果撑爆模型上下文；
- 每次工具调用写入 append-only 审计日志（`data/audit.log`）。

错误处理模式：工具报错不终止会话，而是把错误文本回灌给模型，让它依据
「可用 source 列表」自我纠正重试——这是真实 Agent 的关键能力。

### 阶段 4 · 自动化运维（生成 → 审批 → 隔离执行）

四步走，每一步都有不可跳过的卡口：

```
意图 → ①生成草稿 → ②静态门禁 → ③提交审批（他人批准）→ ④隔离执行
         scriptgen      gate          approval            executor
         ↑ 带安全骨架    ↑ 高危直接拒   ↑ 职责分离          ↑ 只认 approval_id
```

**① 生成（`server/agent/scriptgen.js`）**
6 个内置模板（日志清理 / 重启服务 / 磁盘巡检 / 配置备份 / 健康检查 / 诊断采集），
按意图关键词匹配。生成的脚本自带：

- `set -euo pipefail`；
- `trap ... EXIT` 清理与退出码捕获；
- **默认 dry-run**——必须显式 `--apply` 才真正落地操作。

**② 静态门禁（`gateScript()` in `server/agent/executor.js`）**
两级判定：

| 级别 | 处理 | 命中示例 |
|---|---|---|
| `blocked` | 直接拒绝入库，返回 `403 GATE_BLOCKED` | `rm -rf`、`mkfs`、`dd`、`shutdown/reboot`、`curl \| bash`、`chmod 777`、`DROP TABLE`、`DELETE` 无 `WHERE`、停/禁用服务 |
| `needs_approval` | 允许入库，但**必须**人工批准才可执行 | `find -delete`、`systemctl restart`、`kill`、`cp -f`/`mv -f` |

匹配前先做**引号感知的注释剥离**（`stripComments()`）。这一步修掉了一个真实误判：
日志清理模板的注释里写了「用 `find -delete` 而不是 `rm -rf`」，导致脚本被自己的注释判死。

**③ 审批（`server/agent/approval.js`）**

状态机：`draft → pending → approved / rejected → executed`，外加 `denied`（在门禁处被拒，从未入库）。

**职责分离**：提交人不能批准自己提交的变更（HTTP 层与工具层双重拦截，
`ALLOW_SELF_APPROVAL=1` 可在演示时放开）。测试里专门验证：自己提交后批准按钮禁用，
换个人再批准才通过。

**④ 隔离执行（`executeScript()` in `server/agent/executor.js`）**

三种模式，`EXEC_MODE` 控制，默认 `mock`：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `mock` | 逐行模拟输出，标注 `simulated: true`，**零副作用** | 演示、CI、默认 |
| `docker` | `docker run --rm --network=none --memory --cpus --pids-limit` 一次性容器 | 真要跑脚本 |
| `local` | 受限解释器，只认只读命令与 shell 内建，**永不调用系统 shell** | 无 Docker 环境 |

**关键设计：`execute_approved` 只接受 `approval_id`，不接受脚本文本。**
执行路径上没有任何"传入任意脚本直接执行"的分支——接口形状本身就是防绕过的。
执行前还会**重跑一遍门禁**，并重新校验状态为 `approved`。

即使拿到 `exec:sandbox` 权限，能执行的也只是"别人提交、别人批准过、且通过门禁"的那份脚本。

### 阶段 5 · 业务落地

**权限控制（`server/security/rbac.js`）**

| 角色 | 权限 |
|---|---|
| `viewer` 观察员 | 查看分析、调用只读工具、脚本体检、读审计 |
| `operator` 运维执行 | + 生成脚本、提交审批 |
| `approver` 变更审批人 | + 审批决策、隔离执行 |
| `admin` 管理员 | 全部（演示用，生产建议再拆细） |

- 每个工具在定义里声明 `requiredPermission`，不是散落在 handler 里的 if；
- **Agent 循环按角色过滤可用工具**——没有权限的工具根本不会出现在给模型的工具列表里；
- 工具调用被拒时，把"权限不足"作为结果回灌给模型，而不是中断会话，让模型自己换路子；
- 未知角色一律降级为 `viewer`（最小权限原则）；
- 前端只是把没权限的按钮置灰，**真正的边界在服务端**——直接发 HTTP 请求一样被拒。

顶栏可切换身份：改角色后按钮即时置灰/恢复，用来演示权限矩阵确实生效。

**审计（`server/audit.js`）**

- append-only JSONL（`data/audit.log`），**同步写入**——调用返回时记录已落盘；
  早期用异步 `appendFile` 导致测试读不到刚写的记录，已修；
- 每条含：`ts / type / actor / role / 入参 / 结果 / 耗时`；
- 覆盖 `chat` / `tool_call` / `tool_denied` / `approval_submit` / `approval_decision` / `exec_finished`；
- 抽屉支持按类型过滤，`GET /api/audit/export` 导出 JSONL。

**错误处理（`server/lib/errors.js`）**

统一 `AppError`：带 `code`、`httpStatus`、`retryable`、`hint`。
前端按 `retryable` 决定要不要给出"重试"按钮，而不是对所有错误一视同仁。

400 参数错 / 403 权限或门禁拒绝 / 404 未知接口 / 502 模型不可用 / 504 工具超时，
全部走同一个 `{error, code, retryable, hint}` 结构。

## 核心知识点在哪里

| 知识点 | 位置 | 说明 |
|---|---|---|
| SSE 流式解析（手写） | `server/lib/sse.js`、`public/app.js` | 分包不按行切，必须用缓冲区按 `\n\n` 边界切分 |
| OpenAI 双协议 | `server/llm/provider.js` | Chat Completions 与 Responses API 的流式事件、工具 Schema 格式差异、`previous_response_id` 服务端托管会话 |
| 函数调用（多轮编排） | `server/agent/loop.js` | 推理→调用→回灌→再推理；轮次上限；达到上限注入收敛指令 |
| 兼容性降级重试 | `server/llm/provider.js` | 中转站不支持 `parallel_tool_calls`/`stream_options` 时自动剔除重试 |
| 会话状态管理 | `server/agent/session.js` | 历史裁剪、tool 消息不可孤立、TTL 回收 |
| 工具 JSON Schema | `server/agent/tools.js` | 参数校验、错误即回灌、结果截断 |
| Prompt 工程 | `server/llm/prompts.js` | 三种模式独立系统提示词，脚本审查强制 JSON 输出 |
| 审计留痕 | `server/audit.js` | append-only JSONL，同步写入，可接 SIEM |
| **RBAC 权限矩阵** | `server/security/rbac.js` | 角色→权限映射，工具声明式授权，未知角色降级 |
| **审批状态机** | `server/agent/approval.js` | 状态流转 + 职责分离，提交人不可自批 |
| **静态高危门禁** | `server/agent/executor.js` | 注释剥离后匹配，两级判定 |
| **隔离执行** | `server/agent/executor.js` | mock / docker（无网络+限额）/ local（受限解释器） |
| **结构化错误** | `server/lib/errors.js` | code + retryable + hint，前后端统一契约 |

## 接入真实监控

工具层的取数全部收敛在 `server/agent/tools.js` 的实现里，换成真实数据源只需改实现、不动定义：

```js
// 现在读 sandbox/inventory.json（确定性模拟数据，结果可复现）
// 替换为：
//   Prometheus: GET /api/v1/query_range
//   Zabbix:     zabbix.history.get
//   阿里云监控: DescribeMetricList
```

重新生成模拟数据：`node sandbox/gen-fixtures.mjs`（种子化伪随机，保证多次查询结果一致，
否则模型会因前后证据矛盾而胡乱归因）。

## 路线图

- [x] 阶段 1 故障分析
- [x] 阶段 2 脚本校错（规则 + AI + 人工确认）
- [x] 阶段 3 只读工具调用
- [x] 阶段 4 自动化运维：生成脚本 → 静态门禁 → 人工审批 → 隔离环境执行
- [x] 阶段 5 业务落地：角色权限矩阵、审批留痕、结构化错误、三层测试

## 测试覆盖

```
npm test                    后端冒烟            74 项断言
node test/unit-exec.mjs     门禁 + 执行器单测    免起服务
node test/browser-check.mjs 前端 UI 全流程       41 项断言
```

后端断言覆盖：五阶段主链路、路径穿越拒绝、门禁体检与提交判定一致性、
门禁拦截、审批职责分离、越权拒绝、未批准执行拒绝、审计留痕、参数校验与 404。

前端断言覆盖：首屏渲染、SSE 流式 Markdown、工具卡片、diff 确认、
工具沙箱分组、自动化四步链路、身份切换后按钮权限变化、控制台无 JS 错误。

## API 一览

对话与工具：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 运行时信息（模式、工具清单、权限、模板、主机候选） |
| POST | `/api/chat` | SSE 流式对话（阶段 1/2，可开关工具） |
| GET/POST | `/api/sessions` | 会话列表与创建 |
| POST | `/api/lint` | Shell 静态体检 |
| GET/POST | `/api/tools`、`/api/tools/invoke` | 工具清单与手动调用 |

审批与执行（阶段 4）：

| 方法 | 路径 | 所需权限 |
|---|---|---|
| GET | `/api/approvals` | `audit:read` |
| POST | `/api/approvals` | `approval:submit` |
| POST | `/api/approvals/:id/decision` | `approval:decide` |
| POST | `/api/approvals/:id/execute` | `exec:sandbox` |
| POST | `/api/script/generate` | `script:generate` |
| POST | `/api/script/gate` | `script:lint`（与提交时同一套门禁，先体检防"提交才被拒"） |
| GET | `/api/audit/export` | `audit:read` |

身份通过请求头传递（演示用）：`x-ops-actor: alice@demo`、`x-ops-role: approver`。
生产环境应换成真实的登录态与服务端会话。

## 一分钟演示脚本

1. **阶段 1** 故障分析 → 点场景「磁盘写满」→ 发送，看工具卡片逐个点亮 + Markdown 流式输出；
2. **阶段 2** 脚本校错 → 载入 `samples/risky-deploy.sh` → 体检 → 看 diff → 确认应用；
3. **阶段 3** 工具沙箱 → 选 `query_metrics` → 调用，看返回的时序数据；故意试 `../../etc/passwd` 看被拒；
4. **阶段 4** 自动化运维 → 选「清理 7 天前日志」→ 生成 → 提交 → 点批准会发现**自己不能批自己**
   → 顶栏换个身份 → 批准 → 执行 → 看 stdout；
5. **阶段 5** 权限与审计 → 顶栏切到「观察员」，生成脚本按钮变灰；打开审计抽屉，
   按类型过滤，看谁在什么时候做了什么。

命令行等价演示：

```bash
FORCE_MOCK=1 npm start &
curl -s http://127.0.0.1:8787/api/approvals -H 'x-ops-role: viewer' -o /dev/null -w '%{http_code}\n'
```

## 安全与部署检查清单

- [ ] 生产部署务必把 `HOST` 从 127.0.0.1 改为反代内网地址，并在 Nginx 上加认证；
- [ ] `CORS_ORIGIN` 仅在前端独立部署时设置，且指向确切来源；
- [ ] API Key 只放服务端 `.env`（`.gitignore` 已排除），前端永远拿不到；
- [ ] 审计文件 `data/audit.log` 建议按日切割并异地备份；
- [ ] 接真实主机时，只读工具应改为通过受限账号（`readonly` sudo 白名单）走 SSH 采集，
      而不是在应用所在机器直接执行；
- [ ] **演示用的身份切换（`x-ops-*` 请求头）必须替换为真实认证**——否则任何人都能伪造角色；
- [ ] 用 `EXEC_MODE=docker` 跑真实脚本时，确认 Docker daemon 不与生产共享命名空间；
- [ ] 审批单目前落 `data/approvals.json`，生产应换数据库并加行级锁与不可篡改存储。

## 简历表述参考（重要边界）

> 阶段 1-5 已全部落地并有测试覆盖，可以写"已构建/已实现"。
> 但下面三条边界仍然不能越线——写错比不写更伤。

**可以这样写：**

> 基于 OpenAI API 构建智能运维助手：集成日志分析、脚本检查与人工审批的工具执行流程；
> 使用函数调用编排只读取证工具，通过 SSE 实现流式响应与多轮会话状态管理；
> 实现基于角色的权限控制、变更审批状态机与隔离环境执行，并留下 append-only 操作审计。

**可以讲清的机制（这些是公开可学的）：**

- Agent 循环：推理 → 调用工具 → 结果回灌 → 再推理，以及轮次上限与收敛策略；
- 工具 Schema 设计与两种协议（Chat Completions / Responses API）的差异；
- 会话状态管理：历史裁剪、tool 消息不可孤立、服务端 `previous_response_id`；
- 流式输出：SSE 分包边界处理、错误分级与重试。

**三个不能踩的坑：**

1. **"私有化部署执行环境" ≠ "私有化部署大模型"。**
   本项目（以及 OpenAI Agents 的标准模式）是把 Agent 的执行环境/工具/数据放在自己的机器上，
   模型本身始终通过 API 调用，并没有把模型权重下载到本地。
   简历里这两句话必须分开写，混在一起会被懂行的人直接判定为夸大。
2. **不要承诺"了解 Codex 内部大模型原理"。**
   可以写：学习公开的模型与 Agent 工作机制、调用流程与工具编排；
   未公开的内部实现细节，无法通过本项目掌握。
3. **"隔离执行"要说清隔离到什么程度。**
   本项目默认是 `mock` 模拟执行（零副作用），`docker` 模式才有真正的
   `--network=none` + 资源限额。别把"模拟执行"说成"已验证的沙箱逃逸防护"。

**面试时加分的说法是讲清"为什么这么设计"：**
比如"执行接口只接受 `approval_id` 而不接受脚本文本——因为一旦接口能收脚本，
权限校验就可能被人从别的入口绕过；用接口形状来堵，比靠调用方自觉可靠"。

## 目录结构

```
ai-ops-assistant/
├── server/
│   ├── index.js            # 服务入口（装配、生命周期、优雅退出）
│   ├── config.js           # 配置层（内置 .env 解析）
│   ├── audit.js            # append-only 审计日志
│   ├── routes/api.js       # HTTP API（SSE 对话、lint、工具直连、审批、审计）
│   ├── agent/
│   │   ├── loop.js         # Agent 多轮编排循环（核心，含权限过滤）
│   │   ├── session.js      # 会话状态与历史裁剪
│   │   ├── tools.js        # 只读工具定义 + 实现 + 安全护栏
│   │   ├── write-tools.js  # 写操作工具（生成/审批/执行）
│   │   ├── scriptgen.js    # 脚本模板生成器（安全骨架 + 默认 dry-run）
│   │   ├── approval.js     # 审批状态机与持久化
│   │   └── executor.js     # 静态门禁 + 隔离执行（mock / docker / local）
│   ├── security/
│   │   └── rbac.js         # 角色权限矩阵
│   ├── llm/
│   │   ├── provider.js     # OpenAI 兼容双协议接入
│   │   ├── mock.js         # 演示模式推理引擎
│   │   └── prompts.js      # 系统提示词
│   └── lib/
│       ├── sse.js          # 手写 SSE 解析器
│       ├── errors.js       # 结构化错误（code / retryable / hint）
│       └── shell-lint.js   # Shell 静态风险规则引擎
├── public/                 # 前端（无构建步骤）
├── sandbox/                # 确定性模拟数据与示例日志
├── samples/                # 示例脚本（含故意写危险的 risky-deploy.sh）
├── test/                   # 冒烟测试（API + 单元 + 浏览器）
└── data/                   # 运行时产物（审计日志、审批单，已 gitignore）
```

## 常见问题

- **端口占用**：`PORT=8800 npm start`
- **中转站报 400**：多数是不支持 `parallel_tool_calls`/`stream_options`/`tool_choice`，
  服务端会自动剔除后重试一次；仍失败时检查 `OPENAI_BASE_URL` 是否需要带 `/v1`
- **想强制演示模式**：`LLM_MODE=mock` 或 `FORCE_MOCK=1`
- **模拟数据丢失**：`node sandbox/gen-fixtures.mjs` 重新生成
