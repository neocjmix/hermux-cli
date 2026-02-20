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
