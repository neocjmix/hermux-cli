'use strict';

const { version } = require('../../package.json');

function getHermuxVersion() {
  return String(version || '').trim() || '0.0.0';
}

module.exports = {
  HERMUX_VERSION: getHermuxVersion(),
  getHermuxVersion,
};
