const test = require('node:test');
const assert = require('node:assert/strict');

const { createCallbackQueryHandler } = require('../src/gateway-callback-query-handler');

function makeHarness(overrides = {}) {
  const safeSendCalls = [];
  const answerCalls = [];
  const connectCalls = [];
  const verboseCalls = [];
  const requestInterruptCalls = [];
  const writes = [];
  const modelUiState = new Map();
  const chatRouter = new Map();
  const states = new Map();

  const bot = {
    answerCallbackQuery: async (id, payload) => {
      answerCalls.push({ id, payload });
    },
  };

  const deps = {
    bot,
    chatRouter,
    states,
    modelUiState,
    safeSend: async (_bot, chatId, text, opts) => {
      safeSendCalls.push({ chatId, text, opts });
    },
    handleConnectCommand: async (_bot, chatId, args) => {
      connectCalls.push({ chatId, args });
    },
    handleVerboseAction: async (_bot, chatId, _state, action) => {
      verboseCalls.push({ chatId, action });
    },
    requestInterrupt: (state, opts) => {
      requestInterruptCalls.push({ state, opts });
      return { ok: true, alreadyRequested: false };
    },
    buildModelsSummaryHtml: () => ({ html: '<b>models</b>' }),
    buildModelsRootKeyboard: () => ({ inline_keyboard: [] }),
    getProviderModelChoices: () => [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    buildProviderPickerKeyboard: () => ({ inline_keyboard: [] }),
    getModelsSnapshot: () => ({ agentNames: ['sisyphus'] }),
    buildAgentPickerKeyboard: () => ({ inline_keyboard: [] }),
    escapeHtml: (s) => String(s),
    buildModelPickerKeyboard: () => ({ inline_keyboard: [] }),
    readJsonOrDefault: () => ({}),
    writeJsonAtomic: (path, cfg) => {
      writes.push({ path, cfg });
    },
    OPENCODE_CONFIG_PATH: '/tmp/op.json',
    OMO_CONFIG_PATH: '/tmp/omo.json',
    getOmoAgentEntry: (cfg, agent) => {
      if (!cfg.agents) cfg.agents = {};
      if (!cfg.agents[agent]) cfg.agents[agent] = {};
      return cfg.agents[agent];
    },
    handleRevertConfirmCallback: async () => ({ answerText: 'reverted' }),
    handleRevertCancelCallback: () => ({ answerText: 'cancelled' }),
    ...overrides,
  };

  const handler = createCallbackQueryHandler(deps);
  return {
    handler,
    modelUiState,
    chatRouter,
    states,
    safeSendCalls,
    answerCalls,
    connectCalls,
    verboseCalls,
    requestInterruptCalls,
    writes,
  };
}

test('callback handler routes connect callback to connect command', async () => {
  const h = makeHarness();

  await h.handler({
    id: 'q1',
    data: 'connect:demo',
    message: { chat: { id: '100' } },
  });

  assert.equal(h.connectCalls.length, 1);
  assert.deepEqual(h.connectCalls[0], { chatId: '100', args: ['demo'] });
  assert.equal(h.answerCalls[0].payload.text, 'connect: demo');
});

test('callback handler returns not-mapped response for verbose action', async () => {
  const h = makeHarness();

  await h.handler({
    id: 'q2',
    data: 'verbose:on',
    message: { chat: { id: '100' } },
  });

  assert.equal(h.safeSendCalls.length, 1);
  assert.match(h.safeSendCalls[0].text, /not mapped to a repo/);
  assert.equal(h.answerCalls[0].payload.text, 'not mapped');
  assert.equal(h.verboseCalls.length, 0);
});

test('callback handler keeps interrupt idle invariant for mapped repo', async () => {
  const h = makeHarness();
  h.chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  h.states.set('demo', { running: false, currentProc: null });

  await h.handler({
    id: 'q3',
    data: 'interrupt:now',
    message: { chat: { id: '100' } },
  });

  assert.equal(h.requestInterruptCalls.length, 0);
  assert.equal(h.safeSendCalls.length, 1);
  assert.match(h.safeSendCalls[0].text, /No running task to interrupt/);
  assert.equal(h.answerCalls[0].payload.text, 'idle');
});

test('callback handler enters provider picker for op model layer', async () => {
  const h = makeHarness();

  await h.handler({
    id: 'q4',
    data: 'm:l:op',
    message: { chat: { id: '100' } },
  });

  const st = h.modelUiState.get('100');
  assert.equal(st.layer, 'op');
  assert.equal(st.selectedProvider, -1);
  assert.equal(st.modelPage, 0);
  assert.equal(h.answerCalls[0].payload.text, 'choose provider');
});

test('callback handler applies selected opencode model', async () => {
  const h = makeHarness();
  h.modelUiState.set('100', {
    layer: 'op',
    providers: [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    selectedProvider: 0,
    modelPage: 0,
  });

  await h.handler({
    id: 'q5',
    data: 'm:o:0',
    message: { chat: { id: '100' } },
  });

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/tmp/op.json');
  assert.equal(h.writes[0].cfg.model, 'openai/gpt-5.3-codex');
  assert.equal(h.answerCalls[0].payload.text, 'applied');
});

test('callback handler acknowledges invalid callback context without side effects', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q6', data: '', message: { chat: { id: '100' } } });

  assert.equal(h.answerCalls.length, 1);
  assert.equal(h.safeSendCalls.length, 0);
  assert.equal(h.connectCalls.length, 0);
});

test('callback handler routes mapped verbose unknown action to status', async () => {
  const h = makeHarness();
  h.chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  h.states.set('demo', { running: false });

  await h.handler({ id: 'q7', data: 'verbose:bogus', message: { chat: { id: '100' } } });

  assert.equal(h.verboseCalls.length, 1);
  assert.equal(h.verboseCalls[0].action, 'status');
  assert.equal(h.answerCalls[0].payload.text, 'verbose: bogus');
});

test('callback handler handles interrupt running path with already requested status', async () => {
  const h = makeHarness({
    requestInterrupt: (state, opts) => {
      h.requestInterruptCalls.push({ state, opts });
      return { ok: true, alreadyRequested: true };
    },
  });
  h.chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  h.states.set('demo', { running: true, currentProc: { pid: 1 } });

  await h.handler({ id: 'q8', data: 'interrupt:now', message: { chat: { id: '100' } } });

  assert.equal(h.requestInterruptCalls.length, 1);
  assert.equal(h.requestInterruptCalls[0].opts.forceAfterMs, 5000);
  assert.match(h.safeSendCalls[0].text, /Interrupt already requested/);
  assert.equal(h.answerCalls[0].payload.text, 'interrupt');
});

test('callback handler handles interrupt failure path', async () => {
  const h = makeHarness({
    requestInterrupt: (state, opts) => {
      h.requestInterruptCalls.push({ state, opts });
      return { ok: false, error: new Error('boom') };
    },
  });
  h.chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });
  h.states.set('demo', { running: true, currentProc: { pid: 1 } });

  await h.handler({ id: 'q9', data: 'interrupt:now', message: { chat: { id: '100' } } });

  assert.equal(h.requestInterruptCalls.length, 1);
  assert.match(h.safeSendCalls[0].text, /Failed to interrupt current task: boom/);
  assert.equal(h.answerCalls[0].payload.text, 'interrupt');
});

test('callback handler renders models root summary for mapped repo', async () => {
  const h = makeHarness();
  h.chatRouter.set('100', { name: 'demo', workdir: '/tmp/demo' });

  await h.handler({ id: 'q10', data: 'm:r', message: { chat: { id: '100' } } });

  assert.equal(h.safeSendCalls.length, 1);
  assert.equal(h.safeSendCalls[0].opts.parse_mode, 'HTML');
  assert.equal(h.answerCalls[0].payload.text, 'models');
});

test('callback handler reports no providers for m:l:op', async () => {
  const h = makeHarness({
    getProviderModelChoices: () => [],
  });

  await h.handler({ id: 'q11', data: 'm:l:op', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /No model choices found/);
  assert.equal(h.modelUiState.has('100'), false);
  assert.equal(h.answerCalls[0].payload.text, 'choose provider');
});

test('callback handler reports no agents for m:l:omo', async () => {
  const h = makeHarness({
    getModelsSnapshot: () => ({ agentNames: [] }),
  });

  await h.handler({ id: 'q12', data: 'm:l:omo', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /No configured agents/);
  assert.equal(h.modelUiState.has('100'), false);
  assert.equal(h.answerCalls[0].payload.text, 'choose agent');
});

test('callback handler rejects invalid agent picker selection', async () => {
  const h = makeHarness({
    getProviderModelChoices: () => [],
  });
  h.modelUiState.set('100', { layer: 'omo', agentNames: ['sisyphus'] });

  await h.handler({ id: 'q13', data: 'm:a:0', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /Unable to open provider choices/);
  assert.equal(h.answerCalls[0].payload.text, 'choose provider');
});

test('callback handler rejects invalid provider selection in m:p', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q14', data: 'm:p:0', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /Invalid provider selection/);
  assert.equal(h.answerCalls[0].payload.text, 'choose model');
});

test('callback handler handles m:bp without providers by only acknowledging callback', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q15', data: 'm:bp', message: { chat: { id: '100' } } });

  assert.equal(h.safeSendCalls.length, 0);
  assert.equal(h.answerCalls[0].payload.text, 'back');
});

test('callback handler handles m:mp page navigation provider-missing path', async () => {
  const h = makeHarness({});
  h.modelUiState.set('100', { layer: 'op', providers: [], selectedProvider: -1, modelPage: 0 });

  await h.handler({ id: 'q16', data: 'm:mp:next', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /Provider를 다시 선택해줘/);
  assert.equal(h.answerCalls[0].payload.text, 'page');
});

test('callback handler rejects invalid omo model selection path', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q17', data: 'm:s:0', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /Invalid agent\/model selection/);
  assert.equal(h.answerCalls[0].payload.text, 'applied');
});

test('callback handler applies selected omo agent model', async () => {
  const h = makeHarness();
  h.modelUiState.set('100', {
    layer: 'omo',
    agent: 'sisyphus',
    providers: [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    selectedProvider: 0,
    modelPage: 0,
  });

  await h.handler({ id: 'q18', data: 'm:s:0', message: { chat: { id: '100' } } });

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/tmp/omo.json');
  assert.equal(h.writes[0].cfg.agents.sisyphus.model, 'openai/gpt-5.3-codex');
  assert.equal(h.answerCalls[0].payload.text, 'applied');
});

test('callback handler falls back to plain ack on unknown callback data', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q19', data: 'unknown:payload', message: { chat: { id: '100' } } });

  assert.equal(h.safeSendCalls.length, 0);
  assert.equal(h.answerCalls.length, 1);
  assert.equal(h.answerCalls[0].id, 'q19');
  assert.equal(h.answerCalls[0].payload, undefined);
});

test('callback handler returns unmapped message for interrupt callback in unmapped chat', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q20', data: 'interrupt:now', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /not mapped to a repo/);
  assert.equal(h.answerCalls[0].payload.text, 'not mapped');
});

test('callback handler returns unmapped message for models root callback in unmapped chat', async () => {
  const h = makeHarness();

  await h.handler({ id: 'q21', data: 'm:r', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /not mapped to a repo/);
  assert.equal(h.answerCalls[0].payload.text, 'not mapped');
});

test('callback handler enters omo agent picker happy path', async () => {
  const h = makeHarness({
    getModelsSnapshot: () => ({ agentNames: ['sisyphus', 'metis'] }),
  });

  await h.handler({ id: 'q22', data: 'm:l:omo', message: { chat: { id: '100' } } });

  const st = h.modelUiState.get('100');
  assert.equal(st.layer, 'omo');
  assert.deepEqual(st.agentNames, ['sisyphus', 'metis']);
  assert.equal(h.answerCalls[0].payload.text, 'choose agent');
});

test('callback handler routes revert confirm callback', async () => {
  let called = 0;
  const h = makeHarness({
    handleRevertConfirmCallback: async (_bot, query, _chatRouter, _states, token) => {
      called += 1;
      assert.equal(query.id, 'q23');
      assert.equal(token, 'tok123');
      return { answerText: 'reverted' };
    },
  });

  await h.handler({ id: 'q23', data: 'rv:c:tok123', message: { chat: { id: '100' } } });

  assert.equal(called, 1);
  assert.equal(h.answerCalls[0].payload.text, 'reverted');
});

test('callback handler routes revert cancel callback', async () => {
  let called = 0;
  const h = makeHarness({
    handleRevertCancelCallback: (token) => {
      called += 1;
      assert.equal(token, 'tok987');
      return { answerText: 'cancelled' };
    },
  });

  await h.handler({ id: 'q24', data: 'rv:x:tok987', message: { chat: { id: '100' } } });

  assert.equal(called, 1);
  assert.equal(h.answerCalls[0].payload.text, 'cancelled');
});

test('callback handler enters provider picker from agent selection happy path', async () => {
  const h = makeHarness({
    getProviderModelChoices: () => [{ providerId: 'openai', models: ['m1', 'm2'] }],
  });
  h.modelUiState.set('100', { layer: 'omo', agentNames: ['sisyphus'] });

  await h.handler({ id: 'q23', data: 'm:a:0', message: { chat: { id: '100' } } });

  const st = h.modelUiState.get('100');
  assert.equal(st.layer, 'omo');
  assert.equal(st.agent, 'sisyphus');
  assert.equal(st.selectedProvider, -1);
  assert.equal(h.answerCalls[0].payload.text, 'choose provider');
});

test('callback handler selects provider and renders model picker in m:p happy path', async () => {
  const h = makeHarness();
  h.modelUiState.set('100', {
    layer: 'op',
    providers: [{ providerId: 'openai', models: ['m1', 'm2'] }],
    selectedProvider: -1,
    modelPage: 3,
  });

  await h.handler({ id: 'q24', data: 'm:p:0', message: { chat: { id: '100' } } });

  const st = h.modelUiState.get('100');
  assert.equal(st.selectedProvider, 0);
  assert.equal(st.modelPage, 0);
  assert.equal(h.answerCalls[0].payload.text, 'choose model');
});

test('callback handler renders back-to-provider panel when providers are present', async () => {
  const h = makeHarness();
  h.modelUiState.set('100', {
    layer: 'omo',
    providers: [{ providerId: 'openai', models: ['m1'] }],
  });

  await h.handler({ id: 'q25', data: 'm:bp', message: { chat: { id: '100' } } });

  assert.equal(h.safeSendCalls.length, 1);
  assert.equal(h.safeSendCalls[0].opts.parse_mode, 'HTML');
  assert.equal(h.answerCalls[0].payload.text, 'back');
});

test('callback handler paginates model picker in m:mp happy path', async () => {
  const h = makeHarness();
  h.modelUiState.set('100', {
    layer: 'op',
    providers: [{ providerId: 'openai', models: Array.from({ length: 21 }, (_, i) => `m${i}`) }],
    selectedProvider: 0,
    modelPage: 0,
  });

  await h.handler({ id: 'q26', data: 'm:mp:next', message: { chat: { id: '100' } } });

  const st = h.modelUiState.get('100');
  assert.equal(st.modelPage, 1);
  assert.equal(h.answerCalls[0].payload.text, 'page');
});

test('callback handler reports invalid model selection for m:o invalid index', async () => {
  const h = makeHarness();
  h.modelUiState.set('100', {
    layer: 'op',
    providers: [{ providerId: 'openai', models: ['only-model'] }],
    selectedProvider: 0,
    modelPage: 0,
  });

  await h.handler({ id: 'q27', data: 'm:o:99', message: { chat: { id: '100' } } });

  assert.match(h.safeSendCalls[0].text, /Invalid model selection/);
  assert.equal(h.answerCalls[0].payload.text, 'applied');
});

test('callback handler catch path logs error and still answers callback', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args.join(' '));
  };

  try {
    const h = makeHarness({
      buildModelPickerKeyboard: () => {
        throw new Error('render fail');
      },
    });
    h.modelUiState.set('100', {
      layer: 'op',
      providers: [{ providerId: 'openai', models: ['m1'] }],
      selectedProvider: 0,
      modelPage: 0,
    });

    await h.handler({ id: 'q28', data: 'm:p:0', message: { chat: { id: '100' } } });

    assert.equal(h.answerCalls.length, 1);
    assert.equal(h.answerCalls[0].id, 'q28');
    assert.equal(h.answerCalls[0].payload, undefined);
    assert.equal(errors.length > 0, true);
  } finally {
    console.error = originalError;
  }
});
