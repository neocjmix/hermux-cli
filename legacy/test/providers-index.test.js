const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const providers = require('../src/providers');
const upstreamOpencode = require('../src/providers/upstream/opencode');
const downstreamTelegram = require('../src/providers/downstream/telegram');
const runnerCompat = require('../src/lib/runner');
const upstreamRunner = require('../src/providers/upstream/opencode/runner');

test('provider registry resolves configured upstream and downstream providers', () => {
  assert.equal(Object.isFrozen(providers.selection), true);
  assert.equal(providers.selection.upstream, 'opencode');
  assert.equal(providers.selection.downstream, 'telegram');
  assert.equal(typeof providers.upstreamStrategies.opencode, 'function');
  assert.equal(typeof providers.downstreamStrategies.telegram, 'function');

  const upstream = providers.resolveUpstreamProvider('opencode');
  const downstream = providers.resolveDownstreamProvider('telegram');

  assert.equal(upstream.runOpencode, upstreamOpencode.runOpencode);
  assert.equal(upstream.subscribeSessionEvents, upstreamOpencode.subscribeSessionEvents);
  assert.equal(downstream.TelegramBot, downstreamTelegram.TelegramBot);
  assert.equal(downstream.reconcileRunViewForTelegram, downstreamTelegram.reconcileRunViewForTelegram);
});

test('provider registry rejects unsupported provider ids', () => {
  assert.throws(() => providers.resolveUpstreamProvider('unknown-upstream'), /unsupported upstream provider/);
  assert.throws(() => providers.resolveDownstreamProvider('unknown-downstream'), /unsupported downstream provider/);
});

test('lib runner remains a compatibility shim over the opencode upstream runner', () => {
  assert.deepEqual(Object.keys(runnerCompat).sort(), Object.keys(upstreamRunner).sort());
  assert.equal(runnerCompat.runOpencode, upstreamRunner.runOpencode);
  assert.equal(runnerCompat.subscribeSessionEvents, upstreamRunner.subscribeSessionEvents);
  assert.equal(runnerCompat.stopAllRuntimeExecutors, upstreamRunner.stopAllRuntimeExecutors);
});

test('provider registry rejects empty and whitespace-only provider ids', () => {
  assert.throws(() => providers.resolveUpstreamProvider(''), /unsupported upstream provider/);
  assert.throws(() => providers.resolveUpstreamProvider('  '), /unsupported upstream provider/);
  assert.throws(() => providers.resolveUpstreamProvider(null), /unsupported upstream provider/);
  assert.throws(() => providers.resolveDownstreamProvider(''), /unsupported downstream provider/);
  assert.throws(() => providers.resolveDownstreamProvider(undefined), /unsupported downstream provider/);
});

test('provider-selection module is frozen and exports only upstream and downstream', () => {
  const selection = require('../src/provider-selection');
  assert.equal(Object.isFrozen(selection), true);
  assert.deepEqual(Object.keys(selection).sort(), ['downstream', 'upstream']);
  assert.equal(typeof selection.upstream, 'string');
  assert.equal(typeof selection.downstream, 'string');
});
