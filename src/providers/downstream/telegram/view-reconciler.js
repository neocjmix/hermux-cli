'use strict';

const { md2html } = require('../../../lib/md2html');
const { splitTelegramHtml } = require('./html-chunker');

function formatRunViewTextForTelegram(text) {
  return md2html(String(text == null ? '' : text));
}

function expandRunViewTextsToTelegramSlots(texts, maxLen) {
  if (!Array.isArray(texts)) return [];
  return texts.flatMap((text) => {
    const html = formatRunViewTextForTelegram(text);
    if (!html) return [];
    return splitTelegramHtml(html, maxLen);
  });
}

function buildRunViewReconcileCommands(currentTexts, currentMessageIds, nextTexts, isFinalState) {
  const commands = [];
  const common = Math.min(currentTexts.length, nextTexts.length);
  for (let i = 0; i < common; i++) {
    if (currentTexts[i] === nextTexts[i]) continue;
    commands.push({
      op: 'edit',
      index: i,
      text: nextTexts[i],
      messageId: currentMessageIds[i] || null,
      isFinalState: !!isFinalState,
    });
  }
  for (let i = common; i < nextTexts.length; i++) {
    commands.push({
      op: 'send',
      index: i,
      text: nextTexts[i],
      messageId: null,
      isFinalState: !!isFinalState,
    });
  }
  for (let i = currentMessageIds.length - 1; i >= nextTexts.length; i--) {
    commands.push({
      op: 'delete',
      index: i,
      text: '',
      messageId: currentMessageIds[i] || null,
      isFinalState: !!isFinalState,
    });
  }
  return commands;
}

async function reconcileRunViewForTelegram(params) {
  const {
    bot,
    chatId,
    runAuditMeta,
    currentView,
    nextTexts,
    maxLen,
    isFinalState,
    sendText,
    editText,
    deleteMessage,
    onMessagePersist,
  } = params;

  const currentTexts = Array.isArray(currentView && currentView.texts) ? currentView.texts : [];
  const messageIds = Array.isArray(currentView && currentView.messageIds) ? currentView.messageIds.slice() : [];
  const targetTexts = expandRunViewTextsToTelegramSlots(nextTexts, maxLen);
  const commands = buildRunViewReconcileCommands(currentTexts, messageIds, targetTexts, isFinalState);
  const stats = {
    commandCount: commands.length,
    sendCount: 0,
    editCount: 0,
    deleteCount: 0,
  };

  for (const command of commands) {
    if (command.op === 'edit') {
      if (!command.messageId) continue;
      stats.editCount += 1;
      await editText(bot, chatId, command.messageId, command.text, {
        ...runAuditMeta,
        channel: 'run_view_edit',
        index: command.index,
        isFinalState: command.isFinalState,
      });
      if (typeof onMessagePersist === 'function') {
        await onMessagePersist({
          op: 'edit',
          messageId: command.messageId,
          index: command.index,
          text: command.text,
          isFinalState: command.isFinalState,
        });
      }
    } else if (command.op === 'send') {
      stats.sendCount += 1;
      const sent = await sendText(bot, chatId, command.text, { parse_mode: 'HTML' }, {
        ...runAuditMeta,
        channel: 'run_view_send',
        index: command.index,
        isFinalState: command.isFinalState,
      });
      const sentMessageId = sent && sent.message_id ? sent.message_id : null;
      messageIds[command.index] = sentMessageId;
      if (typeof onMessagePersist === 'function' && sentMessageId) {
        await onMessagePersist({
          op: 'send',
          messageId: sentMessageId,
          index: command.index,
          text: command.text,
          isFinalState: command.isFinalState,
        });
      }
    } else if (command.op === 'delete') {
      if (command.messageId) {
        stats.deleteCount += 1;
        await deleteMessage(bot, chatId, command.messageId, {
          ...runAuditMeta,
          channel: 'run_view_delete',
          index: command.index,
          isFinalState: command.isFinalState,
        });
      }
      if (command.index >= 0 && command.index < messageIds.length) {
        messageIds.splice(command.index, 1);
      }
    }
  }

  return {
    messageIds,
    texts: targetTexts.slice(),
    stats,
  };
}

module.exports = {
  reconcileRunViewForTelegram,
  _internal: {
    buildRunViewReconcileCommands,
    expandRunViewTextsToTelegramSlots,
  },
};
