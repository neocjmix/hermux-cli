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
    sendText: async (_bot, _chatId, text, _opts, meta) => {
      calls.push({ op: 'send', text, meta });
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
  });
});
