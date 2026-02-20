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
