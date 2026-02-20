'use strict';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function md2html(md) {
  if (!md) return '';

  // regex: fenced code blocks ```lang\n...\n```
  const fenceRe = /^```(\w*)\n([\s\S]*?)^```$/gm;
  const parts = [];
  let lastIndex = 0;

  for (const m of md.matchAll(fenceRe)) {
    if (m.index > lastIndex) {
      parts.push({ type: 'text', value: md.slice(lastIndex, m.index) });
    }
    parts.push({ type: 'code', lang: m[1], value: m[2] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < md.length) {
    parts.push({ type: 'text', value: md.slice(lastIndex) });
  }

  return parts.map(p => {
    if (p.type === 'code') {
      const escaped = escapeHtml(p.value.replace(/\n$/, ''));
      const cls = p.lang ? ` class="language-${escapeHtml(p.lang)}"` : '';
      return `<pre><code${cls}>${escaped}</code></pre>`;
    }
    return inlineMarkdown(p.value);
  }).join('');
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  const codePlaceholders = [];

  out = out.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${code}</code>`);
    return `@@CODE_${idx}@@`;
  });

  // regex: bold **...**
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // regex: italic _..._ — word-boundary only to avoid false positives in snake_case
  out = out.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');
  // regex: headings # ... — Telegram has no heading tag, rendered as bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  out = out.replace(/@@CODE_(\d+)@@/g, (_, idx) => {
    return codePlaceholders[Number(idx)] || '';
  });

  return out;
}

module.exports = { md2html, escapeHtml };
