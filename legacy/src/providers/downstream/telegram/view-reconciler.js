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

function shouldEagerlyMaterializeTail(requestedMaterializedTail, currentDraftPreview, keepCommittedTail, isFinalState) {
  if (isFinalState) return false;
  if (!requestedMaterializedTail || typeof requestedMaterializedTail !== 'object') return false;
  if (currentDraftPreview || keepCommittedTail) return false;
  return String(requestedMaterializedTail.reason || '').trim() === 'text_part_updated_after_delta';
}

async function reconcileRunViewForTelegram(params) {
  const {
    bot,
    chatId,
    runAuditMeta,
    currentView,
    nextTexts,
    tailMaterializeHint,
    maxLen,
    isFinalState,
    sendText,
    editText,
    previewDraft,
    materializeDraft,
    materializeStaleDraft,
    clearDraft,
    deleteMessage,
    onMessagePersist,
  } = params;

  const currentTexts = Array.isArray(currentView && currentView.texts) ? currentView.texts : [];
  const messageIds = Array.isArray(currentView && currentView.messageIds) ? currentView.messageIds.slice() : [];
  const currentDraftPreview = currentView && currentView.draftPreview && typeof currentView.draftPreview === 'object'
    ? { ...currentView.draftPreview }
    : null;
  const currentMaterializedTail = currentView && currentView.materializedTail && typeof currentView.materializedTail === 'object'
    ? { ...currentView.materializedTail }
    : null;
  const appliedTexts = currentTexts.slice();
  const targetTexts = expandRunViewTextsToTelegramSlots(nextTexts, maxLen);
  const requestedMaterializedTail = tailMaterializeHint && typeof tailMaterializeHint === 'object'
    ? {
        messageId: String(tailMaterializeHint.messageId || '').trim(),
        partId: String(tailMaterializeHint.partId || '').trim(),
        reason: String(tailMaterializeHint.reason || '').trim(),
      }
    : null;
  const keepCommittedTail = !!(
    requestedMaterializedTail
    && currentMaterializedTail
    && requestedMaterializedTail.messageId
    && requestedMaterializedTail.partId
    && currentMaterializedTail.messageId === requestedMaterializedTail.messageId
    && currentMaterializedTail.partId === requestedMaterializedTail.partId
  );
  const shouldMaterializeDraftTail = !!(requestedMaterializedTail && currentDraftPreview && !keepCommittedTail);
  const shouldEagerMaterializeTail = shouldEagerlyMaterializeTail(
    requestedMaterializedTail,
    currentDraftPreview,
    keepCommittedTail,
    isFinalState
  );
  const useDraftPreview = !isFinalState && typeof previewDraft === 'function' && targetTexts.length > 1 && !keepCommittedTail && !shouldMaterializeDraftTail && !shouldEagerMaterializeTail;
  const retainsExistingPreviewTail = !!(currentDraftPreview && targetTexts.length > currentTexts.length && !shouldMaterializeDraftTail);
  const splitTailFromCommitted = useDraftPreview || retainsExistingPreviewTail || shouldMaterializeDraftTail || shouldEagerMaterializeTail;
  const committedTargetTexts = splitTailFromCommitted ? targetTexts.slice(0, -1) : targetTexts.slice();
  const draftTargetText = splitTailFromCommitted ? targetTexts[targetTexts.length - 1] : '';
  const commands = buildRunViewReconcileCommands(currentTexts, messageIds, committedTargetTexts, isFinalState);
  const stats = {
    commandCount: commands.length,
    sendCount: 0,
    editCount: 0,
    deleteCount: 0,
    deferredCount: 0,
    draftCount: 0,
    sendFailCount: 0,
  };
  let nextDraftPreview = currentDraftPreview;
  let nextMaterializedTail = keepCommittedTail ? requestedMaterializedTail : null;

  for (const command of commands) {
    if (command.op === 'edit') {
      if (!command.messageId) continue;
      stats.editCount += 1;
      const editResult = await editText(bot, chatId, command.messageId, command.text, {
        ...runAuditMeta,
        channel: 'run_view_edit',
        index: command.index,
        isFinalState: command.isFinalState,
      });
      if (editResult && editResult.deferred) {
        stats.deferredCount += 1;
        continue;
      }
      appliedTexts[command.index] = command.text;
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
      if (sent && sent._hermuxDeferred) {
        stats.deferredCount += 1;
        continue;
      }
      const sentMessageId = sent && sent.message_id ? sent.message_id : null;
      if (!sentMessageId) {
        stats.sendFailCount += 1;
        continue;
      }
      messageIds[command.index] = sentMessageId;
      appliedTexts[command.index] = command.text;
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
      if (command.index >= 0 && command.index < appliedTexts.length) {
        appliedTexts.splice(command.index, 1);
      }
    }
  }

  if (useDraftPreview) {
    const previewResult = await previewDraft(bot, chatId, currentDraftPreview, draftTargetText, { parse_mode: 'HTML' }, {
      ...runAuditMeta,
      channel: 'run_view_draft',
      index: committedTargetTexts.length,
      isFinalState: false,
    });
    if (previewResult && previewResult.applied) {
      stats.draftCount += 1;
      nextDraftPreview = {
        transport: previewResult.transport,
        draftId: previewResult.draftId || null,
        messageId: previewResult.messageId || null,
        text: draftTargetText,
      };
    }
  } else if (shouldEagerMaterializeTail) {
    const finalText = targetTexts[targetTexts.length - 1];
    let materializedMessageId = null;

    if (typeof sendText === 'function') {
      stats.sendCount += 1;
      const sent = await sendText(bot, chatId, finalText, { parse_mode: 'HTML' }, {
        ...runAuditMeta,
        channel: 'run_view_draft_materialize',
        index: committedTargetTexts.length,
        isFinalState: false,
        materializeReason: requestedMaterializedTail && requestedMaterializedTail.reason
          ? requestedMaterializedTail.reason
          : (runAuditMeta && runAuditMeta.materializeReason ? runAuditMeta.materializeReason : ''),
      });
      if (sent && sent._hermuxDeferred) {
        stats.deferredCount += 1;
      } else if (sent && sent.message_id) {
        materializedMessageId = sent.message_id;
        messageIds[committedTargetTexts.length] = materializedMessageId;
        appliedTexts[committedTargetTexts.length] = finalText;
        nextMaterializedTail = requestedMaterializedTail || null;
        if (typeof onMessagePersist === 'function') {
          await onMessagePersist({
            op: 'send',
            messageId: materializedMessageId,
            index: committedTargetTexts.length,
            text: finalText,
            isFinalState: false,
          });
        }
      }
    }

    if (!materializedMessageId && typeof previewDraft === 'function') {
      const previewResult = await previewDraft(bot, chatId, currentDraftPreview, draftTargetText, { parse_mode: 'HTML' }, {
        ...runAuditMeta,
        channel: 'run_view_draft',
        index: committedTargetTexts.length,
        isFinalState: false,
      });
      if (previewResult && previewResult.applied) {
        stats.draftCount += 1;
        nextDraftPreview = {
          transport: previewResult.transport,
          draftId: previewResult.draftId || null,
          messageId: previewResult.messageId || null,
          text: draftTargetText,
        };
      }
    }
  } else if (currentDraftPreview) {
    const canPromoteMessagePreview = !!(
      currentDraftPreview.transport === 'message'
      && currentDraftPreview.messageId
      && (isFinalState || materializeStaleDraft)
    );
    if ((isFinalState || materializeStaleDraft || shouldMaterializeDraftTail) && typeof materializeDraft === 'function' && splitTailFromCommitted) {
      const finalText = targetTexts[targetTexts.length - 1];
      const materialized = await materializeDraft(bot, chatId, currentDraftPreview, finalText, { parse_mode: 'HTML' }, {
        ...runAuditMeta,
        channel: 'run_view_draft_materialize',
        index: committedTargetTexts.length,
        isFinalState: true,
        materializeReason: requestedMaterializedTail && requestedMaterializedTail.reason
          ? requestedMaterializedTail.reason
          : (runAuditMeta && runAuditMeta.materializeReason ? runAuditMeta.materializeReason : ''),
      });
      if (materialized && materialized.messageId) {
        messageIds[committedTargetTexts.length] = materialized.messageId;
        appliedTexts[committedTargetTexts.length] = finalText;
        nextMaterializedTail = requestedMaterializedTail || null;
        if (typeof onMessagePersist === 'function') {
          await onMessagePersist({
            op: materialized.persistOp || 'send',
            messageId: materialized.messageId,
            index: committedTargetTexts.length,
            text: finalText,
            isFinalState: true,
          });
        }
      }
    } else if (canPromoteMessagePreview) {
      const committedIndex = committedTargetTexts.length;
      messageIds[committedIndex] = currentDraftPreview.messageId;
      appliedTexts[committedIndex] = String(currentDraftPreview.text || '');
      nextMaterializedTail = requestedMaterializedTail || {
        messageId: '',
        partId: '',
        reason: 'retain_message_preview_after_completion',
      };
    } else if (typeof clearDraft === 'function') {
      await clearDraft(bot, chatId, currentDraftPreview, {
        ...runAuditMeta,
        channel: 'run_view_draft_clear',
        index: committedTargetTexts.length,
        isFinalState: !!isFinalState,
      });
    }
    nextDraftPreview = null;
  } else if (keepCommittedTail) {
    nextMaterializedTail = requestedMaterializedTail;
  }

  return {
    messageIds,
    texts: appliedTexts,
    draftPreview: nextDraftPreview,
    materializedTail: nextMaterializedTail,
    stats,
  };
}

module.exports = {
  reconcileRunViewForTelegram,
  _internal: {
    buildRunViewReconcileCommands,
    expandRunViewTextsToTelegramSlots,
    shouldEagerlyMaterializeTail,
  },
};
