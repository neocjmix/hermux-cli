const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const { createTelegramTransport } = require('../src/providers/downstream/telegram/transport');

function createDeps() {
  const auditRows = [];
  return {
    auditRows,
    deps: {
      audit: (kind, payload) => auditRows.push({ kind, payload }),
      sleep: async () => {},
      getTelegramRetryAfterSeconds: () => 0,
      summarizeAuditText: (text) => String(text || '').trim(),
      shouldDeferRunViewRetryAfter: () => false,
    },
  };
}

test('telegram transport resolves sendMessageDraft via _request fallback', async () => {
  const { deps } = createDeps();
  const transport = createTelegramTransport(deps);
  const calls = [];
  const bot = {
    _request: async (method, options) => {
      calls.push({ method, options });
      return true;
    },
  };

  const sendDraft = transport.resolveSendMessageDraftApi(bot);
  assert.equal(typeof sendDraft, 'function');

  await sendDraft('100', 3, '<b>preview</b>', { parse_mode: 'HTML' });

  assert.deepEqual(calls, [{
    method: 'sendMessageDraft',
    options: {
      form: {
        chat_id: '100',
        draft_id: 3,
        text: '<b>preview</b>',
        parse_mode: 'HTML',
      },
    },
  }]);
});

test('telegram transport safeSend falls back to plain send after parse-mode failure', async () => {
  const { deps, auditRows } = createDeps();
  const transport = createTelegramTransport(deps);
  const calls = [];
  const bot = {
    sendMessage: async (_chatId, text, opts) => {
      calls.push({ text, opts });
      if (opts && opts.parse_mode) {
        const err = new Error('bad html');
        err.code = 'ETELEGRAM';
        throw err;
      }
      return { message_id: 91 };
    },
  };

  const sent = await transport.safeSend(bot, '100', '<b>hello</b>', { parse_mode: 'HTML' }, { channel: 'run_view_send' });

  assert.deepEqual(calls, [
    { text: '<b>hello</b>', opts: { parse_mode: 'HTML' } },
    { text: '<b>hello</b>', opts: undefined },
  ]);
  assert.deepEqual(sent, { message_id: 91 });
  assert.equal(auditRows.some((row) => row.kind === 'telegram.send' && row.payload.stage === 'fallback_plain' && row.payload.ok === true), true);
});

test('telegram transport materializes draft preview by sending message then clearing draft', async () => {
  const { deps } = createDeps();
  const transport = createTelegramTransport(deps);
  const calls = [];
  const bot = {
    sendMessage: async (chatId, text, opts) => {
      calls.push({ method: 'sendMessage', chatId, text, opts });
      return { message_id: 52 };
    },
    _request: async (method, options) => {
      calls.push({ method, options });
      return true;
    },
  };

  const result = await transport.materializeTelegramDraftPreview(
    bot,
    '100',
    { transport: 'draft', draftId: 7, text: '<b>preview</b>' },
    '<b>preview</b>',
    { parse_mode: 'HTML' },
    { channel: 'run_view_draft_materialize', materializeReason: 'test' }
  );

  assert.deepEqual(result, { messageId: 52, persistOp: 'send' });
  assert.deepEqual(calls, [
    { method: 'sendMessage', chatId: '100', text: '<b>preview</b>', opts: { parse_mode: 'HTML' } },
    {
      method: 'sendMessageDraft',
      options: {
        form: {
          chat_id: '100',
          draft_id: 7,
          text: '',
        },
      },
    },
  ]);
});

test('telegram transport resolves preview transport for draft, message, and ineligible chat paths', () => {
  const { deps } = createDeps();
  const transport = createTelegramTransport(deps);

  const withDraft = transport.resolveTelegramPreviewTransport({ _request: async () => true }, '100', null);
  const existingMessage = transport.resolveTelegramPreviewTransport({}, '100', { transport: 'message', messageId: 8 });
  const noDraftApi = transport.resolveTelegramPreviewTransport({}, '100', null);
  const ineligible = transport.resolveTelegramPreviewTransport({ _request: async () => true }, '-100123', null);

  assert.equal(withDraft.transport, 'draft');
  assert.equal(withDraft.reason, 'draft_transport_available');
  assert.equal(existingMessage.transport, 'message');
  assert.equal(existingMessage.reason, 'existing_message_preview');
  assert.equal(noDraftApi.transport, 'message');
  assert.equal(noDraftApi.reason, 'draft_api_unavailable');
  assert.equal(ineligible.transport, 'message');
  assert.equal(ineligible.reason, 'ineligible_chat');
});

test('telegram transport detects unsupported draft fallback errors', () => {
  const { deps } = createDeps();
  const transport = createTelegramTransport(deps);

  assert.equal(transport.shouldFallbackFromDraftTransport(new Error('400: Bad Request: method sendMessageDraft can be used only in private chats')), true);
  assert.equal(transport.shouldFallbackFromDraftTransport(new Error('400: Bad Request: unknown method sendMessageDraft')), true);
  assert.equal(transport.shouldFallbackFromDraftTransport(new Error('500: Internal error')), false);
});

test('telegram transport materializes non-empty run-start draft preview and ignores empty preview', async () => {
  const { deps } = createDeps();
  const transport = createTelegramTransport(deps);
  const calls = [];
  const bot = {
    sendMessage: async (chatId, text, opts) => {
      calls.push({ method: 'sendMessage', chatId, text, opts });
      return { message_id: 61 };
    },
    _request: async (method, options) => {
      calls.push({ method, options });
      return true;
    },
  };

  const materialized = await transport.maybeMaterializeRunStartDraftPreview(bot, {
    chatId: '100',
    draftPreview: { transport: 'draft', draftId: 11, text: '<b>carry</b>' },
  }, { repo: 'demo' });
  const skipped = await transport.maybeMaterializeRunStartDraftPreview(bot, {
    chatId: '100',
    draftPreview: { transport: 'draft', draftId: 12, text: '   ' },
  }, { repo: 'demo' });

  assert.deepEqual(materialized, { messageId: 61, persistOp: 'send' });
  assert.equal(skipped, null);
  assert.deepEqual(calls, [
    { method: 'sendMessage', chatId: '100', text: '<b>carry</b>', opts: { parse_mode: 'HTML' } },
    { method: 'sendMessageDraft', options: { form: { chat_id: '100', draft_id: 11, text: '' } } },
  ]);
});
