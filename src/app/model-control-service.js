// @ts-check
'use strict';

// Skeleton: see docs/COMPONENT_CONTRACTS.md § model-control-service
// BOUNDARY: MUST return channel-agnostic data (BOUNDARY_AUDIT #7)
//   - NO parse_mode, NO reply_markup
//   - Return { answerText, message, choices? } — downstream adapter applies channel formatting

/**
 * @param {object} deps
 * @returns {object}
 */
function createModelControlService(deps) {
  return {
    openModelsRoot(repoName) { throw new Error('NOT_IMPLEMENTED: openModelsRoot'); },
    openOpProviderSelection(chatId) { throw new Error('NOT_IMPLEMENTED: openOpProviderSelection'); },
    openOmoAgentSelection(chatId) { throw new Error('NOT_IMPLEMENTED: openOmoAgentSelection'); },
    openOmoAgentProviderSelection(chatId, idx) { throw new Error('NOT_IMPLEMENTED: openOmoAgentProviderSelection'); },
    openProviderModelSelection(chatId, idx) { throw new Error('NOT_IMPLEMENTED: openProviderModelSelection'); },
    pageProviderModels(chatId, direction) { throw new Error('NOT_IMPLEMENTED: pageProviderModels'); },
    backToProviderSelection(chatId) { throw new Error('NOT_IMPLEMENTED: backToProviderSelection'); },
    applyOpModel(chatId, idx) { throw new Error('NOT_IMPLEMENTED: applyOpModel'); },
    applyOmoModel(chatId, idx) { throw new Error('NOT_IMPLEMENTED: applyOmoModel'); },
  };
}

module.exports = {
  createModelControlService,
};
