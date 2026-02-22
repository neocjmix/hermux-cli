const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageHandler } = require('../src/gateway-message-handler');

function makeHarness(overrides = {}) {
  const calls = {
    safeSend: [],
    repoDispatch: 0,
    withStateDispatchLock: 0,
    onboard: 0,
    init: 0,
    onboardingInput: 0,
    testShowcase: 0,
    repos: 0,
    connect: 0,
  };

  const bot = {};
  const chatRouter = new Map();
  const states = new Map();
  const onboardingSessions = new Map();
  const initSessions = new Map();

  const deps = {
    bot,
    chatRouter,
    states,
    onboardingSessions,
    initSessions,
    parseCommand: (text) => {
      const raw = String(text || '').trim();
      if (!raw.startsWith('/')) return null;
      const parts = raw.split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    },
    handleOnboardCommand: async () => {
      calls.onboard += 1;
    },
    handleInitCommand: async () => {
      calls.init += 1;
    },
    handleOnboardingInput: async () => {
      calls.onboardingInput += 1;
    },
    safeSend: async (_bot, chatId, text) => {
      calls.safeSend.push({ chatId, text });
    },
    getHelpText: () => 'help',
    sendTelegramFormattingShowcase: async () => {
      calls.testShowcase += 1;
    },
    sendRepoList: async () => {
      calls.repos += 1;
    },
    handleConnectCommand: async () => {
      calls.connect += 1;
    },
    withStateDispatchLock: async (_state, task) => {
      calls.withStateDispatchLock += 1;
      await task();
    },
    handleRepoMessage: async () => {
      calls.repoDispatch += 1;
    },
    ...overrides,
  };

  return { calls, deps, bot, chatRouter, states, onboardingSessions, initSessions };
}

test('message handler delegates /onboard to onboarding command flow', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/onboard' });

  assert.equal(calls.onboard, 1);
});

test('message handler keeps onboarding input lock with command guard', async () => {
  const { calls, deps, onboardingSessions } = makeHarness();
  onboardingSessions.set('100', { step: 'repo_name' });
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/status' });

  assert.equal(calls.safeSend.length, 1);
  assert.match(calls.safeSend[0].text, /Onboarding in progress/);
});

test('message handler returns setup guidance for unmapped runtime command', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/start' });

  assert.equal(calls.safeSend.length, 1);
  assert.match(calls.safeSend[0].text, /not mapped to any repo/);
});

test('message handler dispatches mapped chat through state lock and repo handler', async () => {
  const { calls, deps, chatRouter, states } = makeHarness();
  chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  states.set('demo', { running: false, queue: [] });
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: 'run prompt' });

  assert.equal(calls.withStateDispatchLock, 1);
  assert.equal(calls.repoDispatch, 1);
});

test('message handler serializes concurrent mapped messages and preserves run-lock queue transition', async () => {
  const lock = { chain: Promise.resolve() };
  const { calls, deps, chatRouter, states } = makeHarness({
    withStateDispatchLock: async (state, task) => {
      calls.withStateDispatchLock += 1;
      lock.chain = lock.chain.then(async () => {
        await task();
      });
      await lock.chain;
      return state;
    },
    handleRepoMessage: async (_bot, _repo, state, msg) => {
      calls.repoDispatch += 1;
      if (!state.running) {
        state.running = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return;
      }
      state.queue.push({ promptText: msg.text });
    },
  });

  chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  const state = { running: false, queue: [] };
  states.set('demo', state);

  const handler = createMessageHandler(deps);
  await Promise.all([
    handler({ chat: { id: '100' }, text: 'prompt-a' }),
    handler({ chat: { id: '100' }, text: 'prompt-b' }),
  ]);

  assert.equal(calls.withStateDispatchLock, 2);
  assert.equal(calls.repoDispatch, 2);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].promptText, 'prompt-b');
});

test('message handler serializes concurrent mapped messages through lock', async () => {
  const sequence = [];
  let dispatchLock = Promise.resolve();
  const { deps, chatRouter, states } = makeHarness({
    withStateDispatchLock: async (_state, task) => {
      const run = dispatchLock.then(task);
      dispatchLock = run.catch(() => {});
      await run;
    },
    handleRepoMessage: async (_bot, _repo, _state, msg) => {
      sequence.push(`start:${msg.text}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      sequence.push(`end:${msg.text}`);
    },
  });
  chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  states.set('demo', { running: false, queue: [] });
  const handler = createMessageHandler(deps);

  await Promise.all([
    handler({ chat: { id: '100' }, text: 'a' }),
    handler({ chat: { id: '100' }, text: 'b' }),
  ]);

  assert.deepEqual(sequence, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('message handler delegates /init to init command flow', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/init' });

  assert.equal(calls.init, 1);
});

test('message handler routes onboarding free text to onboarding input handler', async () => {
  const { calls, deps, onboardingSessions } = makeHarness();
  onboardingSessions.set('100', { step: 'repo_name' });
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: 'my-repo' });

  assert.equal(calls.onboardingInput, 1);
  assert.equal(calls.safeSend.length, 0);
});

test('message handler routes /help to help text sender', async () => {
  const { calls, deps } = makeHarness({ getHelpText: () => 'help-text' });
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/help' });

  assert.equal(calls.safeSend.length, 1);
  assert.equal(calls.safeSend[0].text, 'help-text');
});

test('message handler routes /test to telegram formatting showcase', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/test' });

  assert.equal(calls.testShowcase, 1);
});

test('message handler routes /repos to repo listing handler', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/repos' });

  assert.equal(calls.repos, 1);
});

test('message handler routes /connect to connect handler', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: '/connect demo' });

  assert.equal(calls.connect, 1);
});

test('message handler returns setup guidance for unmapped plain text input', async () => {
  const { calls, deps } = makeHarness();
  const handler = createMessageHandler(deps);

  await handler({ chat: { id: '100' }, text: 'hello there' });

  assert.equal(calls.safeSend.length, 1);
  assert.match(calls.safeSend[0].text, /This chat is not mapped yet/);
});
