'use strict';

const upstreamStrategies = Object.freeze({
  opencode: () => require('./opencode'),
});

function resolveUpstreamProvider(id) {
  const key = String(id || '').trim();
  const loader = upstreamStrategies[key];
  if (!loader) throw new Error(`unsupported upstream provider: ${key}`);
  return loader();
}

module.exports = {
  upstreamStrategies,
  resolveUpstreamProvider,
};
