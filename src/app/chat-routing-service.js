'use strict';

function createChatRoutingService(deps) {
  const {
    addChatIdToRepo,
    moveChatIdToRepo,
    refreshRuntimeRouting,
    getSessionId,
    endSessionLifecycle,
    clearSessionId,
  } = deps;

  async function connectChat(params) {
    const {
      requestedRepo,
      chatId,
      availableRepos,
      remapConfirm,
      chatRouter,
      states,
    } = params || {};

    const result = addChatIdToRepo(requestedRepo, chatId);
    if (result.ok) {
      refreshRuntimeRouting(chatRouter, states);
      if (result.changed) {
        return {
          kind: 'connected',
          includeGroupHint: String(chatId || '').trim().startsWith('-'),
          text: [
            `Connected: chat ${chatId} -> repo ${requestedRepo}`,
            'You can now send prompts in this chat.',
            'Tip: /status, /verbose on, /whereami',
          ].join('\n'),
        };
      }
      return {
        kind: 'already_connected',
        text: [
          `Already connected: chat ${chatId} -> repo ${requestedRepo}`,
          'No change needed. You can continue using this chat.',
        ].join('\n'),
      };
    }

    if (result.reason === 'chat_already_mapped') {
      if (!remapConfirm) {
        return {
          kind: 'remap_warning',
          text: [
            `This chat is already connected to repo: ${result.existingRepo}`,
            `Requested repo: ${requestedRepo}`,
            '',
            '⚠️ Moving this chat will reset session continuity for this chat in both repos.',
            `To confirm move: /connect ${requestedRepo} move`,
            'Use /whereami to verify current mapping first.',
          ].join('\n'),
        };
      }

      const moved = moveChatIdToRepo(requestedRepo, chatId);
      if (!moved.ok) {
        return { kind: 'error', text: `Connect failed (${moved.reason}). Retry: /connect ${requestedRepo}` };
      }

      refreshRuntimeRouting(chatRouter, states);
      const previousSessionId = getSessionId(String(result.existingRepo || ''), chatId);
      const requestedSessionId = getSessionId(requestedRepo, chatId);
      if (previousSessionId && typeof endSessionLifecycle === 'function') {
        const previousRepo = availableRepos.find((repo) => repo && repo.name === String(result.existingRepo || ''));
        if (previousRepo) await endSessionLifecycle(previousRepo, previousSessionId, 'chat_remap');
      }
      if (requestedSessionId && typeof endSessionLifecycle === 'function') {
        const requestedRepoConfig = availableRepos.find((repo) => repo && repo.name === requestedRepo);
        if (requestedRepoConfig) await endSessionLifecycle(requestedRepoConfig, requestedSessionId, 'chat_remap');
      }
      clearSessionId(String(result.existingRepo || ''), chatId);
      clearSessionId(requestedRepo, chatId);
      return {
        kind: 'moved',
        text: [
          `Moved: chat ${chatId} -> repo ${requestedRepo}`,
          `Previous repo: ${result.existingRepo}`,
          'Session continuity was reset for safety. Next prompt starts a new session.',
          'Tip: /whereami, then send a fresh prompt.',
        ].join('\n'),
      };
    }

    return { kind: 'error', text: `Connect failed (${result.reason}). Retry: /connect ${requestedRepo}` };
  }

  return {
    connectChat,
  };
}

module.exports = {
  createChatRoutingService,
};
