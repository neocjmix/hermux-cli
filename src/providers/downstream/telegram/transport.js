'use strict';

// Skeleton: downstream telegram transport
// See docs/COMPONENT_CONTRACTS.md § transport
// BOUNDARY: All Telegram API calls are encapsulated here.
//   md2html is now local to this provider (moved from core lib per BOUNDARY_AUDIT #2)

function createTelegramTransport(deps) {
  throw new Error('NOT_IMPLEMENTED: createTelegramTransport');
}

module.exports = {
  createTelegramTransport,
};
