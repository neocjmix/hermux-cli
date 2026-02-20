#!/usr/bin/env node
'use strict';

setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'late output', sessionID: 'sleep-sess' } }) + '\n');
}, 3000);
