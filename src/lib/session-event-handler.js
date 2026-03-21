// @ts-check
'use strict';

// Skeleton: see docs/specs/SESSION_EVENT_ROUTING_SPEC.md
// Contract: session-first event acceptance (REBUILD_CONTRACTS § 1)
// BOUNDARY: deliverPayload is channel-agnostic (BOUNDARY_AUDIT #12 FIXED)

const { routeEventBySession } = require('./event-router');

/**
 * @typedef {Object} SessionEventResult
 * @property {boolean} handled
 * @property {string} nextSessionId
 * @property {boolean} delivered
 * @property {string} dropReason
 */

/**
 * @param {{ deliverPayload: Function, onDeliver?: Function }} deps
 * @returns {function({ event: object, activeSessionId: string }): Promise<SessionEventResult>}
 */
function createSessionEventHandler({ deliverPayload, onDeliver }) {
  if (typeof deliverPayload !== 'function') {
    throw new Error('deliverPayload is required');
  }

  return async function handleSessionEvent({ event, activeSessionId }) {
    throw new Error('NOT_IMPLEMENTED: handleSessionEvent');
  };
}

module.exports = {
  createSessionEventHandler,
};
