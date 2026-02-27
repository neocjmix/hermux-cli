'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sanitizer = require('../src/lib/output-sanitizer');

test('sanitizeCanonicalOutputText is pass-through trim', () => {
  const raw = '  <system-reminder>x</system-reminder>\nhello\n  ';
  assert.equal(sanitizer.sanitizeCanonicalOutputText(raw, 'prompt'), '<system-reminder>x</system-reminder>\nhello');
});

test('sanitizeFinalOutputText delegates to canonical pass-through', () => {
  const raw = '  hello world  ';
  assert.equal(sanitizer.sanitizeFinalOutputText(raw, 'prompt'), 'hello world');
});

test('sanitizeWithoutPromptEchoStrip is pass-through trim', () => {
  const raw = '  abc\n<!-- OMO_INTERNAL_INITIATOR -->\nxyz  ';
  assert.equal(sanitizer.sanitizeWithoutPromptEchoStrip(raw), 'abc\n<!-- OMO_INTERNAL_INITIATOR -->\nxyz');
});

test('splitByOmoInitiatorMarker splits raw and escaped markers', () => {
  const raw = ['one', '<!-- OMO_INTERNAL_INITIATOR -->', 'two', '&lt;!-- OMO_INTERNAL_INITIATOR --&gt;', 'three'].join('\n');
  assert.deepEqual(sanitizer.splitByOmoInitiatorMarker(raw), ['one', 'two', 'three']);
});

test('extractLatestSystemReminder returns latest reminder and stripped body', () => {
  const raw = ['a', '<system-reminder>first</system-reminder>', 'b', '<system-reminder>second</system-reminder>'].join('\n');
  const out = sanitizer.extractLatestSystemReminder(raw);
  assert.equal(out.reminderText, 'second');
  assert.equal(out.text.includes('system-reminder'), false);
  assert.match(out.text, /a/);
  assert.match(out.text, /b/);
});
