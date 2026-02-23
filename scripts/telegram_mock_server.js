#!/usr/bin/env node
'use strict';

const { createTelegramMockServer } = require('../test/fixtures/telegram-mock-server');

async function main() {
  const port = Number(process.env.OMG_TELEGRAM_STUB_PORT || 8081) || 8081;
  const server = createTelegramMockServer();
  const started = await server.start(port);

  console.log('[telegram-stub] started');
  console.log(`[telegram-stub] baseApiUrl: ${started.baseApiUrl}`);
  console.log(`[telegram-stub] controlUrl: ${started.controlUrl}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[telegram-stub] failed:', err.message);
  process.exit(1);
});
