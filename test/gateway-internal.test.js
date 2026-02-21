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

test('buildNoOutputMessage includes diagnostics context', () => {
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

test('buildStreamingStatusHtml wraps and escapes text tail', () => {
  const html = _internal.buildStreamingStatusHtml('line <a> & b', false);
  assert.match(html, /Streaming response/);
  assert.match(html, /mode: compact/);
  assert.match(html, /&lt;a&gt; &amp; b/);
});

test('buildStreamingStatusHtml uses preformatted block in verbose mode', () => {
  const html = _internal.buildStreamingStatusHtml('line <a> & b', true);
  assert.match(html, /Streaming response/);
  assert.match(html, /<pre>/);
  assert.match(html, /&lt;a&gt; &amp; b/);
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
  assert.match(html, /🔧/);
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
