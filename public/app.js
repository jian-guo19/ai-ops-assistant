/**
 * 前端主逻辑（原生 JS，无框架、无 CDN，离线可用）。
 *
 * 模块划分：
 *   1. 工具函数与轻量 Markdown 渲染
 *   2. SSE 流式客户端（自己解析，不用 EventSource，因为需要 POST + 自定义事件名）
 *   3. 阶段 1 故障分析视图
 *   4. 阶段 2 脚本校错视图（本地规则 + AI 审查 + diff 预览 + 人工确认）
 *   5. 阶段 3 工具沙箱视图
 *   6. 审计抽屉与全局状态
 */
(() => {
  'use strict';

  /* ========================== 基础工具 ========================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const box = $('#toast');
    box.textContent = msg;
    box.hidden = false;
    box.style.background = isError ? '#c92a2a' : '#1f2328';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
  }

  /**
   * 极简 Markdown 渲染。
   * 顺序很重要：先转义 HTML，再走 Markdown 规则，
   * 这样可以保证用户输入里任何 <script> 都只是文本。
   */
  function renderMarkdown(raw) {
    const src = escapeHtml(raw ?? '');
    const lines = src.split('\n');
    const out = [];
    let inCode = false;
    let codeLang = '';
    let listType = null;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join(' '))}</p>`);
        para = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push(listType === 'ol' ? '</ol>' : '</ul>');
        listType = null;
      }
    };
    const inline = (t) => t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    for (const line of lines) {
      // 代码块
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        if (inCode) {
          out.push('</code></pre>');
          inCode = false;
        } else {
          flushPara();
          closeList();
          codeLang = fence[1] || '';
          out.push(`<pre><code data-lang="${codeLang}">`);
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        out.push(`${line}\n`);
        continue;
      }

      if (!line.trim()) { flushPara(); closeList(); continue; }

      const h = line.match(/^(#{2,4})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const lv = h[1].length;
        out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }

      const quote = line.match(/^&gt;\s?(.*)$/) || line.match(/^>\s?(.*)$/);
      if (quote) {
        flushPara(); closeList();
        out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }

      const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ol || ul) {
        flushPara();
        const want = ol ? 'ol' : 'ul';
        if (listType && listType !== want) closeList();
        if (!listType) { out.push(`<${want}>`); listType = want; }
        out.push(`<li>${inline((ol || ul)[2] ?? (ol || ul)[1])}</li>`);
        continue;
      }
      closeList();
      para.push(line.trim());
    }
    if (inCode) out.push('</code></pre>');
    flushPara();
    closeList();
    return out.join('\n');
  }

  /* ========================== 行级 diff（LCS） ========================== */
  function diffLines(oldText, newText) {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const n = a.length;
    const m = b.length;
    // 为了控制内存，超大输入退化为全量替换提示
    if (n * m > 900000) {
      return [{ type: 'del', text: oldText }, { type: 'add', text: newText }];
    }
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        rows.push({ type: 'equal', text: a[i], aNo: i + 1, bNo: j + 1 });
        i += 1; j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rows.push({ type: 'del', text: a[i], aNo: i + 1 });
        i += 1;
      } else {
        rows.push({ type: 'add', text: b[j], bNo: j + 1 });
        j += 1;
      }
    }
    while (i < n) { rows.push({ type: 'del', text: a[i], aNo: i + 1 }); i += 1; }
    while (j < m) { rows.push({ type: 'add', text: b[j], bNo: j + 1 }); j += 1; }
    return rows;
  }

  /** 渲染 diff，超过 4 行连续未变更会被折叠，避免刷屏 */
  function renderDiff(oldText, newText) {
    const rows = diffLines(oldText, newText);
    const html = ['<table>'];
    let oldNo = 0;
    let newNo = 0;
    let equalRun = 0;
    let skipRun = 0;

    const emitRow = (r) => {
      const sym = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
      const cls = r.type === 'add' ? 'diff-add' : r.type === 'del' ? 'diff-del' : '';
      const a = r.type === 'add' ? '' : (r.aNo ?? '');
      const b = r.type === 'del' ? '' : (r.bNo ?? '');
      html.push(`<tr class="${cls}"><td class="ln">${a}</td><td class="ln">${b}</td><td>${sym} ${escapeHtml(r.text) || '&nbsp;'}</td></tr>`);
    };

    rows.forEach((r, idx) => {
      if (r.type === 'equal') {
        equalRun += 1;
        if (equalRun > 4 && idx < rows.length - 1) {
          skipRun += 1;
          return;
        }
        if (skipRun) {
          html.push(`<tr class="diff-hunk"><td class="ln">…</td><td class="ln">…</td><td>⋯ 折叠 ${skipRun} 行未变更 ⋯</td></tr>`);
          skipRun = 0;
        }
        emitRow(r);
      } else {
        equalRun = 0;
        if (skipRun) {
          html.push(`<tr class="diff-hunk"><td class="ln">…</td><td class="ln">…</td><td>⋯ 折叠 ${skipRun} 行未变更 ⋯</td></tr>`);
          skipRun = 0;
        }
        emitRow(r);
      }
    });
    html.push('</table>');
    return html.join('');
  }

  /* ========================== SSE 客户端 ========================== */
  /**
   * POST + SSE 流式读取。不能用 EventSource：它只支持 GET，也无法携带 JSON body。
   * @returns {Promise<void>}
   */
  async function streamPost(url, body, handlers, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch { /* 保持空 */ }
      throw new Error(detail || `请求失败（HTTP ${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let eventName = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const field = line.slice(0, colon);
          let data = line.slice(colon + 1);
          if (data.startsWith(' ')) data = data.slice(1);
          if (field === 'event') eventName = data;
          else if (field === 'data') {
            let payload = null;
            try {
              payload = JSON.parse(data);
            } catch {
              payload = null;
            }
            if (payload && typeof handlers.onEvent === 'function') {
              handlers.onEvent(payload, eventName);
            }
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  /* ========================== 全局状态 ========================== */
  const store = {
    cfg: null,
    sessionId: null,
    tools: [],
    issues: [],
    currentScript: '',
    streaming: false,
    role: 'approver',
    actor: 'duty-lead@demo',
  };
  let abortCtrl = null;

  /**
   * 统一请求头：把当前操作人/角色带上，由服务端做权限判定。
   * 演示项目允许前端自称身份；生产环境必须由网关/SSO 注入，不能信客户端。
   */
  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-ops-role': store.role,
      'x-ops-actor': store.actor,
    };
  }

  /** 当前角色是否具备某权限（前端仅用于禁用按钮，真正的判定在服务端） */
  function canDo(permission) {
    const perms = store.cfg?.auth?.permissions;
    return Array.isArray(perms) && perms.includes(permission);
  }

  /** 重新拉取服务端配置（角色/权限/执行模式），保持前后端一致 */
  async function refreshConfig() {
    try {
      const res = await fetch('/api/config', { headers: authHeaders() });
      if (res.ok) {
        store.cfg = await res.json();
        store.tools = store.cfg.tools || [];
        if (store.cfg.auth?.role) store.role = store.cfg.auth.role;
      }
    } catch {
      /* 网络异常时保留上一次配置，避免界面失控 */
    }
    renderRuntime();
  }

  /* ========================== 初始化 ========================== */
  async function init() {
    try {
      const res = await fetch('/api/config', { headers: authHeaders() });
      if (!res.ok) throw new Error(`配置加载失败 ${res.status}`);
      store.cfg = await res.json();
      store.tools = store.cfg.tools;
      // 服务端会回显当前生效的角色与权限，以服务端为准，避免前后端认知不一致
      if (store.cfg.auth?.role) store.role = store.cfg.auth.role;
    } catch (err) {
      toast(`无法连接后端：${err.message}`, true);
      return;
    }

    renderRuntime();
    renderScenarios();
    renderToolList();
    renderHostOptions();
    bindEvents();
  }

  function renderRuntime() {
    const rt = store.cfg.runtime;
    const modeBadge = $('#badge-mode');
    if (rt.mode === 'mock') {
      modeBadge.textContent = '演示模式（未配置 API Key）';
      modeBadge.className = 'badge badge-warn';
    } else {
      modeBadge.textContent = '已连接真实模型';
      modeBadge.className = 'badge badge-ok';
    }
    $('#badge-model').textContent = rt.model;
    $('#badge-protocol').textContent = rt.protocol === 'responses' ? 'Responses API' : 'Chat Completions';

    const execMode = store.cfg?.exec?.mode;
    const execEl = $('#auto-exec-mode');
    if (execEl) {
      const label = execMode === 'docker' ? '隔离后端：一次性容器'
        : execMode === 'local' ? '隔离后端：受限解释器（本地）'
          : '隔离后端：模拟执行（无副作用）';
      execEl.textContent = label;
    }

    applyPermissions();
  }

  /**
   * 按当前角色启用/禁用受保护操作的入口。
   *
   * 注意：这只是界面层的即时反馈，真正的安全边界在服务端
   * （server/agent/loop.js 的 assertCan 与各工具的 requiredPermission）。
   * 前端禁用按钮是为了体验，绝不能当成权限控制。
   */
  function applyPermissions() {
    const map = [
      ['#btn-send', 'chat:read'],
      ['#btn-lint', 'script:lint'],
      ['#btn-ai-review', 'chat:read'],
      ['#btn-auto-generate', 'script:generate'],
      ['#btn-auto-submit', 'approval:submit'],
      ['#btn-invoke', 'tool:invoke'],
      ['#btn-audit', 'audit:read'],
    ];
    for (const [sel, permission] of map) {
      const el = $(sel);
      if (!el) continue;
      if (sel === '#btn-send' && store.streaming) continue; // 由流式状态接管
      el.disabled = !canDo(permission);
      el.title = el.disabled ? '当前角色无此权限（服务端同样会拒绝）' : '';
    }
  }

  function renderScenarios() {
    const list = $('#scenario-list');
    list.innerHTML = '';
    for (const s of store.cfg.scenarios) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span class="sc-title">${escapeHtml(s.title)}</span><span class="sc-host">${escapeHtml(s.host)}</span>`;
      btn.addEventListener('click', () => {
        switchView('incident');
        $('#chat-input').value = s.prompt;
        $('#chat-input').focus();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  const PERM_LABEL = {
    'script:generate': '生成脚本',
    'approval:submit': '提交审批',
    'approval:decide': '审批决策',
    'exec:sandbox': '隔离执行',
    'audit:read': '审计只读',
  };

  function renderToolList() {
    const list = $('#tool-list');
    list.innerHTML = '';
    for (const t of store.tools) {
      const li = document.createElement('li');
      // 阶段四新增了写操作工具，不能再一律标成「只读」
      const badge = t.readOnly
        ? '<span class="tro">只读</span>'
        : `<span class="twr" title="会改变系统状态，需审批后执行">写操作</span>`;
      const perm = t.requiredPermission
        ? `<span class="tperm">${escapeHtml(PERM_LABEL[t.requiredPermission] || t.requiredPermission)}</span>`
        : '';
      li.innerHTML = `<span class="tname">${escapeHtml(t.name)}</span>${perm}${badge}`;
      li.title = t.description || '';
      list.appendChild(li);
    }
  }

  /* ========================== 视图切换 ========================== */
  function switchView(name) {
    $$('.tab').forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $$('.view').forEach((v) => {
      const active = v.id === `view-${name}`;
      v.classList.toggle('is-active', active);
      v.hidden = !active;
    });
    $('.sidebar').classList.remove('is-open');
    $('#sidebar-toggle').setAttribute('aria-expanded', 'false');
  }

  /* ========================== 阶段 1：故障分析 ========================== */
  function ensureStreamCleared() {
    const welcome = $('.welcome');
    if (welcome) welcome.remove();
  }

  function appendUserBubble(text) {
    const wrap = document.createElement('article');
    wrap.className = 'msg msg-user';
    wrap.innerHTML = `<span class="msg-label">你</span><div class="bubble">${escapeHtml(text)}</div>`;
    $('#chat-stream').appendChild(wrap);
    scrollStream();
  }

  function createAssistantMessage() {
    const wrap = document.createElement('article');
    wrap.className = 'msg msg-assistant';
    wrap.innerHTML = `<span class="msg-label">AI 分析</span><div class="card"><div class="md"></div><div class="tools"></div></div>`;
    $('#chat-stream').appendChild(wrap);
    scrollStream();
    return { wrap, md: $('.md', wrap), tools: $('.tools', wrap), buf: '' };
  }

  function scrollStream() {
    const el = $('#chat-stream');
    el.scrollTop = el.scrollHeight;
  }

  function addToolCard(container, evt) {
    const card = document.createElement('details');
    card.className = 'tool-card';
    card.open = true;
    card.innerHTML = `
      <summary>
        <span class="tc-name">${escapeHtml(evt.name)}</span>
        <span class="tc-ms">${escapeHtml(JSON.stringify(evt.args))}</span>
        <span class="tc-state badge badge-info" style="font-size:11px">执行中…</span>
      </summary>
      <div class="tc-body">
        <div class="tc-row"><span>参数</span><pre>${escapeHtml(JSON.stringify(evt.args, null, 2))}</pre></div>
        <div class="tc-row"><span>结果</span><pre class="tc-result">读取中…</pre></div>
      </div>`;
    container.appendChild(card);
    scrollStream();
    return card;
  }

  function updateToolCard(card, evt) {
    const state = $('.tc-state', card);
    const cls = evt.ok ? 'badge badge-ok' : 'badge badge-danger';
    state.className = `tc-state ${cls}`;
    state.textContent = evt.ok ? `成功 · ${evt.ms}ms` : `失败 · ${evt.ms}ms`;
    $('.tc-result', card).textContent = JSON.stringify(evt.preview, null, 2);
    if (evt.ok) card.open = false;
    scrollStream();
  }

  let renderTimer = null;
  function scheduleRender(ctx) {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (!ctx.wrap.isConnected) return;
      ctx.md.innerHTML = `${renderMarkdown(ctx.buf)}<span class="cursor"></span>`;
      scrollStream();
    }, 90);
  }

  function setStatus(text) {
    $('#status-line').textContent = text;
  }

  async function sendChat() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || store.streaming) return;

    ensureStreamCleared();
    appendUserBubble(text);
    input.value = '';
    store.streaming = true;
    $('#btn-send').disabled = true;
    $('#btn-stop').disabled = false;

    const started = Date.now();
    const cards = new Map();
    const ctx = createAssistantMessage();
    abortCtrl = new AbortController();

    const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

    try {
      await streamPost('/api/chat', {
        sessionId: store.sessionId,
        message: text,
        mode: 'incident',
        useTools: $('#opt-tools').checked,
      }, {
        onEvent: (evt) => {
          switch (evt.type) {
            case 'session':
              store.sessionId = evt.sessionId;
              $('#session-id').textContent = store.sessionId;
              break;
            case 'status':
              if (evt.phase === 'thinking') setStatus(`第 ${evt.turn}/${evt.totalTurns} 轮 · 推理中… ${elapsed()}`);
              else if (evt.phase === 'tool_execution') setStatus(`第 ${evt.turn} 轮 · 执行 ${evt.count} 个只读工具… ${elapsed()}`);
              else if (evt.phase === 'concluding') setStatus(`已达轮次上限，正在收敛结论… ${elapsed()}`);
              break;
            case 'delta':
              ctx.buf += evt.text;
              scheduleRender(ctx);
              break;
            case 'tool_start':
              cards.set(evt.id, addToolCard(ctx.tools, evt));
              break;
            case 'tool_result': {
              const card = cards.get(evt.id);
              if (card) updateToolCard(card, evt);
              const counter = Number($('#session-toolcalls').textContent || '0') + 1;
              $('#session-toolcalls').textContent = String(counter);
              break;
            }
            case 'usage':
              setStatus(`完成 · ${elapsed()} · tokens ${evt.total.totalTokens}`);
              break;
            case 'done':
              break;
            case 'error':
              ctx.buf += `\n\n> **执行出错**：${evt.message}`;
              break;
            default:
              break;
          }
        },
      }, abortCtrl.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        ctx.buf += `\n\n> **连接错误**：${err.message}`;
        toast(`请求失败：${err.message}`, true);
      } else {
        ctx.buf += '\n\n> _已由用户中止。_';
      }
    } finally {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      ctx.md.innerHTML = renderMarkdown(ctx.buf);
      store.streaming = false;
      $('#btn-send').disabled = false;
      $('#btn-stop').disabled = true;
      scrollStream();
    }
  }

  /* ========================== 阶段 2：脚本校错 ========================== */
  function renderIssues(issues) {
    const list = $('#issue-list');
    list.innerHTML = '';
    store.issues = issues;
    $('#issue-count').textContent = String(issues.length);
    if (!issues.length) {
      list.innerHTML = '<li class="muted empty">未发现风险项。</li>';
      return;
    }

    issues.forEach((it, index) => {
      const li = document.createElement('li');
      li.className = 'issue';
      const lineInfo = it.line ? `第 ${it.line} 行` : '整体';
      const hasPatch = Boolean(it.patch);
      li.innerHTML = `
        <div class="issue-head">
          <span class="sev sev-${escapeHtml(it.severity || 'low')}">${escapeHtml(it.severity || 'low')}</span>
          <span class="issue-title">${escapeHtml(it.title)}</span>
          <span class="line-no">${escapeHtml(lineInfo)}</span>
        </div>
        <p class="irisk"><b>风险：</b>${escapeHtml(it.risk || '')}</p>
        <p class="isug"><b>建议：</b>${escapeHtml(it.suggestion || '')}</p>
        ${it.patch?.replace ? `<pre>${escapeHtml(it.patch.replace)}</pre>` : ''}
        <div class="btn-row" style="margin-top:8px">
          <button type="button" class="btn btn-sm btn-primary" ${hasPatch ? '' : 'disabled'} data-apply="${index}">
            生成修改预览
          </button>
          ${hasPatch ? '' : '<span class="muted">无可自动应用的补丁</span>'}
        </div>`;
      const btn = $('button[data-apply]', li);
      if (btn && hasPatch) {
        btn.addEventListener('click', () => previewPatch(index));
      }
      list.appendChild(li);
    });
  }

  /**
   * 应用单个补丁（只算预览，不落文件或直接改编辑器内容）。
   * 这是「人工确认」的关键环节：必须经过 diff 预览 + 点确认，才会真正修改。
   */
  function previewPatch(index) {
    const issue = store.issues[index];
    const script = $('#script-input').value;
    if (!script.trim()) {
      toast('请先粘贴或载入脚本', true);
      return;
    }
    const patched = applyPatchTo(script, issue.patch);
    if (patched === null) {
      toast('补丁无法匹配当前脚本（脚本可能已被修改），请先重新体检', true);
      return;
    }
    $('#diff-body').innerHTML = renderDiff(script, patched);
    $('#diff-panel').hidden = false;
    $('#btn-apply').dataset.index = String(index);
    $('#diff-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function applyPatchTo(script, patch) {
    if (!patch) return null;
    if (patch.type === 'replace') {
      if (!patch.find || !script.includes(patch.find)) return null;
      // 只替换第一处，避免同名片段被全量改写
      const at = script.indexOf(patch.find);
      return script.slice(0, at) + patch.replace + script.slice(at + patch.find.length);
    }
    if (patch.type === 'insert') {
      const lines = script.split('\n');
      if (patch.position === 'before-cp') {
        const at = lines.findIndex((l) => /^\s*cp\s+/.test(l));
        if (at === -1) return null;
        lines.splice(at, 0, patch.text);
        return lines.join('\n');
      }
      if (typeof patch.anchor === 'number' && patch.anchor >= 0) {
        const at = patch.anchor;
        lines.splice(at, 0, patch.text);
        return lines.join('\n');
      }
      // 默认插到文件开头
      return `${patch.text}\n${script}`;
    }
    return null;
  }

  async function localLint() {
    const script = $('#script-input').value;
    if (!script.trim()) { toast('请先粘贴或载入脚本', true); return; }
    setScriptBusy(true);
    try {
      const res = await fetch('/api/script/lint', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ script }),
      });
      const data = await res.json();
      const c = data.stats.counts;
      $('#lint-summary').innerHTML =
        `本地静态体检：<b>${data.issues.length}</b> 项 · ` +
        `critical ${c.critical || 0} / high ${c.high || 0} / medium ${c.medium || 0} / low ${c.low || 0}` +
        `（共 ${data.stats.lines} 行，纯确定性规则，不调用模型）`;
      renderIssues(data.issues);
      $('#diff-panel').hidden = true;
    } catch (err) {
      toast(`体检失败：${err.message}`, true);
    } finally {
      setScriptBusy(false);
    }
  }

  async function aiReview() {
    const script = $('#script-input').value;
    if (!script.trim()) { toast('请先粘贴或载入脚本', true); return; }
    setScriptBusy(true);
    let buf = '';
    const status = $('#lint-summary');
    status.textContent = 'AI 审查中…（本地规则已先跑一遍，AI 负责补充语义层问题）';

    abortCtrl = new AbortController();
    try {
      await streamPost('/api/chat', {
        message: `请审查以下 Shell 脚本：\n\`\`\`bash\n${script}\n\`\`\``,
        mode: 'script',
      }, {
        onEvent: (evt) => {
          if (evt.type === 'delta') buf += evt.text;
          if (evt.type === 'error') buf += `\n错误：${evt.message}`;
        },
      }, abortCtrl.signal);

      const json = extractJsonBlock(buf);
      if (!json) {
        status.textContent = 'AI 未返回可解析的 JSON，已回退为纯文本输出：';
        $('#issue-list').innerHTML = `<li class="issue"><div class="issue-head"><span class="sev sev-low">raw</span><span class="issue-title">原始输出</span></div><pre>${escapeHtml(buf.slice(-3000))}</pre></li>`;
        $('#issue-count').textContent = '1';
        return;
      }
      $('#issue-count').textContent = String(json.issues?.length || 0);
      status.innerHTML = `AI 审查完成：<b>${escapeHtml(json.summary || '')}</b>`;
      const merged = (json.issues || []).map((i) => ({
        severity: i.severity || 'low',
        line: i.line ?? null,
        title: i.title || '未命名问题',
        risk: i.risk || '',
        suggestion: i.suggestion || '',
        patch: i.patch || null,
      }));
      renderIssues(merged);
      $('#diff-panel').hidden = true;
    } catch (err) {
      if (err.name !== 'AbortError') toast(`AI 审查失败：${err.message}`, true);
    } finally {
      setScriptBusy(false);
    }
  }

  function extractJsonBlock(text) {
    const m = text.match(/```json\s*\n([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[1] || m[0]);
    } catch {
      // 模型偶尔会在 JSON 里带上尾随逗号或多输出一句话，这里做一次尽力修复
      try {
        const cleaned = (m[1] || m[0]).replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }

  function setScriptBusy(busy) {
    $('#btn-lint').disabled = busy;
    $('#btn-ai-review').disabled = busy;
    $('#btn-load-sample').disabled = busy;
  }

  /* ========================== 阶段 3：工具沙箱 ========================== */
  const SAMPLE_ARGS = {
    list_hosts: {},
    query_metrics: { host_id: 'web-01', metric: 'disk', minutes: 30 },
    get_alerts: {},
    query_logs: { host_id: 'web-01', source: 'nginx', keyword: 'space', lines: 10 },
    check_services: { host_id: 'cache-04' },
    top_processes: { host_id: 'app-02', sort_by: 'mem', limit: 5 },
    read_file: { path: 'samples/risky-deploy.sh' },
    get_current_time: {},
  };

  function initInspector() {
    const sel = $('#ins-tool');
    sel.innerHTML = '';
    // 按「只读 / 写操作」分组：写操作工具来自阶段四，需走审批后才能真正执行
    const groups = [
      ['只读工具', store.tools.filter((t) => t.readOnly)],
      ['写操作工具（受权限与审批约束）', store.tools.filter((t) => !t.readOnly)],
    ];
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const t of items) {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.name;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    sel.addEventListener('change', syncInspectorTool);
    syncInspectorTool();
  }

  function syncInspectorTool() {
    const name = $('#ins-tool').value;
    const tool = store.tools.find((t) => t.name === name);
    if (!tool) return;
    $('#ins-desc').textContent = tool.description;
    $('#ins-args').value = JSON.stringify(SAMPLE_ARGS[name] ?? {}, null, 2);
    $('#ins-schema').textContent = JSON.stringify(tool.parameters, null, 2);
  }

  async function invokeTool() {
    const name = $('#ins-tool').value;
    let args = {};
    try {
      args = JSON.parse($('#ins-args').value || '{}');
    } catch {
      toast('参数不是合法 JSON', true);
      return;
    }
    $('#ins-result').textContent = '执行中…';
    try {
      const res = await fetch('/api/tools/invoke', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, args }),
      });
      const data = await res.json();
      $('#ins-meta').textContent = `${data.ms}ms`;
      $('#ins-meta').className = `badge ${data.ok ? 'badge-ok' : 'badge-danger'}`;
      $('#ins-result').textContent = JSON.stringify(data.ok ? data.result : { error: data.error, hint: data.hint }, null, 2);
    } catch (err) {
      $('#ins-result').textContent = `请求失败：${err.message}`;
      $('#ins-meta').className = 'badge badge-danger';
      $('#ins-meta').textContent = '失败';
    }
  }

  /* ====================== 阶段 4：自动化运维 ====================== */

  const GATE_LABEL = {
    blocked: { text: '门禁拒绝', cls: 'badge-danger' },
    needs_approval: { text: '需人工审批', cls: 'badge-warn' },
    auto_allowed: { text: '可自动执行', cls: 'badge-ok' },
  };

  function renderGate(gate) {
    const box = $('#auto-gate');
    if (!gate) { box.innerHTML = ''; return; }
    const meta = GATE_LABEL[gate.level] || { text: gate.level, cls: 'badge-ghost' };
    const reasons = (gate.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
    const counts = gate.counts || {};
    const countText = Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`).join(' / ');
    box.innerHTML =
      '<span class="badge ' + meta.cls + '">' + meta.text + '</span>' +
      (countText ? `<span class="gate-count">静态检查：${escapeHtml(countText)}</span>` : '') +
      (reasons ? `<ul class="gate-reasons">${reasons}</ul>` : '');
  }

  async function autoGenerate() {
    const intent = $('#auto-intent').value.trim();
    if (!intent) { toast('请先填写变更意图', true); return; }
    const host = $('#auto-host').value.trim() || null;

    const btn = $('#btn-auto-generate');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const res = await fetch('/api/script/generate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ intent, target_host: host, params: {} }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      $('#auto-script').value = data.script;
      renderGate(data.gate);
      toast(`已生成草稿（模板：${data.template?.title || '-'}）`);
    } catch (err) {
      toast(`生成失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '生成草稿';
    }
  }

  async function autoLint() {
    const script = $('#auto-script').value;
    if (!script.trim()) { toast('请先生成或粘贴脚本', true); return; }
    try {
      // 走阶段四的门禁接口，结论与提交时完全一致，避免"体检说能过、提交却被拒"
      const res = await fetch('/api/script/gate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ script }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderGate(data.gate);
      renderIssues(data.issues);
      toast(
        data.gate.level === 'blocked'
          ? '门禁拒绝：含高危操作，无法提交'
          : `门禁通过：${data.gate.level === 'needs_approval' ? '需人工审批后执行' : '可自动执行'}`,
        data.gate.level === 'blocked',
      );
    } catch (err) {
      toast(`体检失败：${err.message}`, true);
    }
  }

  async function autoSubmit() {
    const script = $('#auto-script').value;
    if (!script.trim()) { toast('请先生成或粘贴脚本', true); return; }
    const intent = $('#auto-intent').value.trim() || '未命名变更';
    const host = $('#auto-host').value.trim() || null;
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ script, intent, target_host: host }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || '提交失败', true);
        if (data.reasons) renderGate({ level: 'blocked', reasons: data.reasons });
        return;
      }
      toast(`已提交审批：${data.approval?.id}`);
      refreshApprovals();
    } catch (err) {
      toast(`提交失败：${err.message}`, true);
    }
  }

  function severityClass(sev) {
    if (sev === 'critical') return 'badge-danger';
    if (sev === 'high') return 'badge-warn';
    if (sev === 'medium') return 'badge-ghost';
    return 'badge-info';
  }

  async function refreshApprovals() {
    const status = $('#approval-filter').value;
    try {
      const res = await fetch(`/api/approvals?limit=50${status ? `&status=${status}` : ''}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const s = data.stats || {};
      $('#approval-stats').innerHTML = [
        ['待审批', s.pending], ['已批准', s.approved], ['已驳回', s.rejected], ['已执行', s.executed],
      ].map(([k, v]) => `<span class="badge badge-ghost">${k} <b>${v || 0}</b></span>`).join('');

      const list = $('#approval-list');
      if (!data.approvals?.length) {
        list.innerHTML = '<li class="muted empty">暂无变更申请。</li>';
        return;
      }
      list.innerHTML = data.approvals.map((a) => {
        const canExec = a.status === 'approved' && canDo('exec:sandbox');
        // 职责分离：提交人不能批准自己提交的变更
        const selfSubmitted = Boolean(a.submitted_by) && a.submitted_by === store.actor;
        const canDecide = a.status === 'pending' && canDo('approval:decide') && !selfSubmitted;
        return `<li class="approval">
          <div class="ap-head">
            <span class="ap-intent">${escapeHtml(a.intent)}</span>
            <span class="badge ${a.status === 'approved' ? 'badge-ok' : a.status === 'pending' ? 'badge-warn' : 'badge-ghost'}">${escapeHtml(a.status)}</span>
          </div>
          <div class="ap-meta">
            ${a.target_host ? `<span>主机 <b>${escapeHtml(a.target_host)}</b></span>` : ''}
            <span>提交人 <b>${escapeHtml(a.submitted_by)}</b></span>
            <span>门禁 <b>${escapeHtml(a.gate?.level || '-')}</b></span>
            ${a.decided_by ? `<span>审批人 <b>${escapeHtml(a.decided_by)}</b></span>` : ''}
          </div>
          ${(a.gate?.reasons || []).length ? `<ul class="ap-reasons">${a.gate.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
          <details class="ap-script"><summary>查看脚本（${String(a.script || '').split('\n').length} 行）</summary><pre>${escapeHtml(a.script || '')}</pre></details>
          <div class="btn-row">
            <button type="button" class="btn btn-sm btn-primary" data-approve="${a.id}" ${canDecide ? '' : 'disabled'}
              title="${selfSubmitted ? '不能批准自己提交的变更，请切换操作人' : canDecide ? '' : '当前角色无审批权'}">批准</button>
            <button type="button" class="btn btn-sm btn-ghost" data-reject="${a.id}" ${canDecide ? '' : 'disabled'}
              title="${selfSubmitted ? '不能驳回自己提交的变更，请切换操作人' : canDecide ? '' : '当前角色无审批权'}">驳回</button>
            <button type="button" class="btn btn-sm btn-ghost" data-exec="${a.id}" ${canExec ? '' : 'disabled'}>在隔离环境执行</button>
          </div>
          ${a.execution ? `<div class="ap-exec"><b>执行结果</b>：exit ${a.execution.exitCode} · ${a.execution.durationMs}ms · ${a.execution.simulated ? '模拟执行' : '真实执行'} · ${a.execution.ok ? '成功' : '失败'}</div>` : ''}
        </li>`;
      }).join('');

      // 绑定操作按钮
      $$('button[data-approve]', list).forEach((b) => b.addEventListener('click', () => decide(b.dataset.approve, 'approve')));
      $$('button[data-reject]', list).forEach((b) => b.addEventListener('click', () => decide(b.dataset.reject, 'reject')));
      $$('button[data-exec]', list).forEach((b) => b.addEventListener('click', () => execute(b.dataset.exec)));
    } catch (err) {
      toast(`审批队列加载失败：${err.message}`, true);
    }
  }

  async function decide(id, decision) {
    try {
      const res = await fetch(`/api/approvals/${id}/decision`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ decision, comment: decision === 'approve' ? '已确认风险与回滚方案' : '风险过高，暂不执行' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast(`${data.approval?.id} → ${data.approval?.status}`);
      refreshApprovals();
      loadAudit();
    } catch (err) {
      toast(`审批失败：${err.message}`, true);
    }
  }

  async function execute(id) {
    try {
      const res = await fetch(`/api/approvals/${id}/execute`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ mode: 'mock' }),
    });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderExecution(data.result);
      refreshApprovals();
      loadAudit();
    } catch (err) {
      toast(`执行失败：${err.message}`, true);
    }
  }

  function renderExecution(result) {
    const panel = $('#exec-panel');
    panel.hidden = false;
    const meta = $('#exec-meta');
    const modeText = result.simulated ? '模拟执行（未产生真实副作用）' : (result.mode === 'docker' ? '一次性容器执行' : '受限解释器执行');
    $('#exec-badge').textContent = `${result.mode} · ${result.durationMs}ms`;
    $('#exec-badge').className = `badge ${result.ok ? 'badge-ok' : 'badge-danger'}`;
    meta.innerHTML = [
      `exit code <b>${result.exitCode}</b>`,
      `耗时 <b>${result.durationMs}ms</b>`,
      `模式 <b>${escapeHtml(result.mode)}</b> · ${escapeHtml(modeText)}`,
      result.skippedLines ? `被拦截行数 <b>${result.skippedLines}</b>` : '',
    ].filter(Boolean).map((x) => `<span class="badge badge-ghost">${x}</span>`).join('');

    $('#exec-stdout').textContent = result.stdout || '(空)';
    $('#exec-stderr').textContent = result.stderr || '(空)';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ========================== 审计抽屉 ========================== */
  async function openAudit() {
    $('#audit-drawer').hidden = false;
    $('#audit-body').innerHTML = '<p class="muted">加载中…</p>';
    try {
      const res = await fetch('/api/audit?limit=200');
      const data = await res.json();
      const s = data.stats;
      $('#audit-stats').innerHTML = [
        `总条数 <b>${s.total}</b>`,
        ...Object.entries(s.byType).map(([k, v]) => `${escapeHtml(k)} <b>${v}</b>`),
        `文件 ${Math.round((s.sizeBytes || 0) / 1024)} KB`,
      ].map((x) => `<span class="badge badge-ghost">${x}</span>`).join('');

      $('#audit-body').innerHTML = data.entries.map((e) => `
        <div class="audit-item">
          <span class="at-ts">${escapeHtml(String(e.ts).slice(11, 19))}</span>
          <span class="at-body">
            <b>${escapeHtml(e.type)}</b>
            ${e.tool ? ` · 工具 <b>${escapeHtml(e.tool)}</b>` : ''}
            ${e.mode ? ` · 模式 ${escapeHtml(e.mode)}` : ''}
            ${e.ok === false ? '<span class="badge badge-danger">失败</span>' : ''}
            <div class="at-meta">${escapeHtml(JSON.stringify(e.args || e.stats || {}).slice(0, 160))}</div>
          </span>
        </div>`).join('') || '<p class="muted">暂无记录</p>';
    } catch (err) {
      $('#audit-body').innerHTML = `<p class="muted">加载失败：${escapeHtml(err.message)}</p>`;
    }
  }

  /** 审计加载（带类型筛选），抽屉打开时自动调用 */
  async function loadAudit() {
    const type = $('#audit-filter-type')?.value || '';
    try {
      const res = await fetch(`/api/audit?limit=200${type ? `&type=${encodeURIComponent(type)}` : ''}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({ stats: { byType: {} }, entries: [] }));
      const s = data.stats || { total: 0, sizeBytes: 0, byType: {} };

      const statsEl = $('#audit-stats');
      if (statsEl) {
        statsEl.innerHTML = [
          `总条数 <b>${s.total || 0}</b>`,
          ...Object.entries(s.byType || {}).map(([k, v]) => `${escapeHtml(k)} <b>${v}</b>`),
          `文件 ${Math.round((s.sizeBytes || 0) / 1024)} KB`,
        ].map((x) => `<span class="badge badge-ghost">${x}</span>`).join('');
      }

      const bodyEl = $('#audit-body');
      if (!bodyEl) return;
      const entries = data.entries || [];
      bodyEl.innerHTML = entries.length
        ? entries.map((e) => `
        <div class="audit-item">
          <span class="at-ts">${escapeHtml(String(e.ts).slice(11, 19))}</span>
          <span class="at-body">
            <b>${escapeHtml(e.type)}</b>
            ${e.tool ? ` · 工具 <b>${escapeHtml(e.tool)}</b>` : ''}
            ${e.actor ? ` · 操作人 <b>${escapeHtml(e.actor)}</b>(${escapeHtml(e.role || '-')})` : ''}
            ${e.ok === false ? '<span class="badge badge-danger">失败</span>' : ''}
            <div class="at-meta">${escapeHtml(JSON.stringify(e.args || e.stats || {}).slice(0, 160))}</div>
          </span>
        </div>`).join('')
        : '<p class="muted">暂无记录</p>';
    } catch (err) {
      const bodyEl = $('#audit-body');
      if (bodyEl) bodyEl.innerHTML = `<p class="muted">加载失败：${escapeHtml(err.message)}</p>`;
    }
  }

  /** 填充主机候选（供自动化视图的主机输入提示） */
  function renderHostOptions() {
    const dl = $('#host-options');
    if (!dl) return;
    dl.innerHTML = '';
    for (const h of (store.cfg?.hostCatalog || [])) {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.label = `${h.id} · ${h.role}`;
      dl.appendChild(opt);
    }
  }

  /* ========================== 事件绑定 ========================== */
  function bindEvents() {
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat();
    });
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendChat();
      }
    });
    $('#btn-stop').addEventListener('click', () => {
      if (abortCtrl) abortCtrl.abort();
      $('#btn-stop').disabled = true;
      setStatus('已中止');
    });

    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
    $('#sidebar-toggle').addEventListener('click', (e) => {
      const open = $('.sidebar').classList.toggle('is-open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });

    $('#btn-new-session').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/sessions', { method: 'POST' });
        const data = await res.json();
        store.sessionId = data.sessionId;
        $('#session-id').textContent = data.sessionId;
        $('#session-toolcalls').textContent = '0';
        $('#chat-stream').innerHTML = `
          <div class="welcome"><h2>新会话已创建</h2>
          <p>上下文已清空。继续描述故障现象，或先从左侧选一个内置场景。</p></div>`;
        setStatus('');
        toast('已创建新会话');
      } catch (err) {
        toast(`创建会话失败：${err.message}`, true);
      }
    });

    $('#btn-export').addEventListener('click', async () => {
      if (!store.sessionId) { toast('还没有会话内容', true); return; }
      try {
        const res = await fetch(`/api/sessions/${store.sessionId}/export`);
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ops-analysis-${store.sessionId}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) {
        toast(`导出失败：${err.message}`, true);
      }
    });

    $('#btn-audit').addEventListener('click', openAudit);
    $('#btn-audit-close').addEventListener('click', () => { $('#audit-drawer').hidden = true; });

    $('#btn-load-sample').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/samples/script');
        const data = await res.json();
        $('#script-input').value = data.content;
        $('#lint-summary').textContent = '';
        renderIssues([]);
        $('#diff-panel').hidden = true;
      } catch (err) {
        toast(`载入失败：${err.message}`, true);
      }
    });
    $('#btn-lint').addEventListener('click', localLint);
    $('#btn-ai-review').addEventListener('click', aiReview);

    $('#btn-cancel-diff').addEventListener('click', () => { $('#diff-panel').hidden = true; });
    $('#btn-apply').addEventListener('click', () => {
      const index = Number($('#btn-apply').dataset.index || '-1');
      const issue = store.issues[index];
      if (!issue) return;
      const patched = applyPatchTo($('#script-input').value, issue.patch);
      if (patched === null) {
        toast('补丁已失效，请重新体检', true);
        return;
      }
      $('#script-input').value = patched;
      $('#diff-panel').hidden = true;
      toast(`已应用修复：${issue.title}（共 ${patched.split('\n').length} 行）`);
      // 修复落地后重新体检，让旧的行号与补丁失效提示被刷新
      localLint();
    });

    $('#btn-invoke').addEventListener('click', invokeTool);
    initInspector();

    /* ---- 阶段 4：自动化运维 ---- */
    $('#btn-auto-generate').addEventListener('click', autoGenerate);
    $('#btn-auto-lint').addEventListener('click', autoLint);
    $('#btn-auto-submit').addEventListener('click', autoSubmit);
    $('#approval-filter').addEventListener('change', refreshApprovals);
    $('#btn-approval-refresh').addEventListener('click', refreshApprovals);

    /* ---- 阶段 5：角色 / 操作人切换（立即影响可用操作） ---- */
    const onIdentityChange = async (e) => {
      store.role = $('#role-select').value;
      store.actor = ($('#actor-input').value || '').trim() || 'anonymous';
      await refreshConfig();
      refreshApprovals();
      loadAudit();
      const label = e.target.id === 'role-select'
        ? `角色 → ${e.target.selectedOptions[0]?.textContent || store.role}`
        : `操作人 → ${store.actor}`;
      toast(label);
    };
    $('#role-select').addEventListener('change', onIdentityChange);
    $('#actor-input').addEventListener('change', onIdentityChange);

    /* ---- 阶段 5：审计筛选 ---- */
    $('#audit-filter-type').addEventListener('change', loadAudit);
    $('#btn-audit-export').addEventListener('click', () => {
      const type = $('#audit-filter-type').value;
      window.open(`/api/audit/export${type ? `?type=${encodeURIComponent(type)}` : ''}`, '_blank');
    });

    refreshApprovals();
    loadAudit();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
