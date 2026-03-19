'use strict';

function createModelControlService(deps) {
  const {
    modelUiState,
    buildModelsSummaryHtml,
    buildModelsRootKeyboard,
    getProviderModelChoices,
    getModelsSnapshot,
    buildProviderPickerKeyboard,
    buildAgentPickerKeyboard,
    buildModelPickerKeyboard,
    escapeHtml,
    readJsonOrDefault,
    writeJsonAtomic,
    OPENCODE_CONFIG_PATH,
    OMO_CONFIG_PATH,
    getOmoAgentEntry,
  } = deps;

  function openModelsRoot(repoName) {
    const summary = buildModelsSummaryHtml(repoName);
    return {
      answerText: 'models',
      message: summary.html,
      opts: { parse_mode: 'HTML', reply_markup: buildModelsRootKeyboard() },
    };
  }

  function openOpProviderSelection(chatId) {
    const providers = getProviderModelChoices();
    if (providers.length === 0) {
      return { answerText: 'choose provider', message: 'No model choices found in opencode config.', opts: undefined };
    }
    modelUiState.set(chatId, { layer: 'op', providers, selectedProvider: -1, modelPage: 0 });
    return {
      answerText: 'choose provider',
      message: '<pre>① opencode\nprovider 선택</pre>',
      opts: { parse_mode: 'HTML', reply_markup: buildProviderPickerKeyboard(providers, 'op') },
    };
  }

  function openOmoAgentSelection(chatId) {
    const snap = getModelsSnapshot();
    if (snap.agentNames.length === 0) {
      return { answerText: 'choose agent', message: 'No configured agents in oh-my-opencode.', opts: undefined };
    }
    modelUiState.set(chatId, { layer: 'omo', agentNames: snap.agentNames });
    return {
      answerText: 'choose agent',
      message: '<pre>② oh-my-opencode\n에이전트 선택</pre>',
      opts: { parse_mode: 'HTML', reply_markup: buildAgentPickerKeyboard(snap.agentNames) },
    };
  }

  function openOmoAgentProviderSelection(chatId, idx) {
    const st = modelUiState.get(chatId) || {};
    const names = Array.isArray(st.agentNames) ? st.agentNames : [];
    const agent = Number.isInteger(idx) && idx >= 0 && idx < names.length ? names[idx] : '';
    const providers = getProviderModelChoices();
    if (!agent || providers.length === 0) {
      return { answerText: 'choose provider', message: 'Unable to open provider choices.', opts: undefined };
    }
    modelUiState.set(chatId, { layer: 'omo', agent, providers, selectedProvider: -1, modelPage: 0 });
    return {
      answerText: 'choose provider',
      message: `<pre>② oh-my-opencode\n${escapeHtml(agent)} · provider 선택</pre>`,
      opts: { parse_mode: 'HTML', reply_markup: buildProviderPickerKeyboard(providers, 'omo') },
    };
  }

  function openProviderModelSelection(chatId, idx) {
    const st = modelUiState.get(chatId) || {};
    const providers = Array.isArray(st.providers) ? st.providers : [];
    const item = Number.isInteger(idx) && idx >= 0 && idx < providers.length ? providers[idx] : null;
    if (!item || !Array.isArray(item.models) || item.models.length === 0) {
      return { answerText: 'choose model', message: 'Invalid provider selection.', opts: undefined };
    }
    st.selectedProvider = idx;
    st.modelPage = 0;
    modelUiState.set(chatId, st);
    return {
      answerText: 'choose model',
      message: `<pre>${escapeHtml(item.providerId)} · model 선택</pre>`,
      opts: { parse_mode: 'HTML', reply_markup: buildModelPickerKeyboard(item.models, st.layer === 'op' ? 'op' : 'omo', st.modelPage || 0) },
    };
  }

  function pageProviderModels(chatId, direction) {
    const st = modelUiState.get(chatId) || {};
    const providers = Array.isArray(st.providers) ? st.providers : [];
    const selectedProvider = Number(st.selectedProvider);
    const item = Number.isInteger(selectedProvider) && selectedProvider >= 0 && selectedProvider < providers.length
      ? providers[selectedProvider]
      : null;
    if (!item) {
      return { answerText: 'page', message: 'Provider를 다시 선택해줘.', opts: undefined };
    }
    const pageSize = 10;
    const maxPage = Math.max(0, Math.floor((item.models.length - 1) / pageSize));
    const delta = direction === 'next' ? 1 : -1;
    const nextPage = Math.max(0, Math.min(maxPage, Number(st.modelPage || 0) + delta));
    st.modelPage = nextPage;
    modelUiState.set(chatId, st);
    return {
      answerText: 'page',
      message: `<pre>${escapeHtml(item.providerId)} · model 선택</pre>`,
      opts: { parse_mode: 'HTML', reply_markup: buildModelPickerKeyboard(item.models, st.layer === 'op' ? 'op' : 'omo', nextPage) },
    };
  }

  function backToProviderSelection(chatId) {
    const st = modelUiState.get(chatId) || {};
    const providers = Array.isArray(st.providers) ? st.providers : [];
    if (providers.length === 0) return null;
    return {
      answerText: 'back',
      message: '<pre>provider 선택</pre>',
      opts: { parse_mode: 'HTML', reply_markup: buildProviderPickerKeyboard(providers, st.layer === 'op' ? 'op' : 'omo') },
    };
  }

  function applyOpModel(chatId, idx) {
    const st = modelUiState.get(chatId) || {};
    const providers = Array.isArray(st.providers) ? st.providers : [];
    const selectedProvider = Number(st.selectedProvider);
    const models = Number.isInteger(selectedProvider) && selectedProvider >= 0 && selectedProvider < providers.length
      ? providers[selectedProvider].models
      : [];
    const model = Number.isInteger(idx) && idx >= 0 && idx < models.length ? models[idx] : '';
    if (!model) {
      return { answerText: 'applied', message: 'Invalid model selection.', opts: undefined };
    }
    const cfg = readJsonOrDefault(OPENCODE_CONFIG_PATH, {});
    cfg.model = model;
    writeJsonAtomic(OPENCODE_CONFIG_PATH, cfg);
    return {
      answerText: 'applied',
      message: `<pre>① opencode\nopencode:${escapeHtml(model)}</pre>`,
      opts: { parse_mode: 'HTML', reply_markup: buildModelsRootKeyboard() },
    };
  }

  function applyOmoModel(chatId, idx) {
    const st = modelUiState.get(chatId) || {};
    const agent = String(st.agent || '').trim();
    const providers = Array.isArray(st.providers) ? st.providers : [];
    const selectedProvider = Number(st.selectedProvider);
    const models = Number.isInteger(selectedProvider) && selectedProvider >= 0 && selectedProvider < providers.length
      ? providers[selectedProvider].models
      : [];
    const model = Number.isInteger(idx) && idx >= 0 && idx < models.length ? models[idx] : '';
    if (!agent || !model) {
      return { answerText: 'applied', message: 'Invalid agent/model selection.', opts: undefined };
    }
    const cfg = readJsonOrDefault(OMO_CONFIG_PATH, { agents: {} });
    const entry = getOmoAgentEntry(cfg, agent);
    entry.model = model;
    writeJsonAtomic(OMO_CONFIG_PATH, cfg);
    return {
      answerText: 'applied',
      message: `<pre>② oh-my-opencode\n${escapeHtml(agent)}:${escapeHtml(model)}</pre>`,
      opts: { parse_mode: 'HTML', reply_markup: buildModelsRootKeyboard() },
    };
  }

  return {
    openModelsRoot,
    openOpProviderSelection,
    openOmoAgentSelection,
    openOmoAgentProviderSelection,
    openProviderModelSelection,
    pageProviderModels,
    backToProviderSelection,
    applyOpModel,
    applyOmoModel,
  };
}

module.exports = {
  createModelControlService,
};
