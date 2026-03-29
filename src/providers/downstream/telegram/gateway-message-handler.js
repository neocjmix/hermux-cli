'use strict';

function summarizeText(text) {
  const raw = String(text || '').trim();
  const redacted = /^(\/tunnel(?:@[^\s]+)?\s+auth)(?:\s+.+)?$/i.test(raw)
    ? raw.replace(/^(\/tunnel(?:@[^\s]+)?\s+auth)(?:\s+.+)?$/i, (_m, head) => `${head} [REDACTED]`)
    : raw;
  const value = redacted.replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > 240 ? `${value.slice(0, 240)}...(truncated)` : value;
}

function looksLikeWorkdirPathInput(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const quoted = raw.match(/^(["'])(.*)\1$/);
  const unquoted = quoted ? String(quoted[2] || '').trim() : raw;
  return unquoted.startsWith('/') || unquoted.startsWith('~/');
}

function createMessageHandler(deps) {
  const {
    bot,
    chatRouter,
    states,
    onboardingSessions,
    initSessions,
    parseCommand,
    handleOnboardCommand,
    handleInitCommand,
    handleOnboardingInput,
    safeSend,
    getHelpText,
    sendTelegramFormattingShowcase,
    sendRepoList,
    handleConnectCommand,
    handleTunnelAuthCommand,
    withStateDispatchLock,
    handleRepoMessage,
    handleQuestionTextInput,
    audit,
  } = deps;

  return async function handleMessage(msg) {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const parsed = parseCommand(text);
    const command = parsed ? parsed.command : '';
    if (typeof audit === 'function') {
      audit('router.message.received', {
        chatId,
        command: command || null,
        textPreview: summarizeText(text),
      });
    }

    if (command === '/onboard') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'onboard', command });
      await handleOnboardCommand(bot, chatId, parsed, chatRouter, states, onboardingSessions);
      return;
    }

    if (command === '/init') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'init', command });
      await handleInitCommand(bot, chatId, parsed, states, onboardingSessions, initSessions, chatRouter);
      return;
    }

    if (onboardingSessions.has(chatId)) {
      const onboardingSession = onboardingSessions.get(chatId) || {};
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'onboarding_input', command: command || null });
      if (
        command
        && command !== '/onboard'
        && !(onboardingSession.step === 'workdir' && looksLikeWorkdirPathInput(text))
      ) {
        await safeSend(bot, chatId, 'Onboarding in progress. Reply to the current question or run /onboard cancel.');
        return;
      }
      await handleOnboardingInput(bot, chatId, text, chatRouter, states, onboardingSessions);
      return;
    }

    if (command === '/help') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'help', command });
      await safeSend(bot, chatId, getHelpText());
      return;
    }

    if (command === '/test') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'test', command });
      await sendTelegramFormattingShowcase(bot, chatId);
      return;
    }

    if (command === '/repos') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'repos', command });
      await sendRepoList(bot, chatId, chatRouter);
      return;
    }

    if (command === '/connect') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'connect', command, args: parsed ? parsed.args : [] });
      await handleConnectCommand(bot, chatId, parsed ? parsed.args : [], chatRouter, states);
      return;
    }

    if (command === '/tunnel' && parsed && String(parsed.args[0] || '').trim().toLowerCase() === 'auth') {
      if (typeof audit === 'function') audit('router.message.route', { chatId, target: 'tunnel_auth', command });
      await handleTunnelAuthCommand(bot, msg, parsed);
      return;
    }

    const repo = chatRouter.get(chatId);

    if (!repo) {
      if (typeof audit === 'function') {
        audit('router.message.unmapped_chat', {
          chatId,
          command: command || null,
          hasText: !!text,
        });
      }
      if (command === '/start' || command === '/whereami' || command === '/restart' || command === '/interrupt') {
        await safeSend(
          bot,
          chatId,
          [
            `chat_id: ${chatId}`,
            'This chat is not mapped to any repo yet.',
            '',
            'To onboard this chat in-place:',
            '1) Run /onboard (setup wizard)',
            '2) Run /repos',
            '3) Run /connect <repo>',
            '4) Retry your prompt in this chat',
            '',
            'Tip: use /help for full command and onboarding guide.',
          ].join('\n')
        );
      }

      if (
        command
        && command !== '/onboard'
        && command !== '/init'
        && command !== '/repos'
        && command !== '/connect'
        && command !== '/start'
        && command !== '/whereami'
        && command !== '/restart'
        && command !== '/interrupt'
        && command !== '/tunnel'
      ) {
        await safeSend(
          bot,
          chatId,
          [
            `chat_id: ${chatId}`,
            'This chat is not mapped yet.',
            'Start setup with /onboard, then run /repos and /connect <repo>.',
          ].join('\n')
        );
      }

      if (command === '/tunnel') {
        await safeSend(
          bot,
          chatId,
          [
            `chat_id: ${chatId}`,
            'This chat is not mapped yet, so tunnel open/status/close are unavailable here.',
            'Start setup with /onboard, then run /repos and /connect <repo>.',
            'You can still configure ngrok auth in a private chat with: /tunnel auth <your-token>',
          ].join('\n')
        );
      }

      if (!command && text) {
        await safeSend(
          bot,
          chatId,
          [
            `chat_id: ${chatId}`,
            'This chat is not mapped yet.',
            'Start setup with /onboard and answer the prompts.',
          ].join('\n')
        );
      }
      return;
    }

    const state = states.get(repo.name);
    if (typeof audit === 'function') {
      audit('router.message.mapped_chat', {
        chatId,
        repo: repo.name,
        command: command || null,
        running: !!(state && state.running),
      });
    }

    if (!command && state && state.questionFlow && state.questionFlow.waitingForCustomInput) {
      const result = await withStateDispatchLock(state, async () => handleQuestionTextInput(bot, repo, state, msg));
      if (result && result.handled) {
        return;
      }
    }

    if (command === '/restart' || command === '/interrupt') {
      if (typeof audit === 'function') {
        audit('router.message.route', { chatId, repo: repo.name, target: 'repo_immediate', command });
      }
      await handleRepoMessage(bot, repo, state, msg);
      return;
    }

    if (typeof audit === 'function') {
      audit('router.message.route', {
        chatId,
        repo: repo.name,
        target: 'repo_locked_dispatch',
        command: command || null,
      });
    }
    await withStateDispatchLock(state, async () => {
      await handleRepoMessage(bot, repo, state, msg);
    });
  };
}

module.exports = {
  createMessageHandler,
};
