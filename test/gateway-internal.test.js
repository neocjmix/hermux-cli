const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/gateway');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test('clearRunRenderStateAtRunStart clears only active session render cache', () => {
  const state = {
    sessionRenderStates: new Map([
      ['ses-a', { sessionId: 'ses-a', value: 1 }],
      ['ses-b', { sessionId: 'ses-b', value: 2 }],
    ]),
    latestSessionRenderState: { sessionId: 'ses-a', value: 1 },
  };

  _internal.clearRunRenderStateAtRunStart(state, 'ses-a');

  assert.equal(state.sessionRenderStates.has('ses-a'), false);
  assert.equal(state.sessionRenderStates.has('ses-b'), true);
  assert.equal(state.latestSessionRenderState, null);
});

test('clearRunRenderStateAtRunStart is no-op for empty session id', () => {
  const state = {
    sessionRenderStates: new Map([
      ['ses-a', { sessionId: 'ses-a', value: 1 }],
    ]),
    latestSessionRenderState: { sessionId: 'ses-a', value: 1 },
  };

  _internal.clearRunRenderStateAtRunStart(state, '');

  assert.equal(state.sessionRenderStates.has('ses-a'), true);
  assert.deepEqual(state.latestSessionRenderState, { sessionId: 'ses-a', value: 1 });
});

test('createTrailingThrottleProcessor applies leading then trailing latest value', async () => {
  const seen = [];
  const throttled = _internal.createTrailingThrottleProcessor({
    intervalMs: 80,
    handler: async (value) => {
      seen.push(value);
    },
  });

  await throttled('a');
  await throttled('b');
  await throttled('c');
  await sleep(120);

  assert.deepEqual(seen, ['a', 'c']);
});

test('createTrailingThrottleProcessor with interval 0 applies all events immediately', async () => {
  const seen = [];
  const throttled = _internal.createTrailingThrottleProcessor({
    intervalMs: 0,
    handler: async (value) => {
      seen.push(value);
    },
  });

  await throttled('x');
  await throttled('y');

  assert.deepEqual(seen, ['x', 'y']);
});

test('createTrailingThrottleProcessor supports selectPending merge policy', async () => {
  const seen = [];
  const throttled = _internal.createTrailingThrottleProcessor({
    intervalMs: 80,
    selectPending: (prev, next) => {
      if (!prev) return next;
      return String(next).length >= String(prev).length ? next : prev;
    },
    handler: async (value) => {
      seen.push(value);
    },
  });

  await throttled('a');
  await throttled('bb');
  await throttled('c');
  await sleep(120);

  assert.deepEqual(seen, ['a', 'bb']);
});

test('createTrailingThrottleProcessor gates by start time, not completion time', async () => {
  const starts = [];
  const throttled = _internal.createTrailingThrottleProcessor({
    intervalMs: 80,
    handler: async (value) => {
      starts.push({ value, at: Date.now() });
      await sleep(120);
    },
  });

  const p1 = throttled('first');
  await sleep(10);
  await throttled('second');
  await p1;
  await sleep(30);

  assert.equal(starts.length, 2);
  const delta = starts[1].at - starts[0].at;
  assert.equal(delta < 170, true);
});

test('createTrailingThrottleProcessor resolves queued calls immediately', async () => {
  const seen = [];
  const throttled = _internal.createTrailingThrottleProcessor({
    intervalMs: 80,
    handler: async (value) => {
      seen.push(value);
      await sleep(120);
    },
  });

  const p1 = throttled('first');
  await sleep(10);
  const queuedStart = Date.now();
  await throttled('queued');
  const queuedElapsed = Date.now() - queuedStart;
  await p1;
  await sleep(30);

  assert.equal(queuedElapsed < 40, true);
  assert.deepEqual(seen, ['first', 'queued']);
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

test('buildAuditContentMeta records stable hash and truncation intent', () => {
  const small = _internal.buildAuditContentMeta('abc');
  assert.equal(small.contentRawLength, 3);
  assert.equal(small.willAuditTruncate, false);
  assert.equal(small.contentSha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  const huge = _internal.buildAuditContentMeta('x'.repeat(17001));
  assert.equal(huge.contentRawLength, 17001);
  assert.equal(huge.willAuditTruncate, true);
  assert.equal(huge.auditStringMax >= 16000, true);
});

test('buildNoOutputMessage surfaces sanitized-empty reason when raw output existed', () => {
  const text = _internal.buildNoOutputMessage({
    exitCode: 0,
    stepCount: 1,
    toolCount: 0,
    toolNames: [],
    stepReason: '',
    rawSamples: [],
    logFile: './logs/x.log',
    noOutputReason: 'sanitized_prompt_echo',
  });

  assert.match(text, /sanitized as prompt\/control echo/);
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
    runId: '1771942552137-b2a4c1',
    verbose: false,
    phase: 'running',
    stepCount: 2,
    toolCount: 1,
    queueLength: 2,
    sessionId: 'sess-abcdef',
    waitInfo: null,
    lastTool: 'bash: ls',
    lastReasoning: '',
    lastReminder: '```text\nsystem-reminder:\ncheck this\n```',
    lastRaw: '',
    lastStepReason: 'continue',
  });

  assert.match(html, /🏃/);
  assert.doesNotMatch(html, /🧠/);
  assert.match(html, /🔁 2/);
  assert.match(html, /🧰 1/);
  assert.match(html, /📥 queue: 2/);
  assert.match(html, /🧷 1771942552137-b2a4c1/);
  assert.match(html, /<pre><code class="language-text">/);
  assert.match(html, /system-reminder:/);
  assert.doesNotMatch(html, /🔧/);
});

test('buildLiveStatusPanelHtml renders waiting quota state', () => {
  const html = _internal.buildLiveStatusPanelHtml({
    repoName: 'demo-repo',
    runId: '1771942552137-b2a4c1',
    verbose: false,
    phase: 'waiting',
    stepCount: 1,
    toolCount: 0,
    queueLength: 0,
    sessionId: 'sess-abcdef',
    waitInfo: { status: 'retry', retryAfterSeconds: 42 },
    lastTool: '',
    lastReasoning: '',
    lastReminder: '',
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

test('collectMermaidBlocksFromTextSegments merges segments and extracts mermaid fences', () => {
  const blocks = _internal.collectMermaidBlocksFromTextSegments([
    'prefix\n```mermaid\ngraph TD\nA-->B\n```',
    'middle',
    '```mermaid\nsequenceDiagram\nAlice->>Bob: Hi\n```\npostfix',
  ]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /graph TD/);
  assert.match(blocks[1], /sequenceDiagram/);
});

test('parseRawEventContent classifies JSON and plain text', () => {
  const json = _internal.parseRawEventContent('{"type":"server.connected"}');
  assert.equal(json.kind, 'json');
  assert.equal(json.json.type, 'server.connected');

  const text = _internal.parseRawEventContent('plain message');
  assert.equal(text.kind, 'text');
});

test('formatRawEventPreview formats toast and removes spinner glyph noise', () => {
  const out = _internal.formatRawEventPreview(JSON.stringify({
    type: 'tui.toast.show',
    properties: {
      title: '● OhMyOpenCode 3.8.3',
      message: 'Sisyphus on steroids is steering OpenCode.',
    },
  }));

  assert.equal(out.category, 'toast');
  assert.match(out.preview, /^toast:/);
  assert.doesNotMatch(out.preview, /●/);
  assert.match(out.preview, /OhMyOpenCode 3\.8\.3/);
});

test('formatRawEventPreview summarizes session and delta events', () => {
  const sessionOut = _internal.formatRawEventPreview(JSON.stringify({
    type: 'session.updated',
    properties: { info: { id: 'ses_abcdef1234567890', directory: '/tmp/demo' } },
  }));
  assert.equal(sessionOut.category, 'session');
  assert.match(sessionOut.preview, /session updated/);
  assert.match(sessionOut.preview, /\/tmp\/demo/);

  const deltaOut = _internal.formatRawEventPreview(JSON.stringify({
    type: 'message.part.delta',
    properties: { field: 'text', delta: 'hello world' },
  }));
  assert.equal(deltaOut.category, 'message_delta');
  assert.match(deltaOut.preview, /stream delta: hello world/);
});

test('resolveRawDeliveryPlan applies deterministic category rules', () => {
  const plain = _internal.resolveRawDeliveryPlan({ show: true, preview: 'hello', category: 'plain_text' }, false);
  assert.deepEqual(plain, { updateStream: true, sendVerboseDirect: false });

  const toastNormal = _internal.resolveRawDeliveryPlan({ show: true, preview: 'toast: hi', category: 'toast' }, false);
  assert.deepEqual(toastNormal, { updateStream: false, sendVerboseDirect: false });

  const toastVerbose = _internal.resolveRawDeliveryPlan({ show: true, preview: 'toast: hi', category: 'toast' }, true);
  assert.deepEqual(toastVerbose, { updateStream: true, sendVerboseDirect: false });

  const sessionVerbose = _internal.resolveRawDeliveryPlan({ show: true, preview: 'session updated', category: 'session' }, true);
  assert.deepEqual(sessionVerbose, { updateStream: false, sendVerboseDirect: true });

  const sessionNormal = _internal.resolveRawDeliveryPlan({ show: true, preview: 'session updated', category: 'session' }, false);
  assert.deepEqual(sessionNormal, { updateStream: false, sendVerboseDirect: false });
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

test('sanitizeFinalOutputText currently behaves as pass-through trim', () => {
  const prompt = 'Analyze this system';
  const raw = [
    '<system-reminder>ignore me</system-reminder>',
    prompt,
    '',
    'Final **answer** block',
  ].join('\n');

  const cleaned = _internal.sanitizeFinalOutputText(raw, prompt);
  assert.equal(cleaned, raw);
});

test('sanitizeFinalOutputText keeps prompt/context content intact', () => {
  const prompt = 'Analyze this system';
  const raw = [
    'ultrawork header',
    'context chunk 1',
    prompt,
    'expanded chain',
    prompt,
    '',
    'actual final answer',
  ].join('\n');

  const cleaned = _internal.sanitizeFinalOutputText(raw, prompt);
  assert.equal(cleaned, raw);
});

test('sanitizeFinalOutputText preserves legacy wrapper text', () => {
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
  assert.equal(cleaned.includes('<ultrawork-mode>'), true);
  assert.match(cleaned, /Canonical final answer body/);
});

test('sanitizeFinalOutputText preserves OMO initiator markers', () => {
  const prompt = 'diag';
  const raw = [
    prompt,
    '',
    'alpha',
    '<!-- OMO_INTERNAL_INITIATOR -->',
    'beta',
    '&lt;!-- OMO_INTERNAL_INITIATOR --&gt;',
    'gamma',
  ].join('\n');
  const cleaned = _internal.sanitizeFinalOutputText(raw, prompt);
  assert.equal(/OMO_INTERNAL_INITIATOR/.test(cleaned), true);
  assert.match(cleaned, /alpha/);
  assert.match(cleaned, /beta/);
  assert.match(cleaned, /gamma/);
});

test('extractLatestSystemReminder returns latest reminder and stripped text', () => {
  const raw = [
    'a',
    '<system-reminder>first</system-reminder>',
    'b',
    '<system-reminder>second</system-reminder>',
  ].join('\n');
  const out = _internal.extractLatestSystemReminder(raw);
  assert.equal(out.reminderText, 'second');
  assert.equal(out.text.includes('system-reminder'), false);
  assert.match(out.text, /a/);
  assert.match(out.text, /b/);
});

test('formatSystemReminderForDisplay compacts completed reminders into code block', () => {
  const raw = [
    '[ALL BACKGROUND TASKS COMPLETE]',
    '',
    'Completed:',
    '- bg_1: one',
    '- bg_2: two',
    '',
    'Use background_output(task_id="<id>") to retrieve each result.',
  ].join('\n');
  const out = _internal.formatSystemReminderForDisplay(raw);
  assert.equal(out.startsWith('```text\nCompleted:\n- bg_1: one\n- bg_2: two\n```'), true);
  assert.equal(out.includes('Use background_output'), false);
});

test('formatSystemReminderForDisplay always wraps generic reminders in code block', () => {
  const out = _internal.formatSystemReminderForDisplay('system-reminder:\nwatch queue size');
  assert.equal(out, '```text\nsystem-reminder:\nwatch queue size\n```');
});

test('formatSystemReminderForDisplay handles prefixed and generic bracket header', () => {
  const raw = 'system-reminder:\n[BACKGROUND TASK COMPLETED]\n\nCompleted:\n- bg_x: x';
  const out = _internal.formatSystemReminderForDisplay(raw);
  assert.equal(out, '```text\nCompleted:\n- bg_x: x\n```');
});

test('reconcileOutputSnapshot applies stream and final text in one shared flow', () => {
  const snapshot = _internal.createOutputSnapshot();
  const prompt = 'do task';

  const streamPass = _internal.reconcileOutputSnapshot(snapshot, {
    rawText: `${prompt}\n\nintermediate answer`,
    textKind: 'stream',
    promptText: prompt,
    authoritativeFinal: false,
  });
  assert.equal(streamPass.cleaned, `${prompt}\n\nintermediate answer`);
  assert.equal(snapshot.streamText, `${prompt}\n\nintermediate answer`);
  assert.equal(snapshot.finalCandidate, `${prompt}\n\nintermediate answer`);

  const finalPass = _internal.reconcileOutputSnapshot(snapshot, {
    rawText: 'final answer',
    textKind: 'final',
    promptText: prompt,
    authoritativeFinal: false,
  });
  assert.equal(finalPass.classifiedKind, 'final');
  assert.equal(snapshot.finalSeen, 'final answer');
  assert.match(snapshot.finalCandidate, /final answer/);
});

test('reconcileOutputSnapshot does not extract reminder under pass-through sanitizer', () => {
  const snapshot = _internal.createOutputSnapshot();
  const out = _internal.reconcileOutputSnapshot(snapshot, {
    rawText: '<system-reminder>keep queueing</system-reminder>\n\nbody text',
    textKind: 'stream',
    promptText: '',
    authoritativeFinal: false,
  });

  assert.equal(out.reminderText, '');
  assert.match(out.cleaned, /<system-reminder>keep queueing<\/system-reminder>/);
  assert.match(snapshot.streamText, /body text/);
});

test('reconcileOutputSnapshot returns reasoning text without mutating final candidate', () => {
  const snapshot = _internal.createOutputSnapshot();
  snapshot.rawFinalSnapshot = 'stable final';
  snapshot.canonicalFinal = 'stable final';
  snapshot.finalCandidate = 'stable final';

  const out = _internal.reconcileOutputSnapshot(snapshot, {
    rawText: 'reasoning trace line',
    textKind: 'reasoning',
    promptText: '',
    authoritativeFinal: false,
  });

  assert.equal(out.classifiedKind, 'reasoning');
  assert.equal(out.reasoningText, 'reasoning trace line');
  assert.equal(snapshot.streamText, 'reasoning trace line');
  assert.equal(snapshot.finalCandidate, 'stable final');
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
  assert.equal(resolved.emptyReason, 'no_raw_output');
});

test('resolveFinalizationOutput keeps raw ultrawork payload when sanitizer is pass-through', () => {
  const prompt = 'run this exact prompt';
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: `<ultrawork-mode>\n${prompt}`,
    streamFinalText: '',
    promptText: prompt,
    isVersionPrompt: false,
    hermuxVersion: '0.0.0',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.equal(resolved.hadRawFinal, true);
  assert.equal(resolved.emptyReason, 'no_raw_output');
  assert.equal(resolved.streamCompletionText, 'completed. final answer sent below.');
});

test('resolveFinalizationOutput does not need recovery when sanitizer is pass-through', () => {
  const prompt = 'run this exact prompt';
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: `Execution notes\n\nFinal answer body\n${prompt}`,
    streamFinalText: '',
    promptText: prompt,
    isVersionPrompt: false,
    hermuxVersion: '0.0.0',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.equal(resolved.emptyReason, 'no_raw_output');
  assert.match(resolved.outgoingText, /Final answer body/);
});

test('resolveFinalizationOutput forwards control-only payload under pass-through sanitizer', () => {
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: '<system-reminder>internal only</system-reminder>',
    streamFinalText: '',
    promptText: 'anything',
    isVersionPrompt: false,
    hermuxVersion: '0.0.0',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.equal(resolved.emptyReason, 'no_raw_output');
});

test('resolveFinalizationOutput keeps prompt suffix under pass-through sanitizer', () => {
  const prompt = 'run this exact prompt';
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: [
      'Here is the actual final answer body.',
      '',
      prompt,
    ].join('\n'),
    streamFinalText: '',
    promptText: prompt,
    isVersionPrompt: false,
    hermuxVersion: '0.0.0',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.equal(resolved.emptyReason, 'no_raw_output');
  assert.match(resolved.outgoingText, /actual final answer body/);
});

test('resolveFinalizationOutput forwards ultrawork control block under pass-through sanitizer', () => {
  const prompt = 'run this exact prompt';
  const resolved = _internal.resolveFinalizationOutput({
    metaFinalText: [
      '<ultrawork-mode>',
      '**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!"',
      '[CODE RED] Maximum precision required.',
      '### **MANDATORY CERTAINTY PROTOCOL**',
      '</ultrawork-mode>',
      prompt,
    ].join('\n'),
    streamFinalText: '',
    promptText: prompt,
    isVersionPrompt: false,
    hermuxVersion: '0.0.0',
  });

  assert.equal(resolved.shouldSendFinal, true);
  assert.equal(resolved.emptyReason, 'no_raw_output');
});
