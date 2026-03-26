const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPermissionFlow,
  syncPermissionFlow,
  buildPermissionMessage,
  buildPermissionKeyboard,
  buildPermissionRenderSignature,
} = require('../src/app/permission-interaction-service');

test('permission interaction service normalizes request and builds keyboard', () => {
  const flow = createPermissionFlow({
    id: 'perm-1',
    sessionID: 'ses-1',
    permission: 'bash',
    patterns: ['*'],
    always: ['skill_mcp'],
    tool: { messageID: 'msg-1', callID: 'call-1' },
  }, '100');

  assert.equal(flow.requestId, 'perm-1');
  assert.equal(flow.sessionId, 'ses-1');
  assert.equal(flow.chatId, '100');
  assert.equal(flow.permission, 'bash');
  assert.deepEqual(flow.patterns, ['*']);
  assert.deepEqual(flow.always, ['skill_mcp']);
  assert.deepEqual(flow.tool, { messageId: 'msg-1', callId: 'call-1' });
  assert.match(buildPermissionMessage(flow), /Permission: bash/);
  assert.equal(buildPermissionKeyboard(flow).inline_keyboard.length, 3);
  assert.equal(typeof buildPermissionRenderSignature(flow), 'string');
});

test('permission interaction service syncs existing flow by request id', () => {
  const current = createPermissionFlow({
    id: 'perm-1',
    sessionID: 'ses-1',
    permission: 'bash',
  }, '100');
  current.messageId = 42;
  const synced = syncPermissionFlow(current, {
    id: 'perm-1',
    sessionID: 'ses-2',
    permission: 'edit',
    patterns: ['src/**'],
  }, '100');
  assert.equal(synced.messageId, 42);
  assert.equal(synced.sessionId, 'ses-2');
  assert.equal(synced.permission, 'edit');
  assert.deepEqual(synced.patterns, ['src/**']);
});
