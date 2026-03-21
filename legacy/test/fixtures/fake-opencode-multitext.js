#!/usr/bin/env node
'use strict';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

out({ type: 'step_start', sessionID: 'sess-multi' });
out({ type: 'text', part: { text: '[analyze-mode]\ninternal preface\n---\nfirst', sessionID: 'sess-multi' } });
out({ type: 'tool_use', part: { tool: 'task', state: { input: {}, output: 'ok' }, sessionID: 'sess-multi' } });
out({ type: 'text', part: { text: 'canonical-final-from-command', sessionID: 'sess-multi' } });
out({ type: 'step_finish', part: { reason: 'done', sessionID: 'sess-multi' } });
