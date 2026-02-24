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
    buildModelsSummaryHtml,
    buildModelsRootKeyboard,
    getProviderModelChoices,
    buildProviderPickerKeyboard,
    getModelsSnapshot,
    buildAgentPickerKeyboard,
    escapeHtml,
    buildModelPickerKeyboard,
    readJsonOrDefault,
    writeJsonAtomic,
    OPENCODE_CONFIG_PATH,
    OMO_CONFIG_PATH,
    getOmoAgentEntry,
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
        const summary = buildModelsSummaryHtml(repo.name);
        await safeSend(bot, chatId, summary.html, { parse_mode: 'HTML', reply_markup: buildModelsRootKeyboard() });
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: 'models' }).catch(() => {});
        }
        return;
      }

      if (data === 'm:l:op') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_layer_op', dataPreview: summarizeText(data) });
        const providers = getProviderModelChoices();
        if (providers.length === 0) {
          await safeSend(bot, chatId, 'No model choices found in opencode config.');
        } else {
          modelUiState.set(chatId, { layer: 'op', providers, selectedProvider: -1, modelPage: 0 });
          await safeSend(bot, chatId, '<pre>① opencode\nprovider 선택</pre>', {
            parse_mode: 'HTML',
            reply_markup: buildProviderPickerKeyboard(providers, 'op'),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'choose provider' }).catch(() => {});
        return;
      }

      if (data === 'm:l:omo') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_layer_omo', dataPreview: summarizeText(data) });
        const snap = getModelsSnapshot();
        if (snap.agentNames.length === 0) {
          await safeSend(bot, chatId, 'No configured agents in oh-my-opencode.');
        } else {
          modelUiState.set(chatId, { layer: 'omo', agentNames: snap.agentNames });
          await safeSend(bot, chatId, '<pre>② oh-my-opencode\n에이전트 선택</pre>', {
            parse_mode: 'HTML',
            reply_markup: buildAgentPickerKeyboard(snap.agentNames),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'choose agent' }).catch(() => {});
        return;
      }

      if (data.startsWith('m:a:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_agent', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:a:'.length).trim());
        const st = modelUiState.get(chatId) || {};
        const names = Array.isArray(st.agentNames) ? st.agentNames : [];
        const agent = Number.isInteger(idx) && idx >= 0 && idx < names.length ? names[idx] : '';
        const providers = getProviderModelChoices();
        if (!agent || providers.length === 0) {
          await safeSend(bot, chatId, 'Unable to open provider choices.');
        } else {
          modelUiState.set(chatId, { layer: 'omo', agent, providers, selectedProvider: -1, modelPage: 0 });
          await safeSend(bot, chatId, `<pre>② oh-my-opencode\n${escapeHtml(agent)} · provider 선택</pre>`, {
            parse_mode: 'HTML',
            reply_markup: buildProviderPickerKeyboard(providers, 'omo'),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'choose provider' }).catch(() => {});
        return;
      }

      if (data.startsWith('m:p:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_provider', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:p:'.length).trim());
        const st = modelUiState.get(chatId) || {};
        const providers = Array.isArray(st.providers) ? st.providers : [];
        const item = Number.isInteger(idx) && idx >= 0 && idx < providers.length ? providers[idx] : null;
        if (!item || !Array.isArray(item.models) || item.models.length === 0) {
          await safeSend(bot, chatId, 'Invalid provider selection.');
        } else {
          st.selectedProvider = idx;
          st.modelPage = 0;
          modelUiState.set(chatId, st);
          await safeSend(bot, chatId, `<pre>${escapeHtml(item.providerId)} · model 선택</pre>`, {
            parse_mode: 'HTML',
            reply_markup: buildModelPickerKeyboard(item.models, st.layer === 'op' ? 'op' : 'omo', st.modelPage || 0),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'choose model' }).catch(() => {});
        return;
      }

      if (data === 'm:bp') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_back_provider', dataPreview: summarizeText(data) });
        const st = modelUiState.get(chatId) || {};
        const providers = Array.isArray(st.providers) ? st.providers : [];
        if (providers.length > 0) {
          await safeSend(bot, chatId, '<pre>provider 선택</pre>', {
            parse_mode: 'HTML',
            reply_markup: buildProviderPickerKeyboard(providers, st.layer === 'op' ? 'op' : 'omo'),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'back' }).catch(() => {});
        return;
      }

      if (data === 'm:mp:prev' || data === 'm:mp:next') {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_page', dataPreview: summarizeText(data) });
        const st = modelUiState.get(chatId) || {};
        const providers = Array.isArray(st.providers) ? st.providers : [];
        const selectedProvider = Number(st.selectedProvider);
        const item = Number.isInteger(selectedProvider) && selectedProvider >= 0 && selectedProvider < providers.length
          ? providers[selectedProvider]
          : null;
        if (!item) {
          await safeSend(bot, chatId, 'Provider를 다시 선택해줘.');
        } else {
          const delta = data.endsWith('next') ? 1 : -1;
          const pageSize = 10;
          const maxPage = Math.max(0, Math.floor((item.models.length - 1) / pageSize));
          const nextPage = Math.max(0, Math.min(maxPage, Number(st.modelPage || 0) + delta));
          st.modelPage = nextPage;
          modelUiState.set(chatId, st);
          await safeSend(bot, chatId, `<pre>${escapeHtml(item.providerId)} · model 선택</pre>`, {
            parse_mode: 'HTML',
            reply_markup: buildModelPickerKeyboard(item.models, st.layer === 'op' ? 'op' : 'omo', nextPage),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'page' }).catch(() => {});
        return;
      }

      if (data.startsWith('m:o:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_apply_op', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:o:'.length));
        const st = modelUiState.get(chatId) || {};
        const providers = Array.isArray(st.providers) ? st.providers : [];
        const selectedProvider = Number(st.selectedProvider);
        const models = Number.isInteger(selectedProvider) && selectedProvider >= 0 && selectedProvider < providers.length
          ? providers[selectedProvider].models
          : [];
        const model = Number.isInteger(idx) && idx >= 0 && idx < models.length ? models[idx] : '';
        if (!model) {
          await safeSend(bot, chatId, 'Invalid model selection.');
        } else {
          const cfg = readJsonOrDefault(OPENCODE_CONFIG_PATH, {});
          cfg.model = model;
          writeJsonAtomic(OPENCODE_CONFIG_PATH, cfg);
          await safeSend(bot, chatId, `<pre>① opencode\nopencode:${escapeHtml(model)}</pre>`, {
            parse_mode: 'HTML',
            reply_markup: buildModelsRootKeyboard(),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'applied' }).catch(() => {});
        return;
      }

      if (data.startsWith('m:s:')) {
        if (typeof audit === 'function') audit('router.callback.route', { chatId, target: 'models_apply_omo', dataPreview: summarizeText(data) });
        const idx = Number(data.slice('m:s:'.length));
        const st = modelUiState.get(chatId) || {};
        const agent = String(st.agent || '').trim();
        const providers = Array.isArray(st.providers) ? st.providers : [];
        const selectedProvider = Number(st.selectedProvider);
        const models = Number.isInteger(selectedProvider) && selectedProvider >= 0 && selectedProvider < providers.length
          ? providers[selectedProvider].models
          : [];
        const model = Number.isInteger(idx) && idx >= 0 && idx < models.length ? models[idx] : '';
        if (!agent || !model) {
          await safeSend(bot, chatId, 'Invalid agent/model selection.');
        } else {
          const cfg = readJsonOrDefault(OMO_CONFIG_PATH, { agents: {} });
          const entry = getOmoAgentEntry(cfg, agent);
          entry.model = model;
          writeJsonAtomic(OMO_CONFIG_PATH, cfg);
          await safeSend(bot, chatId, `<pre>② oh-my-opencode\n${escapeHtml(agent)}:${escapeHtml(model)}</pre>`, {
            parse_mode: 'HTML',
            reply_markup: buildModelsRootKeyboard(),
          });
        }
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'applied' }).catch(() => {});
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
