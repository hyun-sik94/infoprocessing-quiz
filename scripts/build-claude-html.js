#!/usr/bin/env node
// CLAUDE.md → CLAUDE.html 변환기 (의존성 없음)
//   node scripts/build-claude-html.js           한 번 변환 (내용이 같으면 다시 쓰지 않는다)
//   node scripts/build-claude-html.js --watch   CLAUDE.md가 바뀔 때마다 변환
// CLAUDE.html은 직접 고치지 않는다. 내용은 CLAUDE.md에서, 모양은 이 파일에서 고친다.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'CLAUDE.md');
const OUT = path.join(ROOT, 'CLAUDE.html');

// ───────────────────────── 마크다운 해석 ─────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 인라인: 코드 → 굵게 → 링크 순서. 코드 안의 * 와 | 는 건드리지 않는다.
function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[Number(i)]) + '</code>');
  return s;
}

function indentOf(line) {
  return line.length - line.replace(/^ +/, '').length;
}

const RE_FENCE = /^(\s*)```(.*)$/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_LIST = /^(\s*)([-*]|\d+\.)(\s+)(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocks(lines) {
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = line.match(RE_FENCE);
    if (fence) {
      const pad = fence[1].length;
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i].slice(Math.min(pad, indentOf(lines[i]))));
        i++;
      }
      i++; // 닫는 줄
      nodes.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    const heading = line.match(RE_HEADING);
    if (heading) {
      nodes.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      nodes.push({ type: 'table', head, rows });
      continue;
    }

    if (RE_LIST.test(line)) {
      const parsed = parseList(lines, i);
      nodes.push(parsed.node);
      i = parsed.next;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !RE_FENCE.test(lines[i]) && !RE_HEADING.test(lines[i]) && !RE_LIST.test(lines[i])
      && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i].trim());
      i++;
    }
    nodes.push({ type: 'para', lines: para });
  }
  return nodes;
}

function parseList(lines, start) {
  const first = lines[start].match(RE_LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(RE_LIST);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const offset = base + m[2].length + m[3].length;
    const body = [];
    i++;
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === '') {
        // 빈 줄: 뒤에 이 항목에 속한(더 들여쓴) 줄이 이어질 때만 항목 안으로 본다
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && indentOf(lines[j]) > base) { body.push(''); i++; continue; }
        break;
      }
      if (indentOf(cur) <= base) break;
      body.push(cur.slice(Math.min(offset, indentOf(cur))));
      i++;
    }
    items.push({ text: m[4], children: parseBlocks(body) });
  }
  return { node: { type: 'list', ordered, items }, next: i };
}

// ───────────────────────── HTML 조립 ─────────────────────────

const BADGE_CLASS = { '데이터': 'b-data', '기능': 'b-feat', '설계': 'b-design', '보안': 'b-sec', '접근성': 'b-a11y', '모바일': 'b-mobile', '확인': 'b-check', '배포': 'b-deploy' };

function renderNodes(nodes, ctx, depth) {
  return nodes.map(n => renderNode(n, ctx, depth)).join('\n');
}

function renderNode(n, ctx, depth) {
  const unit = depth === 0 ? ' class="u"' : '';
  if (n.type === 'para') return `<p${unit}>${n.lines.map(inline).join('<br>')}</p>`;
  if (n.type === 'code') return `<pre${unit}><code>${esc(n.text)}</code></pre>`;
  if (n.type === 'heading') {
    const id = ctx.nextId();
    ctx.sub.push({ id, text: n.text });
    return `<h3 id="${id}">${inline(n.text)}</h3>`;
  }
  if (n.type === 'list') {
    const tag = n.ordered ? 'ol' : 'ul';
    const items = n.items.map(it => `<li${unit}><div class="li-main">${inline(it.text)}</div>${it.children.length ? renderNodes(it.children, ctx, depth + 1) : ''}</li>`).join('\n');
    return `<${tag}>${items}</${tag}>`;
  }
  if (n.type === 'table') {
    const badge = ctx.kind === 'issues';
    const head = n.head.map(h => `<th>${inline(h)}</th>`).join('');
    const rows = n.rows.map(r => '<tr class="u">' + n.head.map((_, c) => {
      const cell = r[c] === undefined ? '' : r[c];
      if (badge && c === 0) return `<td><span class="badge ${BADGE_CLASS[cell] || 'b-etc'}">${inline(cell)}</span></td>`;
      const mark = (cell === '✅' || cell === '❌') ? ' class="mark"' : '';
      return `<td${mark}>${inline(cell)}</td>`;
    }).join('') + '</tr>').join('\n');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
  }
  return '';
}

function sectionKind(title) {
  if (title.includes('최우선')) return 'rules';
  if (title.includes('한눈에')) return 'glance';
  if (title.includes('남은 문제')) return 'issues';
  if (title.includes('수정 이력')) return 'history';
  return 'normal';
}

function build(md, mtime) {
  const lines = md.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const nodes = parseBlocks(lines);

  let title = 'CLAUDE.md';
  const intro = [];
  const sections = [];
  let current = null;
  nodes.forEach(n => {
    if (n.type === 'heading' && n.level === 1) { title = n.text; return; }
    if (n.type === 'heading' && n.level === 2) { current = { title: n.text, nodes: [] }; sections.push(current); return; }
    (current ? current.nodes : intro).push(n);
  });

  let idSeq = 0;
  const nextId = () => 's' + (++idSeq);
  const stats = { rules: 0, issues: 0 };

  const sectionHtml = sections.map(sec => {
    const kind = sectionKind(sec.title);
    const id = nextId();
    const ctx = { kind, nextId, sub: [] };
    const body = renderNodes(sec.nodes, ctx, 0);
    sec.id = id;
    sec.sub = ctx.sub;
    sec.kind = kind;
    if (kind === 'rules') { const l = sec.nodes.find(n => n.type === 'list' && n.ordered); stats.rules = l ? l.items.length : 0; }
    if (kind === 'issues') { const t = sec.nodes.find(n => n.type === 'table'); stats.issues = t ? t.rows.length : 0; }
    return `<section class="card k-${kind}" id="${id}" data-title="${esc(sec.title)}">
<h2><button type="button" class="sec-toggle" aria-expanded="true">${inline(sec.title)}<span class="chev" aria-hidden="true">▾</span></button></h2>
<div class="sec-body">
${body}
</div>
</section>`;
  }).join('\n\n');

  const toc = sections.map(sec => `<li><a href="#${sec.id}" data-target="${sec.id}">${esc(sec.title)}</a>${sec.sub.length ? '<ul>' + sec.sub.map(s => `<li><a href="#${s.id}">${esc(s.text.replace(/`/g, ''))}</a></li>`).join('') + '</ul>' : ''}</li>`).join('\n');

  const d = new Date(mtime);
  const pad = v => String(v).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const jump = kind => { const s = sections.find(x => x.kind === kind); return s ? '#' + s.id : '#'; };

  return `<!DOCTYPE html>
<!-- 자동 생성 파일: CLAUDE.md에서 scripts/build-claude-html.js로 만든다. 직접 수정하지 않는다. -->
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · 프로젝트 안내</title>
<style>
${CSS}
</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <div class="brand"><span class="brand-mark">MD</span><span class="brand-name">${esc(title)}</span></div>
    <input id="q" class="search" type="search" placeholder="검색 (예: 과락, 캐시, 즐겨찾기)" aria-label="문서 검색">
    <button id="toggle-all" type="button" class="ghost">모두 접기</button>
    <button id="theme" type="button" class="ghost" aria-label="밝게/어둡게 전환">◐</button>
  </div>
</header>

<div class="layout">
  <nav class="toc" aria-label="목차">
    <div class="toc-title">목차</div>
    <ul>
${toc}
    </ul>
  </nav>

  <main>
    <div class="hero">
      <h1>${esc(title)}</h1>
      <div class="lead">${renderNodes(intro, { kind: 'normal', nextId, sub: [] }, 1)}</div>
      <div class="stats">
        <a class="stat s-rules" href="${jump('rules')}"><b>${stats.rules}</b><span>최우선 규칙</span></a>
        <a class="stat s-issues" href="${jump('issues')}"><b>${stats.issues}</b><span>남은 문제</span></a>
        <div class="stat"><b>${sections.length}</b><span>섹션</span></div>
        <div class="stat wide"><b>${stamp}</b><span>CLAUDE.md 마지막 수정</span></div>
      </div>
      <p class="note">이 화면은 <code>CLAUDE.md</code>에서 자동으로 만들어집니다. 내용은 <code>CLAUDE.md</code>에서 고치세요.</p>
    </div>
    <p id="empty" class="empty" hidden>검색 결과가 없습니다.</p>

${sectionHtml}
  </main>
</div>

<script>
${JS}
</script>
</body>
</html>
`;
}

// ───────────────────────── 화면 모양 ─────────────────────────

const CSS = `:root {
  --bg: #f4f6f9; --card: #ffffff; --ink: #1c2530; --muted: #5d6b7c; --line: #dfe5ec; --soft: #f1f4f8;
  --accent: #1d5fd1; --accent-soft: #e6eefc; --code-bg: #eef1f6; --code-ink: #23344d;
  --danger: #b42318; --danger-soft: #fdeceb; --ok: #0a7a4b; --warn-soft: #fff6e0; --warn: #8a5a00;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 4px 14px rgba(16, 24, 40, .05);
}
[data-theme="dark"] {
  --bg: #10151c; --card: #18202a; --ink: #e6ebf2; --muted: #9aa8b9; --line: #2a3644; --soft: #1e2833;
  --accent: #7db0ff; --accent-soft: #1c2d47; --code-bg: #222d3a; --code-ink: #d5e2f5;
  --danger: #ff9b8f; --danger-soft: #3a1f1d; --ok: #5fd3a0; --warn-soft: #33290f; --warn: #f2c35b;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.7 "Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; word-break: keep-all; overflow-wrap: anywhere; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: 0.88em/1.5 "D2Coding", Consolas, "Cascadia Mono", monospace; background: var(--code-bg); color: var(--code-ink); padding: 1px 5px; border-radius: 4px; word-break: normal; overflow-wrap: anywhere; }
pre { margin: 10px 0; padding: 12px 14px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 13px; white-space: pre; word-break: normal; }
strong { font-weight: 700; }

.top { position: sticky; top: 0; z-index: 10; background: var(--card); border-bottom: 1px solid var(--line); }
.top-inner { max-width: 1240px; margin: 0 auto; padding: 10px 20px; display: flex; gap: 10px; align-items: center; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; flex-shrink: 0; }
.brand-mark { background: var(--accent); color: var(--card); font-size: 11px; font-weight: 800; padding: 3px 6px; border-radius: 5px; letter-spacing: .04em; }
.search { flex: 1 1 0; min-width: 0; max-width: 460px; margin-left: auto; padding: 8px 12px; font: inherit; font-size: 16px; color: var(--ink); background: var(--soft); border: 1px solid var(--line); border-radius: 8px; }
.search:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.ghost { flex-shrink: 0; padding: 8px 12px; font: inherit; font-size: 13px; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; white-space: nowrap; }
.ghost:hover { background: var(--soft); }

.layout { max-width: 1240px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 24px; align-items: start; }
.toc { position: sticky; top: 76px; max-height: calc(100vh - 96px); overflow-y: auto; padding: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; font-size: 13.5px; }
.toc-title { font-size: 12px; font-weight: 700; color: var(--muted); margin-bottom: 6px; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc > ul > li > a { display: block; padding: 5px 8px; border-radius: 6px; color: var(--ink); font-weight: 600; }
.toc > ul > li > a.active { background: var(--accent-soft); color: var(--accent); }
.toc ul ul { margin: 0 0 4px 8px; padding-left: 8px; border-left: 1px solid var(--line); }
.toc ul ul a { display: block; padding: 2px 8px; color: var(--muted); font-size: 12.5px; }

.hero { margin-bottom: 18px; }
.hero h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -.01em; }
.lead p { margin: 0; color: var(--muted); }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0 8px; }
.stat { display: flex; flex-direction: column; min-width: 104px; padding: 10px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; color: var(--ink); box-shadow: var(--shadow); }
.stat:hover { text-decoration: none; border-color: var(--accent); }
.stat b { font-size: 20px; line-height: 1.3; font-variant-numeric: tabular-nums; }
.stat span { font-size: 12px; color: var(--muted); }
.stat.wide b { font-size: 15px; line-height: 1.75; }
.s-rules b { color: var(--danger); }
.s-issues b { color: var(--warn); }
.note { margin: 0; font-size: 12.5px; color: var(--muted); }
.empty { padding: 30px; text-align: center; color: var(--muted); }

.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 16px; box-shadow: var(--shadow); }
.card h2 { margin: 0; font-size: 17px; }
.sec-toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 18px; font: inherit; font-weight: 700; color: var(--ink); background: none; border: none; cursor: pointer; text-align: left; }
.chev { color: var(--muted); transition: transform .15s; }
.card.closed .chev { transform: rotate(-90deg); }
.card.closed .sec-body { display: none; }
.sec-body { padding: 2px 18px 16px; border-top: 1px solid var(--line); }
.sec-body h3 { margin: 20px 0 8px; padding-left: 9px; font-size: 14.5px; border-left: 3px solid var(--accent); line-height: 1.4; }
.sec-body p { margin: 10px 0; }
.sec-body ul, .sec-body ol { margin: 8px 0; padding-left: 20px; }
.sec-body li { margin: 5px 0; }
.sec-body li > ul, .sec-body li > ol { margin: 4px 0; }
.sec-body li li { color: var(--muted); font-size: 14px; }
.sec-body li li code { font-size: .86em; }

.table-wrap { margin: 10px 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 12.5px; color: var(--muted); background: var(--soft); padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
td.mark { text-align: center; }
td:first-child { font-weight: 600; }

.k-rules { border-color: var(--danger); }
.k-rules .sec-toggle { color: var(--danger); }
.k-rules .sec-body > ol { list-style: none; padding: 0; counter-reset: rule; }
.k-rules .sec-body > ol > li { counter-increment: rule; position: relative; margin: 10px 0; padding: 10px 12px 10px 46px; background: var(--danger-soft); border-radius: 8px; }
.k-rules .sec-body > ol > li::before { content: counter(rule); position: absolute; left: 12px; top: 10px; width: 24px; height: 24px; line-height: 24px; text-align: center; font-size: 13px; font-weight: 800; color: var(--card); background: var(--danger); border-radius: 50%; }
.k-rules .sec-body li li { color: var(--ink); }

.k-glance td:first-child { white-space: nowrap; color: var(--muted); width: 1%; }
.k-history td:first-child { white-space: nowrap; }
.k-issues td:first-child { width: 1%; white-space: nowrap; }
.k-issues td:last-child { color: var(--muted); font-size: 13px; min-width: 160px; }

.badge { display: inline-block; padding: 2px 9px; font-size: 12px; font-weight: 700; border-radius: 999px; background: var(--soft); color: var(--ink); border: 1px solid var(--line); }
.b-data { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.b-feat, .b-deploy { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.b-sec { background: var(--danger-soft); color: var(--danger); border-color: transparent; }

.hide { display: none !important; }
mark { background: #ffe58a; color: #1c2530; border-radius: 2px; padding: 0 1px; }

@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); padding: 14px; }
  .toc { position: static; max-height: none; }
  .toc ul ul { display: none; }
  .toc > ul { display: flex; flex-wrap: wrap; gap: 4px; }
  .toc > ul > li > a { background: var(--soft); font-size: 12.5px; }
  .brand-name, #toggle-all { display: none; }
  .top-inner { padding: 10px 14px; }
}
@media print {
  .top, .toc { display: none; }
  .layout { display: block; padding: 0; }
  .card { box-shadow: none; break-inside: avoid; }
  .card.closed .sec-body { display: block; }
}`;

const JS = `(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('claude_doc_theme'); } catch (e) {}
  var dark = saved ? saved === 'dark' : (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  function applyTheme() { root.setAttribute('data-theme', dark ? 'dark' : 'light'); }
  applyTheme();
  document.getElementById('theme').addEventListener('click', function () {
    dark = !dark; applyTheme();
    try { localStorage.setItem('claude_doc_theme', dark ? 'dark' : 'light'); } catch (e) {}
  });

  var cards = [].slice.call(document.querySelectorAll('.card'));
  cards.forEach(function (card) {
    var btn = card.querySelector('.sec-toggle');
    btn.addEventListener('click', function () {
      var closed = card.classList.toggle('closed');
      btn.setAttribute('aria-expanded', String(!closed));
      syncToggleAll();
    });
  });
  var toggleAll = document.getElementById('toggle-all');
  function syncToggleAll() {
    var anyOpen = cards.some(function (c) { return !c.classList.contains('closed'); });
    toggleAll.textContent = anyOpen ? '모두 접기' : '모두 펼치기';
  }
  toggleAll.addEventListener('click', function () {
    var close = cards.some(function (c) { return !c.classList.contains('closed'); });
    cards.forEach(function (c) { c.classList.toggle('closed', close); c.querySelector('.sec-toggle').setAttribute('aria-expanded', String(!close)); });
    syncToggleAll();
  });
  function openCard(id) {
    var el = document.getElementById(id);
    var card = el && el.closest('.card');
    if (card) { card.classList.remove('closed'); syncToggleAll(); }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute('href').length > 1) openCard(a.getAttribute('href').slice(1));
  });

  // 검색: 문단·목록 항목·표의 행 단위로 거른다. 섹션 제목이 맞으면 그 섹션은 전부 보여 준다.
  var q = document.getElementById('q');
  var empty = document.getElementById('empty');
  q.addEventListener('input', function () {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (card) {
      var units = [].slice.call(card.querySelectorAll('.u'));
      if (!term) { units.forEach(function (u) { u.classList.remove('hide'); }); card.classList.remove('hide'); shown++; return; }
      var titleHit = card.getAttribute('data-title').toLowerCase().indexOf(term) !== -1;
      var hits = 0;
      units.forEach(function (u) {
        var hit = titleHit || u.textContent.toLowerCase().indexOf(term) !== -1;
        // 표의 머리글(열 이름)이 맞으면 그 표의 행을 모두 보여 준다
        if (!hit && u.tagName === 'TR') {
          var thead = u.closest('table').querySelector('thead');
          hit = thead.textContent.toLowerCase().indexOf(term) !== -1;
        }
        u.classList.toggle('hide', !hit);
        if (hit) hits++;
      });
      var visible = titleHit || hits > 0;
      card.classList.toggle('hide', !visible);
      if (visible) { card.classList.remove('closed'); shown++; }
    });
    empty.hidden = shown > 0;
    syncToggleAll();
  });

  // 목차: 지금 보고 있는 섹션 표시
  var links = {};
  [].slice.call(document.querySelectorAll('.toc a[data-target]')).forEach(function (a) { links[a.getAttribute('data-target')] = a; });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        Object.keys(links).forEach(function (k) { links[k].classList.remove('active'); });
        if (links[en.target.id]) links[en.target.id].classList.add('active');
      });
    }, { rootMargin: '-80px 0px -70% 0px' });
    cards.forEach(function (c) { io.observe(c); });
  }
})();`;

// ───────────────────────── 실행 ─────────────────────────

function run(verbose) {
  const md = fs.readFileSync(SRC, 'utf8');
  const html = build(md, fs.statSync(SRC).mtimeMs);
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (prev === html) {
    if (verbose) console.log('CLAUDE.html: 변경 없음');
    return false;
  }
  fs.writeFileSync(OUT, html, 'utf8');
  if (verbose) console.log('CLAUDE.html: 갱신함');
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  // 훅에서 실행될 때는 조용히 끝낸다(출력이 Claude 대화에 섞이지 않도록). 직접 실행하면 결과를 알려 준다.
  const verbose = watch || args.includes('--verbose') || Boolean(process.stdout.isTTY);
  try {
    run(verbose);
  } catch (e) {
    console.error('CLAUDE.html 생성 실패: ' + e.message);
    process.exitCode = 1;
    if (!watch) return;
  }
  if (watch) {
    console.log('CLAUDE.md 감시 중... (끝내려면 Ctrl+C)');
    fs.watchFile(SRC, { interval: 700 }, () => {
      try { run(true); } catch (e) { console.error('CLAUDE.html 생성 실패: ' + e.message); }
    });
  }
}

main();
