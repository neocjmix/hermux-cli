#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);
const prompt = args[args.length - 1] || '';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

out({ type: 'step_start', sessionID: 'sess-abc' });
out({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'ls' }, output: '' }, sessionID: 'sess-abc' } });
out({ type: 'text', part: { text: `final:${prompt}`, sessionID: 'sess-abc' } });
out({ type: 'step_finish', part: { reason: 'done', sessionID: 'sess-abc' } });
