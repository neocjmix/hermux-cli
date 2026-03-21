const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const { createModelControlService } = require('../src/app/model-control-service');

function makeService(overrides = {}) {
  const writes = [];
  const modelUiState = new Map();
  const deps = {
    modelUiState,
    buildModelsSummaryHtml: () => ({ html: '<b>models</b>' }),
    buildModelsRootKeyboard: () => ({ inline_keyboard: [['root']] }),
    getProviderModelChoices: () => [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    getModelsSnapshot: () => ({ agentNames: ['sisyphus'] }),
    buildProviderPickerKeyboard: () => ({ inline_keyboard: [['provider']] }),
    buildAgentPickerKeyboard: () => ({ inline_keyboard: [['agent']] }),
    buildModelPickerKeyboard: () => ({ inline_keyboard: [['model']] }),
    escapeHtml: (value) => String(value),
    readJsonOrDefault: () => ({}),
    writeJsonAtomic: (targetPath, cfg) => writes.push({ path: targetPath, cfg }),
    OPENCODE_CONFIG_PATH: '/tmp/op.json',
    OMO_CONFIG_PATH: '/tmp/omo.json',
    getOmoAgentEntry: (cfg, agent) => {
      if (!cfg.agents) cfg.agents = {};
      if (!cfg.agents[agent]) cfg.agents[agent] = {};
      return cfg.agents[agent];
    },
    ...overrides,
  };
  return {
    service: createModelControlService(deps),
    modelUiState,
    writes,
  };
}

// BOUNDARY NOTE: These tests assert Telegram-specific options (parse_mode, reply_markup)
// returned from app services. Per BOUNDARY_AUDIT #7, app services should return
// channel-agnostic data; downstream adapters should apply channel formatting.
// During rebuild, these assertions must change to channel-agnostic shapes.

test('model control service opens op provider selection and stores UI state', () => {
  const { service, modelUiState } = makeService();

  const result = service.openOpProviderSelection('100');

  assert.equal(result.answerText, 'choose provider');
  assert.equal(result.message, '<pre>① opencode\nprovider 선택</pre>');
  assert.deepEqual(result.opts, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [['provider']] } });
  assert.deepEqual(modelUiState.get('100'), {
    layer: 'op',
    providers: [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    selectedProvider: -1,
    modelPage: 0,
  });
});

test('model control service applies selected op model through config write', () => {
  const { service, modelUiState, writes } = makeService();
  modelUiState.set('100', {
    layer: 'op',
    providers: [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    selectedProvider: 0,
    modelPage: 0,
  });

  const result = service.applyOpModel('100', 0);

  assert.equal(result.answerText, 'applied');
  assert.equal(result.message, '<pre>① opencode\nopencode:openai/gpt-5.3-codex</pre>');
  assert.deepEqual(writes, [{ path: '/tmp/op.json', cfg: { model: 'openai/gpt-5.3-codex' } }]);
});

test('model control service applies omo model through config write', () => {
  const { service, modelUiState, writes } = makeService();
  modelUiState.set('100', {
    layer: 'omo',
    agent: 'sisyphus',
    providers: [{ providerId: 'openai', models: ['openai/gpt-5.3-codex'] }],
    selectedProvider: 0,
    modelPage: 0,
  });

  const result = service.applyOmoModel('100', 0);

  assert.equal(result.answerText, 'applied');
  assert.equal(result.message, '<pre>② oh-my-opencode\nsisyphus:openai/gpt-5.3-codex</pre>');
  assert.deepEqual(writes, [{ path: '/tmp/omo.json', cfg: { agents: { sisyphus: { model: 'openai/gpt-5.3-codex' } } } }]);
});

test('model control service rejects invalid selections without writing config', () => {
  const { service, writes } = makeService();

  const opResult = service.applyOpModel('100', 0);
  const omoResult = service.applyOmoModel('100', 0);

  assert.match(opResult.message, /Invalid model selection/);
  assert.match(omoResult.message, /Invalid agent\/model selection/);
  assert.deepEqual(writes, []);
});
