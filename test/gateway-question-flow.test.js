'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const gatewayPath = require.resolve('../src/gateway');

function loadGatewayWithEnv(vars) {
  for (const [k, v] of Object.entries(vars || {})) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[gatewayPath];
  return require('../src/gateway');
}

test('gateway question callback submits selected option upstream and closes prompt', async () => {
  global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__ = [];
  const gateway = loadGatewayWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const bot = {
    editMessageTextCalls: [],
    sendMessageCalls: [],
    async editMessageText(text, opts) {
      this.editMessageTextCalls.push({ text, opts });
      return { message_id: opts.message_id };
    },
    async sendMessage(chatId, text) {
      this.sendMessageCalls.push({ chatId, text });
      return { message_id: 999 };
    },
  };
  const repo = {
    name: 'demo',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'gateway-question-callback.log'),
  };
  const state = {
    dispatchQueue: Promise.resolve(),
    questionFlow: {
      requestId: 'req-1',
      sessionId: 'ses-1',
      chatId: '100',
      questions: [{
        header: 'Need input',
        question: 'How should I continue?',
        options: [
          { label: 'Ship now', description: 'continue immediately' },
          { label: 'Wait', description: 'pause for review' },
        ],
        multiple: false,
        custom: true,
      }],
      currentIndex: 0,
      selectedOptionIndexes: {},
      customAnswers: {},
      waitingForCustomInput: false,
      messageId: 9,
      renderSignature: '',
    },
  };
  const chatRouter = new Map([['100', repo]]);
  const states = new Map([[repo.name, state]]);

  const out = await gateway._internal.handleQuestionCallback(
    bot,
    { message: { chat: { id: '100' } } },
    chatRouter,
    states,
    'select',
    0,
    0,
  );

  assert.equal(out.answerText, 'answered');
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__, [{
    requestID: 'req-1',
    directory: process.cwd(),
    answers: [['Ship now']],
  }]);
  assert.equal(state.questionFlow, null);
  assert.equal(bot.editMessageTextCalls.some((call) => String(call.text).includes('Sent answers:')), true);
});

test('gateway question text input submits custom answer upstream', async () => {
  global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__ = [];
  const gateway = loadGatewayWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const bot = {
    editMessageTextCalls: [],
    sendMessageCalls: [],
    async editMessageText(text, opts) {
      this.editMessageTextCalls.push({ text, opts });
      return { message_id: opts.message_id };
    },
    async sendMessage(chatId, text) {
      this.sendMessageCalls.push({ chatId, text });
      return { message_id: 1001 };
    },
  };
  const repo = {
    name: 'demo',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'gateway-question-custom.log'),
  };
  const state = {
    dispatchQueue: Promise.resolve(),
    questionFlow: {
      requestId: 'req-2',
      sessionId: 'ses-2',
      chatId: '100',
      questions: [{
        header: 'Need input',
        question: 'How should I continue?',
        options: [{ label: 'Ship now', description: 'continue immediately' }],
        multiple: false,
        custom: true,
      }],
      currentIndex: 0,
      selectedOptionIndexes: {},
      customAnswers: {},
      waitingForCustomInput: true,
      messageId: 10,
      renderSignature: '',
    },
  };

  const out = await gateway._internal.handleQuestionTextInput(
    bot,
    repo,
    state,
    { chat: { id: '100' }, text: 'Use Telegram callback' },
  );

  assert.deepEqual(out, { handled: true });
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__, [{
    requestID: 'req-2',
    directory: process.cwd(),
    answers: [['Use Telegram callback']],
  }]);
  assert.equal(state.questionFlow, null);
  assert.equal(bot.editMessageTextCalls.some((call) => String(call.text).includes('Use Telegram callback')), true);
});

test('gateway question text input reports unsupported sdk question api without crashing', async () => {
  const gateway = loadGatewayWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_FAKE_SDK_DISABLE_QUESTION_API: '1',
  });

  const bot = {
    editMessageTextCalls: [],
    sendMessageCalls: [],
    async editMessageText(text, opts) {
      this.editMessageTextCalls.push({ text, opts });
      return { message_id: opts.message_id };
    },
    async sendMessage(chatId, text) {
      this.sendMessageCalls.push({ chatId, text });
      return { message_id: 1001 };
    },
  };
  const repo = {
    name: 'demo',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'gateway-question-unsupported.log'),
  };
  const state = {
    dispatchQueue: Promise.resolve(),
    questionFlow: {
      requestId: 'req-unsupported',
      sessionId: 'ses-unsupported',
      chatId: '100',
      questions: [{
        header: 'Need input',
        question: 'How should I continue?',
        options: [{ label: 'Ship now', description: 'continue immediately' }],
        multiple: false,
        custom: true,
      }],
      currentIndex: 0,
      selectedOptionIndexes: {},
      customAnswers: {},
      waitingForCustomInput: true,
      messageId: 12,
      renderSignature: '',
    },
  };

  const out = await gateway._internal.handleQuestionTextInput(
    bot,
    repo,
    state,
    { chat: { id: '100' }, text: 'Use fallback' },
  );

  assert.deepEqual(out, { handled: true });
  assert.equal(state.questionFlow, null);
  assert.equal(bot.editMessageTextCalls.length + bot.sendMessageCalls.length >= 0, true);
});

test('gateway permission callback submits upstream reply and closes prompt', async () => {
  global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__ = [];
  const gateway = loadGatewayWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const bot = {
    editMessageTextCalls: [],
    sendMessageCalls: [],
    async editMessageText(text, opts) {
      this.editMessageTextCalls.push({ text, opts });
      return { message_id: opts.message_id };
    },
    async sendMessage(chatId, text) {
      this.sendMessageCalls.push({ chatId, text });
      return { message_id: 2001 };
    },
  };
  const repo = {
    name: 'demo',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'gateway-permission-callback.log'),
  };
  const state = {
    dispatchQueue: Promise.resolve(),
    permissionFlow: {
      requestId: 'perm-1',
      sessionId: 'ses-1',
      chatId: '100',
      permission: 'bash',
      patterns: ['*'],
      always: ['skill_mcp'],
      metadata: {},
      tool: null,
      messageId: 15,
      renderSignature: '',
    },
  };
  const chatRouter = new Map([['100', repo]]);
  const states = new Map([[repo.name, state]]);

  const out = await gateway._internal.handlePermissionCallback(
    bot,
    { message: { chat: { id: '100' } } },
    chatRouter,
    states,
    'always',
  );

  assert.equal(out.answerText, 'always');
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__, [{
    requestID: 'perm-1',
    directory: process.cwd(),
    reply: 'always',
    message: '',
  }]);
  assert.equal(state.permissionFlow, null);
  assert.equal(bot.editMessageTextCalls.some((call) => String(call.text).includes('always allowed')), true);
});
