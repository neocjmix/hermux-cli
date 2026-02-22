'use strict';

function createRepoMessageHandler(deps) {
  const {
    parseCommand,
    safeSend,
    buildRuntimeStatusHtml,
    buildStatusKeyboard,
    handleModelsCommand,
    getSessionInfo,
    SESSION_MAP_PATH,
    clearSessionId,
    handleRestartCommand,
    getHelpText,
    sendTelegramFormattingShowcase,
    sendRepoList,
    handleVerboseAction,
    requestInterrupt,
    buildPromptFromMessage,
    startPromptRun,
  } = deps;

  return async function handleRepoMessage(bot, repo, state, msg) {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const parsed = parseCommand(text);
    const command = parsed ? parsed.command : '';
    const isVersionPrompt = command === '/version';

    if (command === '/start') {
      await safeSend(
        bot,
        chatId,
        [
          `opencode gateway [${repo.name}]`,
          `workdir: ${repo.workdir}`,
          '',
          `mode: ${state.verbose ? 'verbose (stream events)' : 'compact (final output only)'}`,
          'commands: /repos, /status, /models, /session, /version, /test, /interrupt, /restart, /reset, /init, /verbose on, /verbose off, /whereami',
          '',
          'Send any prompt to run opencode.',
        ].join('\n')
      );
      return;
    }

    if (command === '/status') {
      await safeSend(
        bot,
        chatId,
        buildRuntimeStatusHtml({ repo, state, chatId }),
        { parse_mode: 'HTML', reply_markup: buildStatusKeyboard() }
      );
      return;
    }

    if (command === '/models') {
      await handleModelsCommand(bot, chatId, repo, state, parsed);
      return;
    }

    if (command === '/session') {
      const info = getSessionInfo(repo.name, chatId);
      if (!info || !info.sessionId) {
        await safeSend(bot, chatId, `No active session for this chat yet.\nrepo: ${repo.name}\nchat_id: ${chatId}`);
        return;
      }
      await safeSend(
        bot,
        chatId,
        `repo: ${repo.name}\nchat_id: ${chatId}\nsession_id: ${info.sessionId}\nupdated_at: ${info.updatedAt || 'unknown'}\nstate_file: ${SESSION_MAP_PATH}`
      );
      return;
    }

    if (command === '/reset') {
      if (state.running) {
        await safeSend(bot, chatId, 'Cannot reset while running. Wait for current task to finish.');
        return;
      }
      const cleared = clearSessionId(repo.name, chatId);
      if (cleared) {
        await safeSend(bot, chatId, `Session reset complete for repo ${repo.name}.\nNext prompt will start a new opencode session.`);
      } else {
        await safeSend(bot, chatId, `No stored session found for repo ${repo.name}.`);
      }
      return;
    }

    if (command === '/restart') {
      await handleRestartCommand(bot, chatId, repo, state);
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
      await sendRepoList(bot, chatId, new Map([[chatId, repo]]));
      return;
    }

    if (command === '/whereami') {
      await safeSend(
        bot,
        chatId,
        `chat_id: ${chatId}\nrepo: ${repo.name}`
      );
      return;
    }

    if (command === '/verbose' && (!parsed || parsed.args.length === 0 || parsed.args[0] === 'status')) {
      await handleVerboseAction(bot, chatId, state, 'status');
      return;
    }

    if (command === '/verbose' && parsed && parsed.args[0] === 'on') {
      await handleVerboseAction(bot, chatId, state, 'on');
      return;
    }

    if (command === '/verbose' && parsed && parsed.args[0] === 'off') {
      await handleVerboseAction(bot, chatId, state, 'off');
      return;
    }

    if (command === '/interrupt') {
      if (!state.running || !state.currentProc) {
        await safeSend(bot, chatId, 'No running task to interrupt.');
        return;
      }
      const req = requestInterrupt(state, { forceAfterMs: 5000 });
      if (!req.ok) {
        const msg = req.error ? req.error.message : req.reason;
        await safeSend(bot, chatId, `Failed to interrupt current task: ${msg}`);
        return;
      }
      await safeSend(bot, chatId, req.alreadyRequested ? 'Interrupt already requested. Waiting for task shutdown...' : 'Interrupt requested. Stopping current task...');
      return;
    }

    let preparedPrompt;
    try {
      preparedPrompt = await buildPromptFromMessage(bot, repo, msg);
    } catch (err) {
      console.error(`[${repo.name}] failed to prepare prompt:`, err.message);
      await safeSend(bot, chatId, `Failed to read image attachment: ${err.message}`);
      return;
    }

    if (!preparedPrompt) return;

    if (!Array.isArray(state.queue)) state.queue = [];

    const promptText = preparedPrompt.prompt;
    const queuedItem = {
      chatId,
      promptText,
      isVersionPrompt,
    };

    if (state.running) {
      state.queue.push(queuedItem);
      if (typeof state.panelRefresh === 'function') {
        await state.panelRefresh(true);
      }
      return;
    }

    await startPromptRun(bot, repo, state, queuedItem);
  };
}

module.exports = {
  createRepoMessageHandler,
};
