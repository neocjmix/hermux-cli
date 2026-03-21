// @ts-check
'use strict';

// Skeleton: see docs/COMPONENT_CONTRACTS.md § chat-routing-service
// Contract: returns channel-agnostic data only (BOUNDARY_AUDIT #7)

/**
 * @param {object} deps
 * @returns {{ connectChat: Function }}
 */
function createChatRoutingService(deps) {
  return {
    async connectChat(params) {
      throw new Error('NOT_IMPLEMENTED: connectChat');
    },
  };
}

module.exports = {
  createChatRoutingService,
};
