const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/gateway');

test('parseCommand handles bot mention and args', () => {
  const parsed = _internal.parseCommand('/connect@my_bot repo-name');
  assert.equal(parsed.command, '/connect');
  assert.deepEqual(parsed.args, ['repo-name']);
});

test('splitByLimit splits long text near newline', () => {
  const input = 'line1\nline2\nline3\nline4';
  const out = _internal.splitByLimit(input, 9);
  assert.equal(out.length >= 2, true);
  assert.equal(out.join(''), input);
});

test('normalizeImageExt enforces safe extension format', () => {
  assert.equal(_internal.normalizeImageExt('.PNG'), '.png');
  assert.equal(_internal.normalizeImageExt('bad/ext'), '.jpg');
  assert.equal(_internal.normalizeImageExt(''), '.jpg');
});

test('getImagePayloadFromMessage prefers highest resolution photo', () => {
  const msg = {
    photo: [
      { file_id: 'small' },
      { file_id: 'large' },
    ],
  };
  const payload = _internal.getImagePayloadFromMessage(msg);
  assert.deepEqual(payload, {
    fileId: 'large',
    ext: '.jpg',
    source: 'photo',
  });
});

test('buildNoOutputMessage includes diagnostics context without raw events in normal mode', () => {
  const text = _internal.buildNoOutputMessage({
    exitCode: 1,
    stepCount: 2,
    toolCount: 3,
    toolNames: ['bash: ls', 'read: foo'],
    stepReason: 'max_steps',
    rawSamples: ['raw event'],
    logFile: './logs/x.log',
  });

  assert.match(text, /No final answer text was produced/);
  assert.match(text, /steps: 2, tools: 3/);
  assert.match(text, /log: .\/logs\/x\.log/);
  assert.doesNotMatch(text, /recent raw events/);
});

test('buildNoOutputMessage includes raw events in verbose mode', () => {
  const text = _internal.buildNoOutputMessage({
    exitCode: 1,
    stepCount: 2,
    toolCount: 3,
    toolNames: ['bash: ls'],
    stepReason: 'max_steps',
    rawSamples: ['raw event'],
    logFile: './logs/x.log',
    includeRawDiagnostics: true,
  });

  assert.match(text, /recent raw events/);
  assert.match(text, /raw event/);
});

test('buildNoOutputMessage includes rate-limit guidance when detected', () => {
  const text = _internal.buildNoOutputMessage({
    exitCode: 1,
    stepCount: 0,
    toolCount: 0,
    toolNames: [],
    stepReason: '',
    rawSamples: [],
    logFile: './logs/x.log',
    rateLimit: { detected: true, retryAfterSeconds: 42, line: '429 too many requests' },
    stderrSamples: ['Error: 429 Too Many Requests'],
  });

  assert.match(text, /Detected model\/API rate limit/);
  assert.match(text, /recommended wait: 42s/);
  assert.match(text, /recent stderr lines:/);
});

test('appendHermuxVersion appends version footer', () => {
  const text = _internal.appendHermuxVersion('opencode says hi', '0.1.1');
  assert.equal(text, 'opencode says hi\n\nhermux version: 0.1.1');
});

test('buildConnectKeyboard creates callback buttons per repo', () => {
  const keyboard = _internal.buildConnectKeyboard([
    { name: 'beta', enabled: true },
    { name: 'alpha', enabled: true },
  ]);
  assert.deepEqual(keyboard, {
    inline_keyboard: [
      [{ text: 'alpha', callback_data: 'connect:alpha' }],
      [{ text: 'beta', callback_data: 'connect:beta' }],
    ],
  });
});

test('buildVerboseKeyboard returns on/off callback buttons', () => {
  const keyboard = _internal.buildVerboseKeyboard();
  assert.deepEqual(keyboard, {
    inline_keyboard: [[
      { text: 'Verbose On', callback_data: 'verbose:on' },
      { text: 'Verbose Off', callback_data: 'verbose:off' },
    ]],
  });
});

test('buildModelsRootKeyboard includes refresh and agent shortcuts', () => {
  const keyboard = _internal.buildModelsRootKeyboard();
  assert.equal(Array.isArray(keyboard.inline_keyboard), true);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'm:l:op');
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, 'm:l:omo');
  assert.equal(keyboard.inline_keyboard[2][0].callback_data, 'm:r');
});

test('buildAgentPickerKeyboard and buildModelPickerKeyboard create tree steps', () => {
  const agentKb = _internal.buildAgentPickerKeyboard(['sisyphus']);
  assert.equal(agentKb.inline_keyboard[0][0].callback_data, 'm:a:0');

  const modelKb = _internal.buildModelPickerKeyboard(['openai/gpt-5.3-codex'], 'omo');
  assert.equal(modelKb.inline_keyboard[0][0].callback_data, 'm:s:0');
});

test('buildProviderPickerKeyboard creates provider tree steps', () => {
  const kb = _internal.buildProviderPickerKeyboard([
    { providerId: 'anthropic', models: ['anthropic/claude-opus-4-6'] },
  ], 'op');
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'm:p:0');
});

test('buildModelsSummaryHtml uses compact quote blocks with minimal rows', () => {
  const out = _internal.buildModelsSummaryHtml('demo-repo');
  assert.equal(typeof out.html, 'string');
  assert.match(out.html, /① opencode/);
  assert.match(out.html, /② oh-my-opencode/);
  assert.match(out.html, /<pre>/);
  assert.match(out.html, /opencode:/);
});

test('buildStatusKeyboard includes status actions', () => {
  const keyboard = _internal.buildStatusKeyboard();
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'm:r');
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, 'verbose:status');
  assert.equal(keyboard.inline_keyboard[0][2].callback_data, 'interrupt:now');
});

test('buildRuntimeStatusHtml renders readable status card', () => {
  const html = _internal.buildRuntimeStatusHtml({
    repo: { name: 'demo-repo', workdir: '/tmp/demo' },
    state: { running: true, waitingInfo: { status: 'retry', retryAfterSeconds: 30 }, verbose: true, queue: [1, 2] },
    chatId: '123',
  });
  assert.match(html, /Runtime Status/);
  assert.match(html, /busy: yes/);
  assert.match(html, /waiting: yes/);
  assert.match(html, /queue: 2/);
  assert.match(html, /runtime: /);
  assert.match(html, /transport: /);
});

test('buildStreamingStatusHtml wraps and escapes text tail', () => {
  const html = _internal.buildStreamingStatusHtml('line <a> & b', false);
  assert.equal(typeof html, 'string');
  assert.match(html, /&lt;a&gt; &amp; b/);
});

test('buildStreamingStatusHtml keeps markdown formatting during stream', () => {
  const html = _internal.buildStreamingStatusHtml('**bold** and `code`', true);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>code<\/code>/);
});

test('buildTelegramFormattingShowcase includes markdown and html formatting samples', () => {
  const sample = _internal.buildTelegramFormattingShowcase();
  assert.equal(typeof sample.markdown, 'string');
  assert.equal(typeof sample.html, 'string');
  assert.match(sample.markdown, /`alpha`/);
  assert.match(sample.markdown, /```text/);
  assert.match(sample.markdown, /\*\*bold\*\*/);
  assert.match(sample.html, /<tg-spoiler>/);
  assert.match(sample.html, /<blockquote>/);
  assert.match(sample.html, /<a href=/);
});

test('buildLiveStatusPanelHtml shows emoji-rich compact panel', () => {
  const html = _internal.buildLiveStatusPanelHtml({
    repoName: 'demo-repo',
    verbose: false,
    phase: 'running',
    stepCount: 2,
    toolCount: 1,
    queueLength: 2,
    sessionId: 'sess-abcdef',
    waitInfo: null,
    lastTool: 'bash: ls',
    lastRaw: '',
    lastStepReason: 'continue',
  });

  assert.match(html, /🏃/);
  assert.doesNotMatch(html, /🧠/);
  assert.match(html, /🔁 2/);
  assert.match(html, /🧰 1/);
  assert.match(html, /📥 queue: 2/);
  assert.doesNotMatch(html, /🔧/);
});

test('buildLiveStatusPanelHtml renders waiting quota state', () => {
  const html = _internal.buildLiveStatusPanelHtml({
    repoName: 'demo-repo',
    verbose: false,
    phase: 'waiting',
    stepCount: 1,
    toolCount: 0,
    queueLength: 0,
    sessionId: 'sess-abcdef',
    waitInfo: { status: 'retry', retryAfterSeconds: 42 },
    lastTool: '',
    lastRaw: '',
    lastStepReason: '',
  });

  assert.match(html, /⌛/);
  assert.match(html, /waiting for model quota/);
  assert.match(html, /42s/);
});

test('extractMermaidBlocks parses fenced mermaid blocks', () => {
  const src = [
    'hello',
    '```mermaid',
    'graph TD',
    'A-->B',
    '```',
    '',
    '```mermaid',
    'sequenceDiagram',
    'Alice->>Bob: Hi',
    '```',
  ].join('\n');

  const blocks = _internal.extractMermaidBlocks(src);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /graph TD/);
  assert.match(blocks[1], /sequenceDiagram/);
});

test('withStateDispatchLock serializes concurrent tasks', async () => {
  const state = {};
  const seq = [];

  const a = _internal.withStateDispatchLock(state, async () => {
    seq.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    seq.push('a:end');
  });

  const b = _internal.withStateDispatchLock(state, async () => {
    seq.push('b:start');
    seq.push('b:end');
  });

  await Promise.all([a, b]);
  assert.deepEqual(seq, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('serializePollingError extracts useful telegram fields', () => {
  const detail = _internal.serializePollingError({
    code: 'ETELEGRAM',
    message: '409 conflict',
    response: {
      statusCode: 409,
      body: {
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
        parameters: { retry_after: 2 },
      },
    },
  });

  assert.equal(detail.code, 'ETELEGRAM');
  assert.equal(detail.httpStatus, 409);
  assert.equal(detail.tgErrorCode, 409);
  assert.match(detail.description, /terminated by other getUpdates/i);
});

test('withRestartMutationLock serializes restart critical section', async () => {
  const seq = [];

  const a = _internal.withRestartMutationLock(async () => {
    seq.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    seq.push('a:end');
  });

  const b = _internal.withRestartMutationLock(async () => {
    seq.push('b:start');
    seq.push('b:end');
  });

  await Promise.all([a, b]);
  assert.deepEqual(seq, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('requestInterrupt sends SIGTERM then SIGKILL escalation', async () => {
  const calls = [];
  const proc = {
    killed: false,
    kill: (sig) => {
      calls.push(sig);
    },
  };
  const state = {
    running: true,
    currentProc: proc,
    interruptRequested: false,
    interruptEscalationTimer: null,
  };

  const result = _internal.requestInterrupt(state, { forceAfterMs: 10 });
  assert.equal(result.ok, true);
  assert.equal(state.interruptRequested, true);
  assert.equal(typeof state.interruptTrace.requestedAt, 'number');
  assert.equal(typeof state.interruptTrace.termSentAt, 'number');
  assert.equal(state.interruptTrace.forceAfterMs, 10);
  assert.deepEqual(calls, ['SIGTERM']);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']);
});

test('requestInterrupt escalates to SIGKILL even when proc.killed is true', async () => {
  const calls = [];
  const proc = {
    killed: false,
    kill: (sig) => {
      calls.push(sig);
      if (sig === 'SIGTERM') proc.killed = true;
    },
  };
  const state = {
    running: true,
    currentProc: proc,
    interruptRequested: false,
    interruptEscalationTimer: null,
  };

  _internal.requestInterrupt(state, { forceAfterMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']);
  assert.equal(state.interruptTrace.status, 'kill_sent');
});

test('requestInterrupt uses injected signal sender for TERM and KILL', async () => {
  const calls = [];
  const proc = { pid: 12345, killed: false, kill: () => {} };
  const state = {
    running: true,
    currentProc: proc,
    interruptRequested: false,
    interruptEscalationTimer: null,
  };

  const sendSignal = (p, sig) => {
    calls.push(`${p.pid}:${sig}`);
  };

  const result = _internal.requestInterrupt(state, { forceAfterMs: 10, sendSignal });
  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['12345:SIGTERM', '12345:SIGKILL']);
});

test('getReplyContext extracts replied text', () => {
  const msg = {
    reply_to_message: {
      text: 'previous assistant response',
    },
  };
  assert.equal(_internal.getReplyContext(msg), 'previous assistant response');
});

test('getReplyContext truncates long replied text', () => {
  const long = 'a'.repeat(1300);
  const msg = {
    reply_to_message: {
      text: long,
    },
  };
  const got = _internal.getReplyContext(msg);
  assert.equal(got.length, 1203);
  assert.equal(got.endsWith('...'), true);
});

test('formatRepoList shows empty-state hint', () => {
  const text = _internal.formatRepoList([], '');
  assert.match(text, /No enabled repos are configured yet/);
});

test('isValidModelRef validates provider/model format', () => {
  assert.equal(_internal.isValidModelRef('openai/gpt-5.3-codex'), true);
  assert.equal(_internal.isValidModelRef('invalid-model'), false);
  assert.equal(_internal.isValidModelRef('openai/'), false);
});

test('buildModelApplyMessage includes restart and session semantics', () => {
  const text = _internal.buildModelApplyMessage({
    layer: 'opencode',
    scope: 'global',
    before: 'openai/gpt-5.3-codex',
    after: 'google/antigravity-gemini-3-pro-high',
    restartRequired: false,
    applyStatus: 'scheduled_after_current_run',
    sessionImpact: 'preserved',
    note: 'Current task keeps previous model.',
  });

  assert.match(text, /layer: opencode/);
  assert.match(text, /restart_required: no/);
  assert.match(text, /session_impact: preserved/);
  assert.match(text, /scheduled_after_current_run/);
});

test('sanitizeFinalOutputText removes system reminder blocks and prompt echo', () => {
  const prompt = 'Analyze this system';
  const raw = [
    '<system-reminder>ignore me</system-reminder>',
    prompt,
    '',
    'Final **answer** block',
  ].join('\n');

  const cleaned = _internal.sanitizeFinalOutputText(raw, prompt);
  assert.equal(cleaned, 'Final **answer** block');
});

test('sanitizeFinalOutputText keeps legacy wrapper text if present', () => {
  const prompt = 'diagnose this';
  const raw = [
    '<ultrawork-mode>',
    '**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!"',
    '</ultrawork-mode>',
    '---',
    prompt,
    '',
    'Canonical final answer body',
  ].join('\n');

  const cleaned = _internal.sanitizeFinalOutputText(raw, prompt);
  assert.match(cleaned, /<ultrawork-mode>/);
  assert.match(cleaned, /Canonical final answer body/);
});

test('selectFinalOutputText prefers authoritative full text when stream is trailing fragment', () => {
  const chosen = _internal.selectFinalOutputText(
    'Architecture overview\n\nDetailed final recommendation',
    'Detailed final recommendation'
  );
  assert.equal(chosen, 'Architecture overview\n\nDetailed final recommendation');
});

test('selectFinalOutputText always prioritizes meta final when present', () => {
  const chosen = _internal.selectFinalOutputText(
    'Canonical meta final',
    'Canonical meta final\n\nplus unrelated stream tail'
  );
  assert.equal(chosen, 'Canonical meta final');
});

test('resolveFinalizationOutput always emits final when resolved text exists', () => {
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: 'Full final answer with header\n\n```mermaid\ngraph TD\nA-->B\n```',
    streamFinalText: '```mermaid\ngraph TD\nA-->B\n```',
    promptText: 'Explain architecture',
    isVersionPrompt: false,
    hermuxVersion: '1.2.3',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.match(resolved.outgoingText, /Full final answer with header/);
  assert.equal(resolved.streamCompletionText, 'completed. final answer sent below.');
});

test('resolveFinalizationOutput appends version footer for version prompts', () => {
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: '',
    streamFinalText: 'Version details',
    promptText: '/version',
    isVersionPrompt: true,
    hermuxVersion: '9.9.9',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.match(resolved.outgoingText, /Version details/);
  assert.match(resolved.outgoingText, /hermux version: 9\.9\.9/);
});

test('resolveFinalizationOutput reports no-answer completion when both sources are empty', () => {
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: '',
    streamFinalText: '',
    promptText: 'empty-case',
    isVersionPrompt: false,
    hermuxVersion: '1.0.0',
  });

  assert.equal(resolved.shouldSendFinal, false);
  assert.equal(resolved.outgoingText, '');
  assert.equal(resolved.streamCompletionText, 'completed (no final answer produced).');
});
