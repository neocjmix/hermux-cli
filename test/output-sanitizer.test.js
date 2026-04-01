'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sanitizer = require('../src/lib/output-sanitizer');

test('sanitizeCanonicalOutputText strips system reminders from visible output', () => {
  const raw = '  <system-reminder>x</system-reminder>\nhello\n  ';
  assert.equal(sanitizer.sanitizeCanonicalOutputText(raw, 'prompt'), 'hello');
});

test('sanitizeFinalOutputText delegates to canonical sanitizer', () => {
  const raw = '  hello world  ';
  assert.equal(sanitizer.sanitizeFinalOutputText(raw, 'prompt'), 'hello world');
});

test('sanitizeWithoutPromptEchoStrip removes internal initiator markers', () => {
  const raw = '  abc\n<!-- OMO_INTERNAL_INITIATOR -->\nxyz  ';
  assert.equal(sanitizer.sanitizeWithoutPromptEchoStrip(raw), 'abc\n\nxyz');
});

test('sanitizeDisplayOutputText strips background reminder wrappers', () => {
  const raw = [
    '[BACKGROUND TASK COMPLETED]',
    '**ID:** `bg_x`',
    '**Description:** task',
    '**Duration:** 10s',
    '',
    'Actual answer',
    '',
    'Use `background_output(task_id="bg_x")` to retrieve this result when ready.',
  ].join('\n');
  assert.equal(sanitizer.sanitizeDisplayOutputText(raw), 'Actual answer');
});

test('sanitizeDisplayOutputText strips escaped system reminder wrappers', () => {
  const raw = '&lt;system-reminder&gt;internal only&lt;/system-reminder&gt;\n\nVisible answer';
  assert.equal(sanitizer.sanitizeDisplayOutputText(raw), 'Visible answer');
});

test('sanitizeDisplayOutputText preserves standalone markdown metadata', () => {
  const raw = ['**ID:** customer-facing', '**Description:** keep this block'].join('\n');
  assert.equal(sanitizer.sanitizeDisplayOutputText(raw), raw);
});

test('sanitizeDisplayOutputText drops internal compaction handoff echoes', () => {
  const raw = [
    'The current immediate goal at the time of compaction was to fix the chart.',
    '',
    '## Discoveries',
    '- first',
    '',
    'next agent should check git status',
  ].join('\n');
  assert.equal(sanitizer.sanitizeDisplayOutputText(raw), '');
});

test('sanitizeDisplayOutputText keeps partial compaction wording when handoff markers are insufficient', () => {
  const raw = 'The current immediate goal at the time of compaction was user-facing copy cleanup.';
  assert.equal(sanitizer.sanitizeDisplayOutputText(raw), raw);
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
