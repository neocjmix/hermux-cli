'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileRunViewForTelegram,
  _internal,
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
    draftPreview: null,
    materializedTail: null,
    stats: {
      commandCount: 2,
      sendCount: 0,
      editCount: 2,
      deleteCount: 0,
      deferredCount: 0,
      draftCount: 0,
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

test('telegram view reconciler invokes onMessagePersist for edit and send', async () => {
  const persisted = [];

  await reconcileRunViewForTelegram({
    bot: {},
    chatId: '102',
    runAuditMeta: { runId: 'r3' },
    currentView: {
      texts: ['old'],
      messageIds: [41],
    },
    nextTexts: ['new', 'more'],
    isFinalState: false,
    sendText: async () => ({ message_id: 42 }),
    editText: async () => {},
    deleteMessage: async () => true,
    onMessagePersist: async (info) => {
      persisted.push(info);
    },
  });

  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted[0], {
    op: 'edit',
    messageId: 41,
    index: 0,
    text: 'new',
    isFinalState: false,
  });
  assert.deepEqual(persisted[1], {
    op: 'send',
    messageId: 42,
    index: 1,
    text: 'more',
    isFinalState: false,
  });
});

test('telegram view reconciler splits formatted HTML on visible boundaries and keeps tags balanced', async () => {
  const calls = [];

  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '103',
    runAuditMeta: { runId: 'r4' },
    currentView: {
      texts: [],
      messageIds: [],
    },
    nextTexts: ['**bold**'],
    isFinalState: false,
    maxLen: 2,
    sendText: async (_bot, _chatId, text, opts, meta) => {
      calls.push({ op: 'send', text, opts, meta });
      return { message_id: calls.length + 50 };
    },
    editText: async () => {},
    deleteMessage: async () => true,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts && calls[0].opts.parse_mode, 'HTML');
  assert.deepEqual(calls.map((call) => call.text), ['<b>bo</b>', '<b>ld</b>']);
  assert.deepEqual(next.texts, ['<b>bo</b>', '<b>ld</b>']);
});

test('telegram view reconciler keeps HTML entities intact when splitting after formatting', async () => {
  const calls = [];

  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '104',
    runAuditMeta: { runId: 'r5' },
    currentView: {
      texts: [],
      messageIds: [],
    },
    nextTexts: ['a & b'],
    isFinalState: false,
    maxLen: 3,
    sendText: async (_bot, _chatId, text, opts, meta) => {
      calls.push({ op: 'send', text, opts, meta });
      return { message_id: calls.length + 60 };
    },
    editText: async () => {},
    deleteMessage: async () => true,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.text), ['a &amp;', ' b']);
  assert.deepEqual(next.texts, ['a &amp;', ' b']);
});

test('telegram view reconciler expands one logical block into multiple slots without truncating edits', async () => {
  const calls = [];

  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '105',
    runAuditMeta: { runId: 'r6' },
    currentView: {
      texts: ['<b>xy</b>'],
      messageIds: [71],
    },
    nextTexts: ['**abcd**'],
    isFinalState: false,
    maxLen: 2,
    sendText: async (_bot, _chatId, text, opts, meta) => {
      calls.push({ op: 'send', text, opts, meta });
      return { message_id: 72 };
    },
    editText: async (_bot, _chatId, messageId, text, meta) => {
      calls.push({ op: 'edit', messageId, text, meta });
    },
    deleteMessage: async () => true,
  });

  assert.deepEqual(calls, [
    {
      op: 'edit',
      messageId: 71,
      text: '<b>ab</b>',
      meta: { runId: 'r6', channel: 'run_view_edit', index: 0, isFinalState: false },
    },
    {
      op: 'send',
      text: '<b>cd</b>',
      opts: { parse_mode: 'HTML' },
      meta: { runId: 'r6', channel: 'run_view_send', index: 1, isFinalState: false },
    },
  ]);
  assert.deepEqual(next.messageIds, [71, 72]);
  assert.deepEqual(next.texts, ['<b>ab</b>', '<b>cd</b>']);
});

test('telegram view reconciler retains message preview on final-state reconcile in non-draft chats', async () => {
  let cleared = false;

  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '-100123',
    runAuditMeta: { runId: 'r7' },
    currentView: {
      texts: ['status only'],
      messageIds: [91],
      draftPreview: {
        transport: 'message',
        messageId: 92,
        text: 'preview answer',
      },
    },
    nextTexts: ['status only'],
    isFinalState: true,
    sendText: async () => ({ message_id: 93 }),
    editText: async () => {},
    clearDraft: async () => {
      cleared = true;
    },
    deleteMessage: async () => true,
  });

  assert.equal(cleared, false);
  assert.deepEqual(next.messageIds, [91, 92]);
  assert.deepEqual(next.texts, ['status only', 'preview answer']);
  assert.deepEqual(next.materializedTail, {
    messageId: '',
    partId: '',
    reason: 'retain_message_preview_after_completion',
  });
});

test('shouldEagerlyMaterializeTail only enables active strong hint without preview', () => {
  assert.equal(_internal.shouldEagerlyMaterializeTail(
    { messageId: 'msg-1', partId: 'part-1', reason: 'text_part_updated_after_delta' },
    null,
    false,
    false
  ), true);
  assert.equal(_internal.shouldEagerlyMaterializeTail(
    { messageId: 'msg-1', partId: 'part-1', reason: 'text_part_non_empty_updated' },
    null,
    false,
    false
  ), false);
  assert.equal(_internal.shouldEagerlyMaterializeTail(
    { messageId: 'msg-1', partId: 'part-1', reason: 'text_part_updated_after_delta' },
    { transport: 'draft', draftId: 1, text: 'draft' },
    false,
    false
  ), false);
  assert.equal(_internal.shouldEagerlyMaterializeTail(
    { messageId: 'msg-1', partId: 'part-1', reason: 'text_part_updated_after_delta' },
    null,
    false,
    true
  ), false);
});

test('telegram view reconciler eagerly materializes strong tail hint during active run', async () => {
  const calls = [];

  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '106',
    runAuditMeta: { runId: 'r8' },
    currentView: {
      texts: ['status only'],
      messageIds: [101],
    },
    nextTexts: ['status only', 'stable answer'],
    tailMaterializeHint: {
      messageId: 'msg-stable',
      partId: 'part-stable',
      reason: 'text_part_updated_after_delta',
    },
    isFinalState: false,
    sendText: async (_bot, _chatId, text, opts, meta) => {
      calls.push({ op: 'send', text, opts, meta });
      return { message_id: 102 };
    },
    editText: async () => {},
    previewDraft: async () => {
      calls.push({ op: 'preview' });
      return { applied: true, transport: 'draft', draftId: 3 };
    },
    deleteMessage: async () => true,
  });

  assert.deepEqual(calls, [{
    op: 'send',
    text: 'stable answer',
    opts: { parse_mode: 'HTML' },
    meta: {
      runId: 'r8',
      channel: 'run_view_draft_materialize',
      index: 1,
      isFinalState: false,
      materializeReason: 'text_part_updated_after_delta',
    },
  }]);
  assert.deepEqual(next.messageIds, [101, 102]);
  assert.deepEqual(next.texts, ['status only', 'stable answer']);
  assert.equal(next.draftPreview, null);
  assert.deepEqual(next.materializedTail, {
    messageId: 'msg-stable',
    partId: 'part-stable',
    reason: 'text_part_updated_after_delta',
  });
});

test('telegram view reconciler keeps weak tail hint on draft preview path during active run', async () => {
  const calls = [];

  const next = await reconcileRunViewForTelegram({
    bot: {},
    chatId: '107',
    runAuditMeta: { runId: 'r9' },
    currentView: {
      texts: ['status only'],
      messageIds: [111],
    },
    nextTexts: ['status only', 'weak answer'],
    tailMaterializeHint: {
      messageId: 'msg-weak',
      partId: 'part-weak',
      reason: 'text_part_non_empty_updated',
    },
    isFinalState: false,
    sendText: async () => {
      calls.push({ op: 'send' });
      return { message_id: 112 };
    },
    editText: async () => {},
    previewDraft: async (_bot, _chatId, _preview, text, opts, meta) => {
      calls.push({ op: 'preview', text, opts, meta });
      return { applied: true, transport: 'draft', draftId: 4 };
    },
    deleteMessage: async () => true,
  });

  assert.deepEqual(calls, [{
    op: 'preview',
    text: 'weak answer',
    opts: { parse_mode: 'HTML' },
    meta: { runId: 'r9', channel: 'run_view_draft', index: 1, isFinalState: false },
  }]);
  assert.deepEqual(next.messageIds, [111]);
  assert.deepEqual(next.texts, ['status only']);
  assert.deepEqual(next.draftPreview, {
    transport: 'draft',
    draftId: 4,
    messageId: null,
    text: 'weak answer',
  });
  assert.equal(next.materializedTail, null);
});
