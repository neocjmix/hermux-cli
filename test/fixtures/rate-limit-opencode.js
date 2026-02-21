#!/usr/bin/env node

process.stderr.write('Error: 429 Too Many Requests. retry_after 42s\n');
setTimeout(() => {
  process.exit(1);
}, 10);
