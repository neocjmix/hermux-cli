'use strict';

function createModelCommandService(deps) {
  const {
    buildModelsSummaryHtml,
    buildModelsRootKeyboard,
    buildModelApplyMessage,
    readJsonOrDefault,
    writeJsonAtomic,
    isValidModelRef,
    getOmoAgentEntry,
    OPENCODE_CONFIG_PATH,
    OMO_CONFIG_PATH,
  } = deps;

  function execute(input) {
    const { repoName, running, args } = input || {};
    const list = Array.isArray(args) ? args : [];
    const summary = buildModelsSummaryHtml(repoName);
    const summaryOpts = { parse_mode: 'HTML', reply_markup: buildModelsRootKeyboard() };
    if (list.length === 0) {
      return { text: summary.html, opts: summaryOpts };
    }

    const applyStatus = running ? 'scheduled_after_current_run' : 'applied_now';
    const note = running
      ? 'Current running task keeps previous model settings. New settings apply to next prompt automatically.'
      : 'Applied immediately for next prompt.';

    if (list[0] === 'opencode') {
      const action = String(list[1] || '').trim().toLowerCase();
      const cfg = readJsonOrDefault(OPENCODE_CONFIG_PATH, {});
      const before = String(cfg.model || '').trim() || '(unset)';

      if (action === 'get' || !action) {
        return {
          text: ['<pre><b>① opencode</b>', `<b>opencode</b> ${before}`, '</pre>'].join('\n'),
          opts: summaryOpts,
        };
      }
      if (action === 'set') {
        const next = String(list[2] || '').trim();
        if (!isValidModelRef(next)) {
          return { text: 'Invalid model format. Use provider/model (example: openai/gpt-5.3-codex).' };
        }
        cfg.model = next;
        writeJsonAtomic(OPENCODE_CONFIG_PATH, cfg);
        return {
          text: buildModelApplyMessage({ layer: 'opencode', scope: 'global', before, after: next, restartRequired: false, applyStatus, sessionImpact: 'preserved', note }),
          opts: { reply_markup: buildModelsRootKeyboard() },
        };
      }
      if (action === 'clear') {
        delete cfg.model;
        writeJsonAtomic(OPENCODE_CONFIG_PATH, cfg);
        return {
          text: buildModelApplyMessage({ layer: 'opencode', scope: 'global', before, after: '(unset)', restartRequired: false, applyStatus, sessionImpact: 'preserved', note }),
          opts: { reply_markup: buildModelsRootKeyboard() },
        };
      }
      return { text: 'Unknown /models opencode action. Use: get | set | clear' };
    }

    if (list[0] === 'omo') {
      const action = String(list[1] || '').trim().toLowerCase();
      const cfg = readJsonOrDefault(OMO_CONFIG_PATH, { agents: {} });

      if (action === 'get' || !action) {
        const agent = String(list[2] || '').trim();
        if (!agent) return { text: summary.html, opts: summaryOpts };
        const entry = cfg.agents && cfg.agents[agent] ? cfg.agents[agent] : {};
        const primary = String(entry.model || '').trim() || '(unset)';
        return {
          text: ['<pre><b>② oh-my-opencode</b>', `<b>${agent}</b> ${primary}`, '</pre>'].join('\n'),
          opts: summaryOpts,
        };
      }

      if (action === 'set') {
        const agent = String(list[2] || '').trim();
        const field = String(list[3] || '').trim().toLowerCase();
        const value = String(list[4] || '').trim();
        if (!agent) {
          return { text: 'Missing agent. Example: /models omo set sisyphus primary openai/gpt-5.3-codex' };
        }
        const entry = getOmoAgentEntry(cfg, agent);
        if (field === 'primary') {
          if (!isValidModelRef(value)) return { text: 'Invalid primary model format. Use provider/model.' };
          const before = String(entry.model || '').trim() || '(unset)';
          entry.model = value;
          writeJsonAtomic(OMO_CONFIG_PATH, cfg);
          return {
            text: buildModelApplyMessage({ layer: `omo/${agent}`, scope: 'global', before, after: value, restartRequired: false, applyStatus, sessionImpact: 'preserved', note }),
            opts: { reply_markup: buildModelsRootKeyboard() },
          };
        }
        if (field === 'fallback') {
          const before = Array.isArray(entry.fallback_models) ? entry.fallback_models.join(', ') : String(entry.fallback_models || '').trim() || 'off';
          if (!value || value.toLowerCase() === 'off') {
            delete entry.fallback_models;
            writeJsonAtomic(OMO_CONFIG_PATH, cfg);
            return {
              text: buildModelApplyMessage({ layer: `omo/${agent}`, scope: 'global', before, after: 'off', restartRequired: false, applyStatus, sessionImpact: 'preserved', note }),
              opts: { reply_markup: buildModelsRootKeyboard() },
            };
          }
          if (!isValidModelRef(value)) return { text: 'Invalid fallback model format. Use provider/model or off.' };
          entry.fallback_models = value;
          writeJsonAtomic(OMO_CONFIG_PATH, cfg);
          return {
            text: buildModelApplyMessage({ layer: `omo/${agent}`, scope: 'global', before, after: value, restartRequired: false, applyStatus, sessionImpact: 'preserved', note }),
            opts: { reply_markup: buildModelsRootKeyboard() },
          };
        }
        return { text: 'Unknown field. Use: primary | fallback' };
      }

      if (action === 'clear') {
        const agent = String(list[2] || '').trim();
        if (!agent) return { text: 'Missing agent. Example: /models omo clear sisyphus' };
        if (!cfg.agents || typeof cfg.agents !== 'object') cfg.agents = {};
        const existed = !!cfg.agents[agent];
        delete cfg.agents[agent];
        writeJsonAtomic(OMO_CONFIG_PATH, cfg);
        return {
          text: buildModelApplyMessage({ layer: `omo/${agent}`, scope: 'global', before: existed ? 'configured' : '(unset)', after: '(unset)', restartRequired: false, applyStatus, sessionImpact: 'preserved', note }),
          opts: { reply_markup: buildModelsRootKeyboard() },
        };
      }
      return { text: 'Unknown /models omo action. Use: get | set | clear' };
    }

    return { text: 'Unknown layer. Use: /models opencode ... or /models omo ...' };
  }

  return {
    execute,
  };
}

module.exports = {
  createModelCommandService,
};
