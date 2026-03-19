'use strict';

const downstreamStrategies = Object.freeze({
  telegram: () => require('./telegram'),
});

function resolveDownstreamProvider(id) {
  const key = String(id || '').trim();
  const loader = downstreamStrategies[key];
  if (!loader) throw new Error(`unsupported downstream provider: ${key}`);
  return loader();
}

module.exports = {
  downstreamStrategies,
  resolveDownstreamProvider,
};
