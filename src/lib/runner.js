'use strict';

const target = '../providers/upstream/opencode/runner';
delete require.cache[require.resolve(target)];
module.exports = require(target);
