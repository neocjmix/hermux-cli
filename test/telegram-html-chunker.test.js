'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitTelegramHtml } = require('../src/providers/downstream/telegram/html-chunker');

test('splitTelegramHtml balances bold tags across chunks', () => {
  assert.deepEqual(splitTelegramHtml('<b>bold</b>', 2), ['<b>bo</b>', '<b>ld</b>']);
});

test('splitTelegramHtml keeps entities intact across chunks', () => {
  assert.deepEqual(splitTelegramHtml('a &amp; b', 3), ['a &amp;', ' b']);
});

test('splitTelegramHtml reopens attribute-bearing tags across chunks', () => {
  assert.deepEqual(
    splitTelegramHtml('<a href="https://example.com">abcd</a>', 2),
    [
      '<a href="https://example.com">ab</a>',
      '<a href="https://example.com">cd</a>',
    ]
  );
});
