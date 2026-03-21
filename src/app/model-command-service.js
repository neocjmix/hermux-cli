// @ts-check
'use strict';

// Skeleton: see docs/COMPONENT_CONTRACTS.md § model-command-service
// BOUNDARY: MUST return channel-agnostic data (BOUNDARY_AUDIT #7)
//   - NO parse_mode, NO reply_markup
//   - Return { text, choices? } — downstream adapter applies channel formatting

/**
 * @param {object} deps
 * @returns {{ execute: Function }}
 */
function createModelCommandService(deps) {
  return {
    execute(input) {
      throw new Error('NOT_IMPLEMENTED: model-command-service.execute');
    },
  };
}

module.exports = {
  createModelCommandService,
};
