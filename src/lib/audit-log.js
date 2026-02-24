'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_STRING_MAX = parseInt(process.env.OMG_AUDIT_STRING_MAX || '8000', 10);

function sanitizeValue(value, depth = 0) {
  if (depth > 4) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > AUDIT_STRING_MAX ? `${value.slice(0, AUDIT_STRING_MAX)}...(truncated)` : value;
  }
  if (Array.isArray(value)) {
    const capped = value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
    if (value.length > 50) capped.push(`[+${value.length - 50} more]`);
    return capped;
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 80)) {
      out[key] = sanitizeValue(value[key], depth + 1);
    }
    if (keys.length > 80) out.__trimmedKeys = keys.length - 80;
    return out;
  }
  return String(value);
}

function makeAuditLogger(runtimeDir) {
  const resolvedRuntimeDir = path.resolve(runtimeDir || path.join(__dirname, '..', '..', 'runtime'));
  const logPath = path.join(resolvedRuntimeDir, 'audit-events.jsonl');
  fs.mkdirSync(resolvedRuntimeDir, { recursive: true });

  function write(kind, payload) {
    const rec = {
      ts: new Date().toISOString(),
      kind: String(kind || 'unknown'),
      payload: sanitizeValue(payload),
    };
    try {
      fs.appendFileSync(logPath, JSON.stringify(rec) + '\n', 'utf8');
    } catch (_err) {
    }
  }

  return {
    logPath,
    write,
  };
}

module.exports = {
  makeAuditLogger,
  _internal: {
    sanitizeValue,
  },
};
