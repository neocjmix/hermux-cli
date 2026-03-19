const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const { createChatRoutingService } = require('../src/app/chat-routing-service');

function makeService(overrides = {}) {
  const endCalls = [];
  const clearCalls = [];
  const refreshCalls = [];
  const deps = {
    addChatIdToRepo: () => ({ ok: true, changed: true }),
    moveChatIdToRepo: () => ({ ok: true }),
    refreshRuntimeRouting: (chatRouter, states) => refreshCalls.push({ chatRouter, states }),
    getSessionId: () => '',
    endSessionLifecycle: async (...args) => endCalls.push(args),
    clearSessionId: (repoName, chatId) => clearCalls.push({ repoName, chatId }),
    ...overrides,
  };
  return {
    service: createChatRoutingService(deps),
    endCalls,
    clearCalls,
    refreshCalls,
  };
}

test('chat routing service returns remap warning when chat is already mapped and confirmation is missing', async () => {
  const { service } = makeService({
    addChatIdToRepo: () => ({ ok: false, reason: 'chat_already_mapped', existingRepo: 'sample-repo' }),
  });

  const result = await service.connectChat({
    requestedRepo: 'dev-test',
    chatId: '100',
    availableRepos: [{ name: 'sample-repo' }, { name: 'dev-test' }],
    remapConfirm: false,
    chatRouter: new Map(),
    states: new Map(),
  });

  assert.equal(result.kind, 'remap_warning');
  assert.match(result.text, /already connected to repo: sample-repo/i);
  assert.match(result.text, /To confirm move: \/connect dev-test move/i);
});

test('chat routing service clears session continuity when remap is confirmed', async () => {
  const { service, endCalls, clearCalls, refreshCalls } = makeService({
    addChatIdToRepo: () => ({ ok: false, reason: 'chat_already_mapped', existingRepo: 'sample-repo' }),
    moveChatIdToRepo: () => ({ ok: true }),
    getSessionId: (repoName) => repoName === 'sample-repo' ? 'ses-old' : 'ses-new',
  });

  const availableRepos = [
    { name: 'sample-repo', workdir: '/tmp/sample' },
    { name: 'dev-test', workdir: '/tmp/dev-test' },
  ];

  const result = await service.connectChat({
    requestedRepo: 'dev-test',
    chatId: '100',
    availableRepos,
    remapConfirm: true,
    chatRouter: new Map([['100', { name: 'sample-repo' }]]),
    states: new Map([['sample-repo', {}], ['dev-test', {}]]),
  });

  assert.equal(result.kind, 'moved');
  assert.match(result.text, /Moved: chat 100 -> repo dev-test/);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(clearCalls, [
    { repoName: 'sample-repo', chatId: '100' },
    { repoName: 'dev-test', chatId: '100' },
  ]);
  assert.equal(endCalls.length, 2);
});

test('chat routing service reports successful first-time connect with optional group hint flag', async () => {
  const { service, refreshCalls } = makeService({
    addChatIdToRepo: () => ({ ok: true, changed: true }),
  });

  const result = await service.connectChat({
    requestedRepo: 'dev-test',
    chatId: '-100123',
    availableRepos: [{ name: 'dev-test' }],
    remapConfirm: false,
    chatRouter: new Map(),
    states: new Map([['dev-test', {}]]),
  });

  assert.equal(result.kind, 'connected');
  assert.equal(result.includeGroupHint, true);
  assert.equal(refreshCalls.length, 1);
});
