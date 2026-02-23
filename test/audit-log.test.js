const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeAuditLogger, _internal } = require('../src/lib/audit-log');

test('audit logger writes jsonl records with kind and payload', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-audit-'));
  const logger = makeAuditLogger(tmpDir);

  logger.write('run.event_received', {
    runId: 'run-1',
    text: 'hello world',
  });

  const raw = fs.readFileSync(path.join(tmpDir, 'audit-events.jsonl'), 'utf8').trim();
  const rec = JSON.parse(raw);

  assert.equal(rec.kind, 'run.event_received');
  assert.equal(rec.payload.runId, 'run-1');
  assert.equal(rec.payload.text, 'hello world');
  assert.equal(typeof rec.ts, 'string');
});

test('audit logger sanitizes deep and very long payload values', () => {
  const huge = 'x'.repeat(1200);
  const sanitized = _internal.sanitizeValue({
    huge,
    nested: { a: { b: { c: { d: { e: 'z' } } } } },
  });

  assert.match(sanitized.huge, /truncated/);
  assert.match(JSON.stringify(sanitized), /\[max-depth\]/);
});
