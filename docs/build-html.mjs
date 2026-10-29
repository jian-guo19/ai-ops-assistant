/**
 * 把 docs/ 下的 Markdown 转成自包含 HTML，便于阅读 / 打印成 PDF。
 *
 * 用法：
 *   node docs/build-html.mjs                                  # 默认转技术设计文档
 *   node docs/build-html.mjs <输入.md> <输出.html>             # 转指定文件
 *
 * 只实现本文档用到的 Markdown 子集，不追求通用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 输入：相对路径优先按 cwd 解析，cwd 下找不到再按 docs/ 解析，方便从任意目录调用 */
function resolveInput(arg, fallbackName) {
  if (!arg) return path.join(__dirname, fallbackName);
  if (path.isAbsolute(arg)) return arg;
  const fromCwd = path.resolve(arg);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(__dirname, arg);
}

const SRC = resolveInput(process.argv[2], '技术设计文档.md');

// 输出文件此时还不存在，不能用 existsSync 判断，直接按 cwd 解析
let OUT;
if (process.argv[3]) {
  OUT = path.isAbsolute(process.argv[3]) ? process.argv[3] : path.resolve(process.argv[3]);
} else if (process.argv[2]) {
  OUT = SRC.replace(/\.md$/i, '.html'); // 只给输入时，同目录同名 .html，避免覆盖默认文档
} else {
  OUT = path.join(__dirname, '技术设计文档.html');
}

const esc = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** 行内语法：`code` → 先占位，避免与 **bold** 冲突 */
function inline(text) {
  const codes = [];
  let t = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return t;
}

/** 从表格行拆单元格：转义竖线 \| 不能当分隔符 */
function cellsOf(row) {
  return row
    .replace(/\\\|/g, '\u0001')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim().replace(/\u0001/g, '|'));
}

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const out = [];
let i = 0;
let pageTitle = '技术设计文档';

/** 从表格分隔行判断对齐方式 */
function alignOf(sep) {
  return sep.split('|').slice(1, -1).map((c) => {
    const s = c.trim();
    if (/^:-+:$/.test(s)) return 'center';
    if (/^-+:$/.test(s)) return 'right';
    return 'left';
  });
}

while (i < lines.length) {
  const line = lines[i];

  /* 代码块 */
  if (/^```/.test(line)) {
    const lang = line.slice(3).trim();
    const buf = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
    i += 1;
    const body = buf.join('\n');
    const isDiagram = /[┌├└│]/.test(body);
    out.push(
      `<pre class="code${isDiagram ? ' diagram' : ''}"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body)}</code></pre>`,
    );
    continue;
  }

  /* 表格（允许缩进，出现在列表项内部） */
  if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
    const head = cellsOf(line);
    const aligns = alignOf(lines[i + 1]);
    i += 2;
    const rows = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      rows.push(cellsOf(lines[i]));
      i += 1;
    }
    const th = head.map((c, k) => `<th style="text-align:${aligns[k] || 'left'}">${inline(c)}</th>`).join('');
    const tb = rows.map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${aligns[k] || 'left'}">${inline(c)}</td>`).join('')}</tr>`).join('\n');
    out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>\n${tb}\n</tbody></table></div>`);
    continue;
  }

  /* 标题 */
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) {
    const lv = h[1].length;
    if (lv === 1) pageTitle = h[2];
    const id = h[2].replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
    out.push(`<h${lv} id="${id}">${inline(h[2])}</h${lv}>`);
    i += 1;
    continue;
  }

  /* 分隔线 */
  if (/^---+\s*$/.test(line)) {
    out.push('<hr>');
    i += 1;
    continue;
  }

  /* 引用块 */
  if (/^>\s?/.test(line)) {
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) {
      buf.push(lines[i].replace(/^>\s?/, ''));
      i += 1;
    }
    out.push(`<blockquote>${buf.map((b) => `<p>${inline(b)}</p>`).join('')}</blockquote>`);
    continue;
  }

  /* 列表（支持缩进一层） */
  if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
    const ordered = /^\s*\d+\.\s+/.test(line);
    const items = [];
    while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
      const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      const indent = m[1].length >= 2 ? 1 : 0;
      items.push({ indent, text: m[3] });
      i += 1;
    }
    const build = (arr) => {
      const tag = ordered ? 'ol' : 'ul';
      let html = `<${tag}>`;
      for (let k = 0; k < arr.length; k += 1) {
        html += `<li>${inline(arr[k].text)}`;
        // 收集紧随其后的更深缩进项
        if (arr[k].indent === 0 && arr[k + 1] && arr[k + 1].indent === 1) {
          const sub = [];
          let j = k + 1;
          while (j < arr.length && arr[j].indent === 1) { sub.push(arr[j]); j += 1; }
          html += `<ul>${sub.map((s) => `<li>${inline(s.text)}</li>`).join('')}</ul>`;
          k = j - 1;
        }
        html += '</li>';
      }
      return `${html}</${tag}>`;
    };
    out.push(build(items));
    continue;
  }

  /* 空行 */
  if (!line.trim()) { i += 1; continue; }

  /* 段落：合并连续非空行 */
  const buf = [];
  while (i < lines.length && lines[i].trim()
    && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s|\s*\||---+$)/.test(lines[i])) {
    buf.push(lines[i]);
    i += 1;
  }
  if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  else i += 1;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<style>
  :root {
    --ink: #1a1f26;
    --ink-2: #4a5563;
    --ink-3: #6b7785;
    --line: #e3e8ef;
    --line-soft: #eef1f5;
    --bg: #ffffff;
    --bg-soft: #f7f9fb;
    --accent: #1f6feb;
    --code-bg: #f6f8fa;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 15.5px; line-height: 1.78;
  }
  .doc { max-width: 920px; margin: 0 auto; padding: 56px 40px 96px; }
  h1 { font-size: 30px; line-height: 1.35; margin: 0 0 8px; letter-spacing: -.2px; }
  h1 + p { color: var(--ink-3); font-size: 14px; margin-top: 0; }
  h2 {
    font-size: 22px; margin: 52px 0 16px; padding-bottom: 9px;
    border-bottom: 1px solid var(--line); letter-spacing: -.1px;
  }
  h3 { font-size: 17.5px; margin: 34px 0 12px; color: #10161d; }
  h4 { font-size: 15.5px; margin: 24px 0 8px; }
  p { margin: 13px 0; }
  strong { color: #0d131a; font-weight: 650; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: "JetBrains Mono", "Cascadia Mono", Consolas, "Liberation Mono",
                 "Microsoft YaHei", "PingFang SC", monospace;
    font-size: .88em; background: var(--code-bg); padding: 2px 5px;
    border-radius: 4px; color: #b02a5b; border: 1px solid var(--line-soft);
  }
  pre.code {
    background: var(--code-bg); border: 1px solid var(--line);
    border-radius: 8px; padding: 16px 18px; overflow-x: auto; margin: 16px 0;
    position: relative;
  }
  pre.code code {
    background: none; border: 0; padding: 0; color: #24292f;
    font-size: 12.8px; line-height: 1.62; white-space: pre;
  }
  /* 框图用更小的字号 + 允许横向滚动，保证框线不错位 */
  pre.diagram code { font-size: 12px; line-height: 1.5; }
  pre.diagram { background: #fbfcfd; }
  blockquote {
    margin: 18px 0; padding: 12px 18px; background: #f4f8ff;
    border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0;
    color: var(--ink-2);
  }
  blockquote p { margin: 5px 0; }
  ul, ol { margin: 12px 0; padding-left: 26px; }
  li { margin: 6px 0; }
  li > ul, li > ol { margin: 6px 0; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }
  .table-wrap { overflow-x: auto; margin: 18px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid var(--line); padding: 8px 12px; vertical-align: top; }
  th { background: var(--bg-soft); font-weight: 650; white-space: nowrap; }
  tbody tr:nth-child(even) { background: #fcfdfe; }
  @media print {
    .doc { max-width: none; padding: 0; }
    h2 { page-break-after: avoid; }
    pre.code, table, blockquote { page-break-inside: avoid; }
    pre.diagram code { font-size: 10.5px; }
    body { font-size: 12.5px; }
  }
</style>
</head>
<body>
<article class="doc">
${out.join('\n')}
</article>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成:', OUT);
console.log('原始行数:', lines.length, '| 输出字符数:', html.length);
