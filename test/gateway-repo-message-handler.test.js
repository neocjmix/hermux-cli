const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepoMessageHandler } = require('../src/gateway-repo-message-handler');

function makeDeps(overrides = {}) {
  const sent = [];
  const started = [];
  const deps = {
    parseCommand: (text) => {
      const raw = String(text || '').trim();
      if (!raw.startsWith('/')) return null;
      const parts = raw.split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    },
    safeSend: async (_bot, chatId, text, opts) => {
      sent.push({ chatId, text, opts });
      return { message_id: sent.length };
    },
    buildRuntimeStatusHtml: () => '<b>status</b>',
    buildStatusKeyboard: () => ({ inline_keyboard: [] }),
    handleModelsCommand: async () => {},
    getSessionInfo: () => null,
    SESSION_MAP_PATH: '/tmp/session-map.json',
    clearSessionId: () => false,
    handleRestartCommand: async () => {},
    getHelpText: () => 'help',
    sendTelegramFormattingShowcase: async () => {},
    sendRepoList: async () => {},
    handleVerboseAction: async () => {},
    requestInterrupt: () => ({ ok: true, alreadyRequested: false }),
    buildPromptFromMessage: async (_bot, _repo, msg) => ({ prompt: String(msg.text || '').trim() }),
    resolveRevertReplyTarget: () => null,
    createRevertConfirmation: async () => ({ text: 'confirm', opts: { reply_markup: { inline_keyboard: [] } } }),
    executeSessionUnrevert: async () => ({ text: 'unrevert ok' }),
    startPromptRun: async (_bot, repo, _state, queuedItem) => {
      started.push({ repo: repo.name, queuedItem });
    },
    ...overrides,
  };
  return { deps, sent, started };
}

test('repo handler routes /status to html status message', async () => {
  const { deps, sent } = makeDeps();
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, verbose: false, queue: [] }, {
    chat: { id: '100' },
    text: '/status',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '<b>status</b>');
  assert.equal(sent[0].opts.parse_mode, 'HTML');
});

test('repo handler keeps /interrupt invariant when idle', async () => {
  const { deps, sent } = makeDeps();
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, currentProc: null, queue: [] }, {
    chat: { id: '100' },
    text: '/interrupt',
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /No running task to interrupt/);
});

test('repo handler enqueues prompt while running and refreshes panel', async () => {
  let refreshed = false;
  const { deps, started } = makeDeps({
    buildPromptFromMessage: async () => ({ prompt: 'hello' }),
  });
  const handler = createRepoMessageHandler(deps);
  const state = {
    running: true,
    queue: [],
    panelRefresh: async (force) => {
      refreshed = !!force;
    },
  };

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, state, {
    chat: { id: '100' },
    text: 'hello',
  });

  assert.equal(state.queue.length, 1);
  assert.equal(refreshed, true);
  assert.equal(started.length, 0);
});

test('repo handler starts prompt immediately when idle', async () => {
  const { deps, started } = makeDeps({
    buildPromptFromMessage: async () => ({ prompt: 'run this' }),
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: 'run this',
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].repo, 'demo');
  assert.equal(started[0].queuedItem.chatId, '100');
  assert.equal(started[0].queuedItem.promptText, 'run this');
  assert.equal(started[0].queuedItem.isVersionPrompt, false);
});

test('repo handler enqueues burst in FIFO order with version metadata while running', async () => {
  let refreshCount = 0;
  const { deps, started } = makeDeps({
    buildPromptFromMessage: async (_bot, _repo, msg) => ({ prompt: String(msg.text || '').trim() }),
  });
  const handler = createRepoMessageHandler(deps);
  const state = {
    running: true,
    queue: [],
    panelRefresh: async (force) => {
      if (force) refreshCount += 1;
    },
  };

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, state, { chat: { id: '100' }, text: '/version' });
  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, state, { chat: { id: '100' }, text: 'follow-up-a' });
  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, state, { chat: { id: '100' }, text: 'follow-up-b' });

  assert.equal(started.length, 0);
  assert.equal(state.queue.length, 3);
  assert.equal(state.queue[0].promptText, '/version');
  assert.equal(state.queue[0].isVersionPrompt, true);
  assert.equal(state.queue[1].promptText, 'follow-up-a');
  assert.equal(state.queue[1].isVersionPrompt, false);
  assert.equal(state.queue[2].promptText, 'follow-up-b');
  assert.equal(state.queue[2].isVersionPrompt, false);
  assert.equal(refreshCount, 3);
});

test('repo handler starts /version immediately with version prompt metadata when idle', async () => {
  const { deps, started } = makeDeps({
    buildPromptFromMessage: async () => ({ prompt: '/version' }),
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: '/version',
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].queuedItem.promptText, '/version');
  assert.equal(started[0].queuedItem.isVersionPrompt, true);
});

test('repo handler returns no-session guidance for /session when mapping is empty', async () => {
  const { deps, sent } = makeDeps({
    getSessionInfo: () => null,
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: '/session',
  });

  assert.match(sent[0].text, /No active session for this chat yet/);
});

test('repo handler returns session details for /session when session exists', async () => {
  const { deps, sent } = makeDeps({
    getSessionInfo: () => ({ sessionId: 'ses-123', updatedAt: '2026-01-01T00:00:00.000Z' }),
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: '/session',
  });

  assert.match(sent[0].text, /session_id: ses-123/);
  assert.match(sent[0].text, /state_file: \/tmp\/session-map\.json/);
});

test('repo handler blocks /reset while running', async () => {
  const { deps, sent } = makeDeps();
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: true, queue: [] }, {
    chat: { id: '100' },
    text: '/reset',
  });

  assert.match(sent[0].text, /Cannot reset while running/);
});

test('repo handler emits reset success text when clearSessionId succeeds', async () => {
  const { deps, sent } = makeDeps({
    clearSessionId: () => true,
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: '/reset',
  });

  assert.match(sent[0].text, /Session reset complete for repo demo/);
});

test('repo handler maps /verbose on and /verbose off actions', async () => {
  const verboseActions = [];
  const { deps } = makeDeps({
    handleVerboseAction: async (_bot, _chatId, _state, action) => {
      verboseActions.push(action);
    },
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, { chat: { id: '100' }, text: '/verbose on' });
  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, { chat: { id: '100' }, text: '/verbose off' });

  assert.deepEqual(verboseActions, ['on', 'off']);
});

test('repo handler handles interrupt failure path', async () => {
  const { deps, sent } = makeDeps({
    requestInterrupt: () => ({ ok: false, error: new Error('interrupt boom') }),
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: true, currentProc: { pid: 1 }, queue: [] }, {
    chat: { id: '100' },
    text: '/interrupt',
  });

  assert.match(sent[0].text, /Failed to interrupt current task: interrupt boom/);
});

test('repo handler handles prompt preparation error with recovery message', async () => {
  const { deps, sent, started } = makeDeps({
    buildPromptFromMessage: async () => {
      throw new Error('attachment unreadable');
    },
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: 'hello',
  });

  assert.match(sent[0].text, /Failed to read image attachment: attachment unreadable/);
  assert.equal(started.length, 0);
});

test('repo handler requires reply context for /revert', async () => {
  const { deps, sent } = makeDeps();
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: '/revert',
  });

  assert.match(sent[0].text, /Reply to a previous bot output message/);
});

test('repo handler sends revert confirmation when replied target exists', async () => {
  let called = 0;
  const { deps, sent } = makeDeps({
    resolveRevertReplyTarget: () => ({
      repoName: 'demo',
      sessionId: 'ses-1',
      messageId: 'msg-9',
      partId: 'part-3',
    }),
    createRevertConfirmation: async (_bot, _chatId, _repo, _state, input) => {
      called += 1;
      assert.equal(input.replyMessageId, 777);
      return { text: 'confirm revert', opts: { reply_markup: { inline_keyboard: [] } } };
    },
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    from: { id: 123 },
    text: '/revert',
    reply_to_message: { message_id: 777, text: 'old output' },
  });

  assert.equal(called, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'confirm revert');
});

test('repo handler executes /unrevert via injected runner action', async () => {
  let calls = 0;
  const { deps, sent } = makeDeps({
    executeSessionUnrevert: async (repo, chatId) => {
      calls += 1;
      assert.equal(repo.name, 'demo');
      assert.equal(chatId, '100');
      return { text: 'unrevert done' };
    },
  });
  const handler = createRepoMessageHandler(deps);

  await handler({}, { name: 'demo', workdir: '/tmp/demo' }, { running: false, queue: [] }, {
    chat: { id: '100' },
    text: '/unrevert',
  });

  assert.equal(calls, 1);
  assert.equal(sent[0].text, 'unrevert done');
});
