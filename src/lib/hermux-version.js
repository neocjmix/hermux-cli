// @ts-check
'use strict';

const HERMUX_VERSION = require('../../package.json').version;

function getHermuxVersion() {
  return HERMUX_VERSION;
}

module.exports = {
  HERMUX_VERSION,
  getHermuxVersion,
};
