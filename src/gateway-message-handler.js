'use strict';

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
    withStateDispatchLock,
    handleRepoMessage,
  } = deps;

  return async function handleMessage(msg) {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const parsed = parseCommand(text);
    const command = parsed ? parsed.command : '';

    if (command === '/onboard') {
      await handleOnboardCommand(bot, chatId, parsed, chatRouter, states, onboardingSessions);
      return;
    }

    if (command === '/init') {
      await handleInitCommand(bot, chatId, parsed, states, onboardingSessions, initSessions, chatRouter);
      return;
    }

    if (onboardingSessions.has(chatId)) {
      if (command && command !== '/onboard') {
        await safeSend(bot, chatId, 'Onboarding in progress. Reply to the current question or run /onboard cancel.');
        return;
      }
      await handleOnboardingInput(bot, chatId, text, chatRouter, states, onboardingSessions);
      return;
    }

    if (command === '/help') {
      await safeSend(bot, chatId, getHelpText());
      return;
    }

    if (command === '/test') {
      await sendTelegramFormattingShowcase(bot, chatId);
      return;
    }

    if (command === '/repos') {
      await sendRepoList(bot, chatId, chatRouter);
      return;
    }

    if (command === '/connect') {
      await handleConnectCommand(bot, chatId, parsed ? parsed.args : [], chatRouter, states);
      return;
    }

    const repo = chatRouter.get(chatId);

    if (!repo) {
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
    await withStateDispatchLock(state, async () => {
      await handleRepoMessage(bot, repo, state, msg);
    });
  };
}

module.exports = {
  createMessageHandler,
};
