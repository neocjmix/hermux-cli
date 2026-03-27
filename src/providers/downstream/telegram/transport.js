'use strict';

const TELEGRAM_DRAFT_ID_MAX = 2147483647;
const TELEGRAM_DRAFT_METHOD_UNAVAILABLE_RE = /(unknown method|method .*not (found|available|supported)|unsupported)/i;
const TELEGRAM_DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only|private chat|topic mode enabled|textdraft_peer_invalid)/i;

let nextTelegramDraftId = 0;

function createTelegramTransport(deps) {
  const {
    audit,
    sleep,
    getTelegramRetryAfterSeconds,
    summarizeAuditText,
    shouldDeferRunViewRetryAfter,
    splitTelegramHtml,
    md2html,
    maxLen = 4000,
  } = deps || {};

  function allocateTelegramDraftId() {
    nextTelegramDraftId = nextTelegramDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextTelegramDraftId + 1;
    return nextTelegramDraftId;
  }

  function resolveSendMessageDraftApi(bot) {
    if (bot && typeof bot.sendMessageDraft === 'function') {
      return bot.sendMessageDraft.bind(bot);
    }
    if (bot && typeof bot._request === 'function') {
      return async (chatId, draftId, text, params) => {
        const form = {
          chat_id: chatId,
          draft_id: draftId,
          text,
          ...(params && params.parse_mode ? { parse_mode: params.parse_mode } : {}),
          ...(params && Number.isFinite(Number(params.message_thread_id))
            ? { message_thread_id: Number(params.message_thread_id) }
            : {}),
        };
        return bot._request('sendMessageDraft', { form });
      };
    }
    return null;
  }

  function shouldFallbackFromDraftTransport(err) {
    const text = typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : String(err && err.message ? err.message : err || '');
    if (!/sendMessageDraft/i.test(text) && !/textdraft/i.test(text)) return false;
    return TELEGRAM_DRAFT_METHOD_UNAVAILABLE_RE.test(text) || TELEGRAM_DRAFT_CHAT_UNSUPPORTED_RE.test(text);
  }

  function isEligibleTelegramDraftChatId(chatId) {
    const numeric = Number(chatId);
    return Number.isFinite(numeric) && numeric > 0;
  }

  function resolveTelegramPreviewTransport(bot, chatId, currentPreview) {
    const existing = currentPreview && typeof currentPreview === 'object' ? currentPreview : null;
    if (existing && existing.transport === 'message' && existing.messageId) {
      return { transport: 'message', reason: 'existing_message_preview', sendDraft: null };
    }
    if (!isEligibleTelegramDraftChatId(chatId)) {
      return { transport: 'message', reason: 'ineligible_chat', sendDraft: null };
    }
    const sendDraft = resolveSendMessageDraftApi(bot);
    if (!sendDraft) {
      return { transport: 'message', reason: 'draft_api_unavailable', sendDraft: null };
    }
    return {
      transport: 'draft',
      reason: existing && existing.transport === 'draft' && existing.draftId
        ? 'reuse_existing_draft'
        : 'draft_transport_available',
      sendDraft,
    };
  }

  function auditTelegramPreviewRoute({ phase, chatId, transport, reason, auditMeta, currentPreview, draftId, messageId, textPreview, error }) {
    audit('telegram.preview.route', {
      phase: String(phase || '').trim() || 'preview',
      chatId: String(chatId),
      transport: String(transport || '').trim() || 'unknown',
      reason: String(reason || '').trim() || 'unknown',
      currentTransport: currentPreview && currentPreview.transport ? String(currentPreview.transport) : '',
      currentDraftId: currentPreview && currentPreview.draftId ? Number(currentPreview.draftId) : null,
      currentMessageId: currentPreview && currentPreview.messageId ? Number(currentPreview.messageId) : null,
      draftId: Number.isFinite(Number(draftId)) ? Number(draftId) : null,
      messageId: Number.isFinite(Number(messageId)) ? Number(messageId) : null,
      textPreview: String(textPreview || ''),
      error: error ? String(error) : '',
      meta: auditMeta || null,
    });
  }

  async function safeSend(bot, chatId, text, opts, auditMeta) {
    const parseMode = opts && opts.parse_mode ? String(opts.parse_mode) : '';
    const preview = summarizeAuditText(text);
    try {
      const message = await bot.sendMessage(chatId, text, opts);
      audit('telegram.send', {
        ok: true,
        chatId: String(chatId),
        parseMode,
        messageId: message && message.message_id ? message.message_id : null,
        textPreview: preview,
        meta: auditMeta || null,
      });
      return message;
    } catch (err) {
      let primaryErr = err;
      const retryAfterSeconds = getTelegramRetryAfterSeconds(primaryErr);
      if (retryAfterSeconds > 0) {
        const waitMs = (retryAfterSeconds * 1000) + Math.floor(Math.random() * 250);
        if (shouldDeferRunViewRetryAfter(auditMeta, waitMs)) {
          audit('telegram.send', {
            ok: false,
            stage: 'retry_after_deferred',
            chatId: String(chatId),
            parseMode,
            error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''),
            retryAfterSeconds,
            waitMs,
            textPreview: preview,
            meta: auditMeta || null,
          });
          return {
            _hermuxDeferred: true,
            retryAfterSeconds,
            waitMs,
          };
        }
        audit('telegram.send', {
          ok: false,
          stage: 'retry_after_pending',
          chatId: String(chatId),
          parseMode,
          error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''),
          retryAfterSeconds,
          waitMs,
          textPreview: preview,
          meta: auditMeta || null,
        });
        await sleep(waitMs);
        try {
          const retryMessage = await bot.sendMessage(chatId, text, opts);
          audit('telegram.send', {
            ok: true,
            stage: 'retry_after',
            chatId: String(chatId),
            parseMode,
            messageId: retryMessage && retryMessage.message_id ? retryMessage.message_id : null,
            textPreview: preview,
            meta: auditMeta || null,
          });
          return retryMessage;
        } catch (retryErr) {
          primaryErr = retryErr;
        }
      }
      audit('telegram.send', {
        ok: false,
        stage: 'primary',
        chatId: String(chatId),
        parseMode,
        error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''),
        textPreview: preview,
        meta: auditMeta || null,
      });
      if (opts && opts.parse_mode) {
        try {
          const message = await bot.sendMessage(chatId, text);
          audit('telegram.send', {
            ok: true,
            stage: 'fallback_plain',
            chatId: String(chatId),
            parseMode: '',
            messageId: message && message.message_id ? message.message_id : null,
            textPreview: preview,
            meta: auditMeta || null,
          });
          return message;
        } catch (e) {
          audit('telegram.send', {
            ok: false,
            stage: 'fallback_plain',
            chatId: String(chatId),
            parseMode: '',
            error: String(e && (e.code || e.message || e) || ''),
            textPreview: preview,
            meta: auditMeta || null,
          });
        }
      }
    }
    return null;
  }

  async function sendHtml(bot, chatId, html, auditMeta) {
    const chunks = splitTelegramHtml(html, maxLen);
    let lastMsg = null;
    for (let i = 0; i < chunks.length; i += 1) {
      lastMsg = await safeSend(bot, chatId, chunks[i], { parse_mode: 'HTML' }, {
        ...(auditMeta || {}),
        chunkIndex: i,
        chunkCount: chunks.length,
      });
    }
    return lastMsg;
  }

  async function sendMarkdownAsHtml(bot, chatId, markdown, auditMeta) {
    const html = md2html(String(markdown || ''));
    return sendHtml(bot, chatId, html, auditMeta);
  }

  function isMessageNotModifiedError(err) {
    return String(err && err.message || '').includes('message is not modified');
  }

  async function editText(bot, chatId, messageId, text, opts, auditMeta) {
    const normalizedOpts = opts && typeof opts === 'object' ? { ...opts } : {};
    const parseMode = normalizedOpts.parse_mode ? String(normalizedOpts.parse_mode) : '';
    const preview = summarizeAuditText(text);
    const request = {
      chat_id: chatId,
      message_id: messageId,
      ...normalizedOpts,
    };
    try {
      await bot.editMessageText(text, request);
      audit('telegram.edit', { ok: true, stage: 'primary', chatId: String(chatId), messageId, parseMode, textPreview: preview, meta: auditMeta || null });
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        audit('telegram.edit', { ok: true, stage: 'not_modified', chatId: String(chatId), messageId, parseMode, textPreview: preview, meta: auditMeta || null });
        return { applied: true, deferred: false };
      }
      let primaryErr = err;
      const retryAfterSeconds = getTelegramRetryAfterSeconds(primaryErr);
      if (retryAfterSeconds > 0) {
        const waitMs = (retryAfterSeconds * 1000) + Math.floor(Math.random() * 250);
        if (shouldDeferRunViewRetryAfter(auditMeta, waitMs)) {
          audit('telegram.edit', { ok: false, stage: 'retry_after_deferred', chatId: String(chatId), messageId, parseMode, error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''), retryAfterSeconds, waitMs, textPreview: preview, meta: auditMeta || null });
          return { applied: false, deferred: true, retryAfterSeconds, waitMs };
        }
        audit('telegram.edit', { ok: false, stage: 'retry_after_pending', chatId: String(chatId), messageId, parseMode, error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''), retryAfterSeconds, waitMs, textPreview: preview, meta: auditMeta || null });
        await sleep(waitMs);
        try {
          await bot.editMessageText(text, request);
          audit('telegram.edit', { ok: true, stage: 'retry_after', chatId: String(chatId), messageId, parseMode, textPreview: preview, meta: auditMeta || null });
          return { applied: true };
        } catch (retryErr) {
          primaryErr = retryErr;
        }
      }
      if (!isMessageNotModifiedError(primaryErr)) {
        audit('telegram.edit', { ok: false, stage: 'primary', chatId: String(chatId), messageId, parseMode, error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''), textPreview: preview, meta: auditMeta || null });
        if (parseMode) {
          const fallbackRequest = { ...request };
          delete fallbackRequest.parse_mode;
          try {
            await bot.editMessageText(text, fallbackRequest);
            audit('telegram.edit', { ok: true, stage: 'fallback_plain', chatId: String(chatId), messageId, parseMode: '', textPreview: preview, meta: auditMeta || null });
            return { applied: true };
          } catch (e) {
            audit('telegram.edit', { ok: false, stage: 'fallback_plain', chatId: String(chatId), messageId, parseMode: '', error: String(e && (e.code || e.message || e) || ''), textPreview: preview, meta: auditMeta || null });
          }
        }
      }
    }
    return { applied: false, deferred: false };
  }

  async function editHtml(bot, chatId, messageId, html, auditMeta) {
    return editText(bot, chatId, messageId, html, { parse_mode: 'HTML' }, auditMeta);
  }

  async function safeDeleteMessage(bot, chatId, messageId, auditMeta) {
    try {
      await bot.deleteMessage(chatId, messageId);
      audit('telegram.delete', { ok: true, chatId: String(chatId), messageId, meta: auditMeta || null });
      return true;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err || '').trim();
      audit('telegram.delete', { ok: false, chatId: String(chatId), messageId, error: msg, meta: auditMeta || null });
      return false;
    }
  }

  async function safeSendPhoto(bot, chatId, fsRef, filePath, caption, auditMeta) {
    try {
      const stream = fsRef.createReadStream(filePath);
      const message = await bot.sendPhoto(chatId, stream, caption ? { caption } : undefined);
      audit('telegram.send_photo', { ok: true, chatId: String(chatId), messageId: message && message.message_id ? message.message_id : null, filePath: String(filePath || ''), captionPreview: summarizeAuditText(caption || ''), meta: auditMeta || null });
      return message;
    } catch (err) {
      audit('telegram.send_photo', { ok: false, chatId: String(chatId), filePath: String(filePath || ''), captionPreview: summarizeAuditText(caption || ''), error: String(err && err.message ? err.message : err || ''), meta: auditMeta || null });
      return null;
    }
  }

  async function safeSendDocument(bot, chatId, fsRef, filePath, caption, auditMeta) {
    try {
      const stream = fsRef.createReadStream(filePath);
      const message = await bot.sendDocument(chatId, stream, caption ? { caption } : undefined);
      audit('telegram.send_document', { ok: true, chatId: String(chatId), messageId: message && message.message_id ? message.message_id : null, filePath: String(filePath || ''), captionPreview: summarizeAuditText(caption || ''), meta: auditMeta || null });
      return message;
    } catch (err) {
      audit('telegram.send_document', { ok: false, chatId: String(chatId), filePath: String(filePath || ''), captionPreview: summarizeAuditText(caption || ''), error: String(err && err.message ? err.message : err || ''), meta: auditMeta || null });
      return null;
    }
  }

  async function updateTelegramDraftPreview(bot, chatId, currentPreview, html, opts, auditMeta) {
    const preview = summarizeAuditText(html);
    const existing = currentPreview && typeof currentPreview === 'object' ? currentPreview : null;
    if (!String(html || '').trim()) {
      auditTelegramPreviewRoute({ phase: 'preview', chatId, transport: 'none', reason: 'empty_text', auditMeta, currentPreview: existing, textPreview: preview });
      return { applied: false };
    }

    const route = resolveTelegramPreviewTransport(bot, chatId, existing);
    const sendDraft = route.sendDraft;
    if (sendDraft) {
      const draftId = Number(existing && existing.draftId ? existing.draftId : 0) || allocateTelegramDraftId();
      auditTelegramPreviewRoute({ phase: 'preview', chatId, transport: 'draft', reason: route.reason, auditMeta, currentPreview: existing, draftId, textPreview: preview });
      try {
        await sendDraft(chatId, draftId, html, { parse_mode: opts && opts.parse_mode ? String(opts.parse_mode) : undefined });
        audit('telegram.draft', { ok: true, stage: 'primary', chatId: String(chatId), reason: route.reason, draftId, parseMode: opts && opts.parse_mode ? String(opts.parse_mode) : '', textPreview: preview, meta: auditMeta || null });
        return { applied: true, transport: 'draft', draftId, messageId: null };
      } catch (err) {
        audit('telegram.draft', { ok: false, stage: 'primary', chatId: String(chatId), reason: route.reason, draftId, parseMode: opts && opts.parse_mode ? String(opts.parse_mode) : '', error: String(err && (err.code || err.message || err) || ''), textPreview: preview, meta: auditMeta || null });
        if (!shouldFallbackFromDraftTransport(err)) {
          auditTelegramPreviewRoute({ phase: 'preview', chatId, transport: 'none', reason: 'draft_request_failed_no_fallback', auditMeta, currentPreview: existing, draftId, textPreview: preview, error: String(err && (err.code || err.message || err) || '') });
          return { applied: false };
        }
        auditTelegramPreviewRoute({ phase: 'preview', chatId, transport: 'message', reason: 'draft_transport_rejected_fallback', auditMeta, currentPreview: existing, draftId, textPreview: preview, error: String(err && (err.code || err.message || err) || '') });
        audit('telegram.draft', { ok: false, stage: 'fallback_message', chatId: String(chatId), reason: 'draft_transport_rejected_fallback', draftId, parseMode: opts && opts.parse_mode ? String(opts.parse_mode) : '', error: String(err && (err.code || err.message || err) || ''), textPreview: preview, meta: auditMeta || null });
      }
    }

    auditTelegramPreviewRoute({ phase: 'preview', chatId, transport: 'message', reason: route.reason, auditMeta, currentPreview: existing, messageId: existing && existing.messageId ? existing.messageId : null, textPreview: preview });
    if (existing && existing.transport === 'message' && existing.messageId) {
      const edited = await editHtml(bot, chatId, existing.messageId, html, { ...auditMeta, channel: 'run_view_edit', isFinalState: false });
      if (edited && edited.deferred) return { applied: false, transport: 'message', messageId: existing.messageId };
      return { applied: true, transport: 'message', messageId: existing.messageId };
    }
    const sent = await safeSend(bot, chatId, html, opts, { ...auditMeta, channel: 'run_view_send', isFinalState: false });
    if (!sent || sent._hermuxDeferred || !sent.message_id) return { applied: false };
    return { applied: true, transport: 'message', draftId: null, messageId: sent.message_id };
  }

  async function clearTelegramDraftPreview(bot, chatId, currentPreview, auditMeta) {
    const preview = currentPreview && typeof currentPreview === 'object' ? currentPreview : null;
    if (!preview) return false;
    if (preview.transport === 'message' && preview.messageId) {
      auditTelegramPreviewRoute({ phase: 'clear', chatId, transport: 'message', reason: 'clear_message_preview', auditMeta, currentPreview: preview, messageId: preview.messageId, textPreview: String(preview.text || '') });
      return safeDeleteMessage(bot, chatId, preview.messageId, auditMeta);
    }
    if (preview.transport === 'draft' && preview.draftId) {
      const sendDraft = resolveSendMessageDraftApi(bot);
      if (!sendDraft) {
        auditTelegramPreviewRoute({ phase: 'clear', chatId, transport: 'draft', reason: 'draft_api_unavailable_on_clear', auditMeta, currentPreview: preview, draftId: preview.draftId, textPreview: '' });
        return false;
      }
      auditTelegramPreviewRoute({ phase: 'clear', chatId, transport: 'draft', reason: 'clear_draft_preview', auditMeta, currentPreview: preview, draftId: preview.draftId, textPreview: '' });
      try {
        await sendDraft(chatId, preview.draftId, '', undefined);
        audit('telegram.draft', { ok: true, stage: 'clear', chatId: String(chatId), reason: 'clear_draft_preview', draftId: preview.draftId, textPreview: '', meta: auditMeta || null });
        return true;
      } catch (err) {
        audit('telegram.draft', { ok: false, stage: 'clear', chatId: String(chatId), reason: 'clear_draft_preview', draftId: preview.draftId, error: String(err && (err.code || err.message || err) || ''), textPreview: '', meta: auditMeta || null });
      }
    }
    return false;
  }

  async function materializeTelegramDraftPreview(bot, chatId, currentPreview, html, opts, auditMeta) {
    const preview = currentPreview && typeof currentPreview === 'object' ? currentPreview : null;
    if (!preview || !String(html || '').trim()) return null;
    if (preview.transport === 'message' && preview.messageId) {
      const textChanged = String(preview.text || '') !== String(html || '');
      auditTelegramPreviewRoute({ phase: 'materialize', chatId, transport: 'message', reason: textChanged ? 'finalize_existing_message_preview_edit' : 'finalize_existing_message_preview_keep', auditMeta, currentPreview: preview, messageId: preview.messageId, textPreview: summarizeAuditText(html) });
      if (textChanged) {
        await editHtml(bot, chatId, preview.messageId, html, { ...auditMeta, channel: 'run_view_edit', isFinalState: true });
      }
      return { messageId: preview.messageId, persistOp: textChanged ? 'edit' : 'send' };
    }
    auditTelegramPreviewRoute({ phase: 'materialize', chatId, transport: 'message', reason: String(auditMeta && auditMeta.materializeReason ? auditMeta.materializeReason : 'final_state_materialize'), auditMeta, currentPreview: preview, draftId: preview && preview.draftId ? preview.draftId : null, textPreview: summarizeAuditText(html) });
    const sent = await safeSend(bot, chatId, html, opts, { ...auditMeta, channel: 'run_view_send', isFinalState: true });
    if (!sent || !sent.message_id) return null;
    await clearTelegramDraftPreview(bot, chatId, preview, { ...auditMeta, channel: 'run_view_draft_clear', isFinalState: true });
    return { messageId: sent.message_id, persistOp: 'send' };
  }

  async function maybeMaterializeRunStartDraftPreview(bot, currentView, auditMeta) {
    const view = currentView && typeof currentView === 'object' ? currentView : null;
    const preview = view && view.draftPreview && typeof view.draftPreview === 'object' ? view.draftPreview : null;
    const previewText = String(preview && preview.text ? preview.text : '');
    if (!preview || !previewText.trim()) return null;
    const targetChatId = String(view && view.chatId ? view.chatId : '').trim();
    if (!targetChatId) return null;
    return materializeTelegramDraftPreview(bot, targetChatId, preview, previewText, { parse_mode: 'HTML' }, { ...(auditMeta || {}), chatId: targetChatId, channel: 'run_start_draft_materialize', materializeReason: 'new_run_start_materialize_existing_preview', isFinalState: true });
  }

  return {
    resolveSendMessageDraftApi,
    shouldFallbackFromDraftTransport,
    isEligibleTelegramDraftChatId,
    resolveTelegramPreviewTransport,
    updateTelegramDraftPreview,
    clearTelegramDraftPreview,
    materializeTelegramDraftPreview,
    maybeMaterializeRunStartDraftPreview,
    safeSend,
    sendHtml,
    sendMarkdownAsHtml,
    editText,
    editHtml,
    safeDeleteMessage,
    safeSendPhoto,
    safeSendDocument,
    _internal: {
      allocateTelegramDraftId,
      auditTelegramPreviewRoute,
      isMessageNotModifiedError,
    },
  };
}

module.exports = {
  createTelegramTransport,
};
