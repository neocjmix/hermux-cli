// @ts-check
'use strict';

// Skeleton: see docs/COMPONENT_CONTRACTS.md § audit

function sanitizeValue(v) { throw new Error('NOT_IMPLEMENTED: sanitizeValue'); }

/**
 * @param {string} runtimeDir
 * @returns {{ logPath: string, write: Function }}
 */
function makeAuditLogger(runtimeDir) {
  throw new Error('NOT_IMPLEMENTED: makeAuditLogger');
}

module.exports = {
  makeAuditLogger,
  _internal: { sanitizeValue },
};
