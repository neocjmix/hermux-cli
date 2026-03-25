'use strict';

function summarizeText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > 240 ? `${value.slice(0, 240)}...(truncated)` : value;
}

function createCallbackQueryHandler(deps) {
  const {
    bot,
    chatRouter,
    states,
    modelUiState,
    safeSend,
    handleConnectCommand,
    handleVerboseAction,
    requestInterrupt,
    modelControlService,
    handleRevertConfirmCallback,
    handleRevertCancelCallback,
    handleQuestionCallback,
    withStateDispatchLock,
    audit,
  } = deps;

  return async function handleCallbackQuery(query) {
    const data = String((query && query.data) || '').trim();
    const chat = query && query.message && query.message.chat;
    const chatId = chat ? String(chat.id) : '';
    if (typeof audit === 'function') {
      audit('router.callback.received', {
        chatId: chatId || null,
        callbackId: query && query.id ? String(query.id) : null,
        dataPreview: summarizeText(data),
      });
    }

    if (!data || !chatId) {
      if (typeof audit === 'function') {
        audit('router.callback.skip', {
          reason: 'missing_data_or_chat',
          hasData: !!data,
          hasChat: !!chatId,
        });
      }
      if (query && query.id) {
        await bot.answerCallbackQuery(query.id).catch(() => {});
      }
      return;
    }

    try {
      if (data.startsWith('rv:c:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'revert_confirm', dataPreview: summarizeText(data) });
        const token = data.slice('rv:c:'.length).trim();
        const result = await handleRevertConfirmCallback(bot, query, chatRouter, states, token);
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: (result && result.answerText) || 'done' }).catch(() => {});
        }
        return;
      }

      if (data.startsWith('rv:x:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'revert_cancel', dataPreview: summarizeText(data) });
        const token = data.slice('rv:x:'.length).trim();
        const result = handleRevertCancelCallback(token);
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: (result && result.answerText) || 'cancelled' }).catch(() => {});
        }
        return;
      }

      if (data.startsWith('q:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'question', dataPreview: summarizeText(data) });
        const parts = data.split(':');
        const verb = String(parts[1] || '').trim();
        const questionIndex = Number(parts[2]);
        const optionIndex = Number(parts[3]);
        const result = await handleQuestionCallback(
          bot,
          query,
          chatRouter,
          states,
          verb === 's' ? 'select' : verb === 'u' ? 'submit' : verb === 'c' ? 'custom' : verb === 'x' ? 'cancel' : 'unknown',
          questionIndex,
          optionIndex,
          withStateDispatchLock,
        );
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: (result && result.answerText) || 'question' }).catch(() => {});
        }
        return;
      }

      if (data.startsWith('connect:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'connect', dataPreview: summarizeText(data) });
        const repoName = data.slice('connect:'.length).trim();
        await handleConnectCommand(bot, chatId, [repoName], chatRouter, states);
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: `connect: ${repoName}` }).catch(() => {});
        }
        return;
      }

      if (data.startsWith('verbose:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'verbose', dataPreview: summarizeText(data) });
        const action = data.slice('verbose:'.length).trim();
        const repo = chatRouter.get(chatId);
        if (!repo) {
          await safeSend(bot, chatId, 'This chat is not mapped to a repo. Run /repos then /connect <repo>.');
          if (query.id) {
            await bot.answerCallbackQuery(query.id, { text: 'not mapped' }).catch(() => {});
          }
          return;
        }

        const state = states.get(repo.name);
        await handleVerboseAction(bot, chatId, state, action === 'on' || action === 'off' ? action : 'status');
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: `verbose: ${action}` }).catch(() => {});
        }
        return;
      }

      if (data === 'interrupt:now') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'interrupt', dataPreview: summarizeText(data) });
        const repo = chatRouter.get(chatId);
        if (!repo) {
          await safeSend(bot, chatId, 'This chat is not mapped to a repo. Run /repos then /connect <repo>.');
          if (query.id) {
            await bot.answerCallbackQuery(query.id, { text: 'not mapped' }).catch(() => {});
          }
          return;
        }
        const state = states.get(repo.name);
        if (!state.running || !state.currentProc) {
          await safeSend(bot, chatId, 'No running task to interrupt.');
          if (query.id) {
            await bot.answerCallbackQuery(query.id, { text: 'idle' }).catch(() => {});
          }
          return;
        }
        const req = requestInterrupt(state, { forceAfterMs: 5000 });
        if (!req.ok) {
          const msg = req.error ? req.error.message : req.reason;
          await safeSend(bot, chatId, `Failed to interrupt current task: ${msg}`);
        } else {
          await safeSend(bot, chatId, req.alreadyRequested ? 'Interrupt already requested. Waiting for task shutdown...' : 'Interrupt requested. Stopping current task...');
        }
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: 'interrupt' }).catch(() => {});
        }
        return;
      }

      if (data === 'm:r') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_root', dataPreview: summarizeText(data) });
        const repo = chatRouter.get(chatId);
        if (!repo) {
          await safeSend(bot, chatId, 'This chat is not mapped to a repo. Run /repos then /connect <repo>.');
          if (query.id) {
            await bot.answerCallbackQuery(query.id, { text: 'not mapped' }).catch(() => {});
          }
          return;
        }
        const view = modelControlService.openModelsRoot(repo.name);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: 'models' }).catch(() => {});
        }
        return;
      }

      if (data === 'm:l:op') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_layer_op', dataPreview: summarizeText(data) });
        const view = modelControlService.openOpProviderSelection(chatId);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }

      if (data === 'm:l:omo') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_layer_omo', dataPreview: summarizeText(data) });
        const view = modelControlService.openOmoAgentSelection(chatId);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }

      if (data.startsWith('m:a:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_agent', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:a:'.length).trim());
        const view = modelControlService.openOmoAgentProviderSelection(chatId, idx);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }

      if (data.startsWith('m:p:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_provider', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:p:'.length).trim());
        const view = modelControlService.openProviderModelSelection(chatId, idx);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }

      if (data === 'm:bp') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_back_provider', dataPreview: summarizeText(data) });
        const st = modelUiState.get(chatId) || {};
        const providers = Array.isArray(st.providers) ? st.providers : [];
        if (providers.length > 0) {
          const view = modelControlService.backToProviderSelection(chatId);
          await safeSend(bot, chatId, view.message, view.opts);
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'back' }).catch(() => {});
        return;
      }

      if (data === 'm:mp:prev' || data === 'm:mp:next') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_page', dataPreview: summarizeText(data) });
        const view = modelControlService.pageProviderModels(chatId, data.endsWith('next') ? 'next' : 'prev');
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }

      if (data.startsWith('m:o:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_apply_op', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:o:'.length));
        const view = modelControlService.applyOpModel(chatId, idx);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }

      if (data.startsWith('m:s:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_apply_omo', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:s:'.length));
        const view = modelControlService.applyOmoModel(chatId, idx);
        await safeSend(bot, chatId, view.message, view.opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: view.answerText }).catch(() => {});
        return;
      }
    } catch (err) {
      console.error('[callback_query] failed:', err.message);
      if (typeof audit === 'function') {
        audit('router.callback.error', {
          chatId,
          dataPreview: summarizeText(data),
          message: String(err && err.message ? err.message : err || ''),
        });
      }
    }

    if (query.id) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
  };
}

module.exports = {
  createCallbackQueryHandler,
};
