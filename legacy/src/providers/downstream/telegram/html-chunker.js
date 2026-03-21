'use strict';

const HTML_TOKEN_RE = /(<[^>]+>|&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);|[^<&]+)/g;
const OPEN_TAG_RE = /^<([a-zA-Z0-9-]+)(\s[^>]*)?>$/;
const CLOSE_TAG_RE = /^<\/([a-zA-Z0-9-]+)\s*>$/;
const SELF_CLOSING_TAG_RE = /^<([a-zA-Z0-9-]+)(\s[^>]*)?\/\s*>$/;
const VOID_TAGS = new Set(['br']);

function decodeHtmlEntity(entity) {
  switch (entity) {
    case '&amp;': return '&';
    case '&lt;': return '<';
    case '&gt;': return '>';
    case '&quot;': return '"';
    case '&#39;': return "'";
    default:
      break;
  }

  if (/^&#\d+;$/.test(entity)) {
    const codePoint = Number(entity.slice(2, -1));
    if (Number.isFinite(codePoint)) return String.fromCodePoint(codePoint);
  }
  if (/^&#x[0-9a-fA-F]+;$/.test(entity)) {
    const codePoint = Number.parseInt(entity.slice(3, -1), 16);
    if (Number.isFinite(codePoint)) return String.fromCodePoint(codePoint);
  }
  return entity;
}

function tokenizeHtml(html) {
  return String(html || '').match(HTML_TOKEN_RE) || [];
}

function closeAllTags(stack) {
  let suffix = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += `</${stack[i].name}>`;
  }
  return suffix;
}

function reopenAllTags(stack) {
  return stack.map((entry) => entry.openTag).join('');
}

function flushChunk(chunks, state) {
  if (!state.visibleCount) return;
  chunks.push(state.html + closeAllTags(state.stack));
  state.html = reopenAllTags(state.stack);
  state.visibleCount = 0;
}

function splitTextToken(text, remaining) {
  if (text.length <= remaining) {
    return text.length;
  }

  const newlineIndex = text.lastIndexOf('\n', remaining);
  if (newlineIndex >= 0 && newlineIndex + 1 >= Math.max(1, Math.floor(remaining / 2))) {
    return newlineIndex + 1;
  }

  const whitespaceIndex = text.lastIndexOf(' ', remaining);
  if (whitespaceIndex > 0 && whitespaceIndex >= Math.max(1, Math.floor(remaining / 2))) {
    return whitespaceIndex + 1;
  }

  return remaining;
}

function splitTelegramHtml(html, maxLen) {
  const effectiveMaxLen = Number(maxLen);
  if (!Number.isFinite(effectiveMaxLen) || effectiveMaxLen <= 0) {
    const normalized = String(html || '');
    return normalized ? [normalized] : [];
  }

  const tokens = tokenizeHtml(html);
  const chunks = [];
  const state = {
    html: '',
    visibleCount: 0,
    stack: [],
  };

  for (const token of tokens) {
    const openMatch = token.match(OPEN_TAG_RE);
    const closeMatch = token.match(CLOSE_TAG_RE);
    const selfClosingMatch = token.match(SELF_CLOSING_TAG_RE);

    if (openMatch && !VOID_TAGS.has(openMatch[1].toLowerCase())) {
      state.html += token;
      state.stack.push({ name: openMatch[1].toLowerCase(), openTag: token });
      continue;
    }

    if (closeMatch) {
      state.html += token;
      const closeName = closeMatch[1].toLowerCase();
      for (let i = state.stack.length - 1; i >= 0; i--) {
        if (state.stack[i].name === closeName) {
          state.stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    if (selfClosingMatch || /^<br\s*\/?>$/i.test(token)) {
      state.html += token;
      continue;
    }

    if (token.startsWith('&')) {
      const visibleLength = decodeHtmlEntity(token).length;
      if (state.visibleCount && state.visibleCount + visibleLength > effectiveMaxLen) {
        flushChunk(chunks, state);
      }
      state.html += token;
      state.visibleCount += visibleLength;
      if (state.visibleCount >= effectiveMaxLen) {
        flushChunk(chunks, state);
      }
      continue;
    }

    let remainingText = token;
    while (remainingText) {
      const remainingVisible = effectiveMaxLen - state.visibleCount;
      if (remainingVisible <= 0) {
        flushChunk(chunks, state);
        continue;
      }

      const take = splitTextToken(remainingText, remainingVisible);
      const part = remainingText.slice(0, take);
      state.html += part;
      state.visibleCount += part.length;
      remainingText = remainingText.slice(take);

      if (state.visibleCount >= effectiveMaxLen) {
        flushChunk(chunks, state);
      }
    }
  }

  flushChunk(chunks, state);
  return chunks;
}

module.exports = {
  splitTelegramHtml,
  _internal: {
    decodeHtmlEntity,
    splitTextToken,
    tokenizeHtml,
  },
};
