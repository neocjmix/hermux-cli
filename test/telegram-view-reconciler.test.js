'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileRunViewForTelegram,
} = require('../src/providers/downstream/telegram/view-reconciler');

test('telegram view reconciler applies edit/send/delete with final-state flag', async () => {
  const calls = [];
  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '100',
    runAuditMeta: { runId: 'r1' },
    currentView: {
      texts: ['a', 'b', 'c'],
      messageIds: [11, 12, 13],
    },
    nextTexts: ['a', 'B', 'd'],
    isFinalState: true,
    sendText: async (_bot, _chatId, text, opts, meta) => {
      calls.push({ op: 'send', text, opts, meta });
      return { message_id: 21 };
    },
    editText: async (_bot, _chatId, messageId, text, meta) => {
      calls.push({ op: 'edit', messageId, text, meta });
    },
    deleteMessage: async (_bot, _chatId, messageId, meta) => {
      calls.push({ op: 'delete', messageId, meta });
      return true;
    },
  });

  assert.equal(calls.some((c) => c.op === 'edit' && c.messageId === 12 && c.text === 'B'), true);
  assert.equal(calls.some((c) => c.op === 'edit' && c.messageId === 13 && c.text === 'd'), true);
  assert.equal(calls.some((c) => c.op === 'send'), false);
  assert.equal(calls.some((c) => c.op === 'delete'), false);
  assert.equal(calls.every((c) => c.meta && c.meta.isFinalState === true), true);
  assert.deepEqual(next, {
    messageIds: [11, 12, 13],
    texts: ['a', 'B', 'd'],
    stats: {
      commandCount: 2,
      sendCount: 0,
      editCount: 2,
      deleteCount: 0,
    },
  });
});

test('telegram view reconciler formats markdown to HTML and sends with parse_mode HTML', async () => {
  const calls = [];
  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '101',
    runAuditMeta: { runId: 'r2' },
    currentView: {
      texts: [],
      messageIds: [],
    },
    nextTexts: ['**bold** `code`'],
    isFinalState: false,
    sendText: async (_bot, _chatId, text, opts, meta) => {
      calls.push({ op: 'send', text, opts, meta });
      return { message_id: 31 };
    },
    editText: async () => {},
    deleteMessage: async () => true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'send');
  assert.equal(calls[0].opts && calls[0].opts.parse_mode, 'HTML');
  assert.equal(calls[0].text.includes('<b>bold</b>'), true);
  assert.equal(calls[0].text.includes('<code>code</code>'), true);
  assert.equal(next.texts[0].includes('<b>bold</b>'), true);
  assert.equal(next.texts[0].includes('<code>code</code>'), true);
});
