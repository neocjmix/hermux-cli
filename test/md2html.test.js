const test = require('node:test');
const assert = require('node:assert/strict');

const { md2html, escapeHtml } = require('../src/lib/md2html');

test('escapeHtml escapes angle brackets and ampersands', () => {
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
});

test('md2html renders fenced code blocks', () => {
  const input = '```js\nconst x = 1;\n```';
  const out = md2html(input);
  assert.equal(out, '<pre><code class="language-js">const x = 1;</code></pre>');
});

test('md2html renders inline markdown safely', () => {
  const input = '# Title\n**bold** `_code_` _italic_';
  const out = md2html(input);
  assert.match(out, /<b>Title<\/b>/);
  assert.match(out, /<b>bold<\/b>/);
  assert.match(out, /<code>_code_<\/code>/);
  assert.match(out, /<i>italic<\/i>/);
});

test('md2html supports telegram-oriented entities', () => {
  const input = '__under__ ~~strike~~ ||spoiler||';
  const out = md2html(input);
  assert.match(out, /<u>under<\/u>/);
  assert.match(out, /<s>strike<\/s>/);
  assert.match(out, /<tg-spoiler>spoiler<\/tg-spoiler>/);
});

test('md2html renders safe links and blockquotes', () => {
  const input = '> quote\n[site](https://example.com?q=1&x=2) [bad](javascript:alert1)';
  const out = md2html(input);
  assert.match(out, /<blockquote>quote<\/blockquote>/);
  assert.match(out, /<a href="https:\/\/example\.com\?q=1&amp;x=2">site<\/a>/);
  assert.doesNotMatch(out, /javascript:alert1/);
});

test('md2html renders unordered list markers with tolerant indentation', () => {
  const input = '- top\n  - nested-2\n    * nested-3\n\t+ tab-nested';
  const out = md2html(input);
  assert.match(out, /^• top/m);
  assert.match(out, /^  • nested-2/m);
  assert.match(out, /^    • nested-3/m);
  assert.match(out, /^  • tab-nested/m);
});
