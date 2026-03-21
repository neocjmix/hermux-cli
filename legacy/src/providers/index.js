'use strict';

const selection = require('../provider-selection');
const {
  upstreamStrategies,
  resolveUpstreamProvider,
} = require('./upstream');
const {
  downstreamStrategies,
  resolveDownstreamProvider,
} = require('./downstream');

module.exports = {
  selection,
  upstreamStrategies,
  downstreamStrategies,
  resolveUpstreamProvider,
  resolveDownstreamProvider,
};
