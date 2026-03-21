// @ts-check
'use strict';

// Skeleton: see docs/specs/SESSION_EVENT_ROUTING_SPEC.md
// Contract: routeEventBySession is session-first (REBUILD_CONTRACTS § 1)

/**
 * @param {{ event: object, activeSessionId: string }} params
 * @returns {{ deliver: boolean, payload: string, sessionId: string, reason: string }}
 */
function routeEventBySession({ event, activeSessionId }) {
  throw new Error('NOT_IMPLEMENTED: routeEventBySession');
}

function normalizeJsonString(s) { throw new Error('NOT_IMPLEMENTED: normalizeJsonString'); }
function unwrapRawContent(event) { throw new Error('NOT_IMPLEMENTED: unwrapRawContent'); }

module.exports = {
  routeEventBySession,
  _internal: {
    normalizeJsonString,
    unwrapRawContent,
  },
};
