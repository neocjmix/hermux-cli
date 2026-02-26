'use strict';

const selection = require('../provider-selection');

const upstreamStrategies = Object.freeze({
  opencode: () => require('./upstream/opencode'),
});

const downstreamStrategies = Object.freeze({
  telegram: () => require('./downstream/telegram'),
});

function resolveUpstreamProvider(id) {
  const key = String(id || '').trim();
  const loader = upstreamStrategies[key];
  if (!loader) throw new Error(`unsupported upstream provider: ${key}`);
  return loader();
}

function resolveDownstreamProvider(id) {
  const key = String(id || '').trim();
  const loader = downstreamStrategies[key];
  if (!loader) throw new Error(`unsupported downstream provider: ${key}`);
  return loader();
}

module.exports = {
  selection,
  resolveUpstreamProvider,
  resolveDownstreamProvider,
};
