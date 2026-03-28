const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const {
  clearAllSessions,
  getSessionInfo,
  hasShownContinuityWarning,
  markContinuityWarningShown,
  setSessionId,
} = require('../src/lib/session-map');

test('session map records continuity warning visibility per session id', () => {
  clearAllSessions();

  setSessionId('demo', '100', 'ses-a');
  assert.equal(hasShownContinuityWarning('demo', '100', 'ses-a'), false);

  markContinuityWarningShown('demo', '100', 'ses-a');

  assert.equal(hasShownContinuityWarning('demo', '100', 'ses-a'), true);
  assert.equal(hasShownContinuityWarning('demo', '100', 'ses-b'), false);
});

test('session map preserves warning marker for unchanged session and clears it for a new session', () => {
  clearAllSessions();

  setSessionId('demo', '100', 'ses-a');
  markContinuityWarningShown('demo', '100', 'ses-a');

  setSessionId('demo', '100', 'ses-a');
  assert.equal(hasShownContinuityWarning('demo', '100', 'ses-a'), true);

  setSessionId('demo', '100', 'ses-b');
  assert.equal(hasShownContinuityWarning('demo', '100', 'ses-b'), false);
});

test('session map can stage warning visibility for a handoff session without replacing stored session id early', () => {
  clearAllSessions();

  setSessionId('demo', '100', 'ses-a');
  markContinuityWarningShown('demo', '100', 'ses-b');

  const staged = getSessionInfo('demo', '100');
  assert.equal(staged.sessionId, 'ses-a');
  assert.equal(staged.continuityWarningSessionId, 'ses-b');

  setSessionId('demo', '100', 'ses-b');
  const committed = getSessionInfo('demo', '100');
  assert.equal(committed.sessionId, 'ses-b');
  assert.equal(hasShownContinuityWarning('demo', '100', 'ses-b'), true);
});
