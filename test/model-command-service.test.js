const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const { createModelCommandService } = require('../src/app/model-command-service');

function makeService(overrides = {}) {
  const writes = [];
  const deps = {
    buildModelsSummaryHtml: (repoName) => ({ html: `<b>${repoName}</b>` }),
    buildModelsRootKeyboard: () => ({ inline_keyboard: [['root']] }),
    buildModelApplyMessage: (meta) => JSON.stringify(meta),
    readJsonOrDefault: () => ({}),
    writeJsonAtomic: (targetPath, cfg) => writes.push({ path: targetPath, cfg }),
    isValidModelRef: (value) => /.+\/.+/.test(String(value || '')),
    getOmoAgentEntry: (cfg, agent) => {
      if (!cfg.agents) cfg.agents = {};
      if (!cfg.agents[agent]) cfg.agents[agent] = {};
      return cfg.agents[agent];
    },
    OPENCODE_CONFIG_PATH: '/tmp/op.json',
    OMO_CONFIG_PATH: '/tmp/omo.json',
    ...overrides,
  };
  return {
    service: createModelCommandService(deps),
    writes,
  };
}

// BOUNDARY NOTE: These tests assert Telegram-specific options (parse_mode, reply_markup)
// returned from app services. Per BOUNDARY_AUDIT #7, app services should return
// channel-agnostic data; downstream adapters should apply channel formatting.
// During rebuild, these assertions must change to channel-agnostic shapes.

test('model command service returns summary view when no args are provided', () => {
  const { service } = makeService();
  const result = service.execute({ repoName: 'demo', running: false, args: [] });

  assert.equal(result.text, '<b>demo</b>');
  assert.deepEqual(result.opts, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [['root']] } });
});

test('model command service applies opencode set and writes config', () => {
  const { service, writes } = makeService({
    readJsonOrDefault: () => ({ model: 'openai/old' }),
  });

  const result = service.execute({ repoName: 'demo', running: false, args: ['opencode', 'set', 'openai/new'] });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/tmp/op.json');
  assert.equal(writes[0].cfg.model, 'openai/new');
  assert.match(result.text, /"layer":"opencode"/);
});

test('model command service rejects invalid opencode model ref', () => {
  const { service, writes } = makeService();

  const result = service.execute({ repoName: 'demo', running: false, args: ['opencode', 'set', 'invalid'] });

  assert.match(result.text, /Invalid model format/);
  assert.equal(writes.length, 0);
});

test('model command service applies omo primary and fallback changes', () => {
  const { service, writes } = makeService({
    readJsonOrDefault: () => ({ agents: { sisyphus: { model: 'openai/old' } } }),
  });

  const primary = service.execute({ repoName: 'demo', running: true, args: ['omo', 'set', 'sisyphus', 'primary', 'openai/new'] });
  const fallback = service.execute({ repoName: 'demo', running: false, args: ['omo', 'set', 'sisyphus', 'fallback', 'openai/fallback'] });

  assert.equal(writes.length, 2);
  assert.match(primary.text, /"layer":"omo\/sisyphus"/);
  assert.match(fallback.text, /"after":"openai\/fallback"/);
});

test('model command service clears omo agent entry', () => {
  const { service, writes } = makeService({
    readJsonOrDefault: () => ({ agents: { sisyphus: { model: 'openai/old' } } }),
  });

  const result = service.execute({ repoName: 'demo', running: false, args: ['omo', 'clear', 'sisyphus'] });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].cfg, { agents: {} });
  assert.match(result.text, /"after":"\(unset\)"/);
});
