'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createQuestionFlow,
  toggleQuestionOption,
  startCustomInput,
  setCustomAnswer,
  buildQuestionKeyboard,
  buildQuestionMessage,
  collectQuestionAnswers,
} = require('../src/app/question-interaction-service');

test('question interaction service builds single-choice keyboard and answers payload', () => {
  let flow = createQuestionFlow({
    id: 'req-1',
    sessionID: 'ses-1',
    questions: [{
      header: 'Need input',
      question: 'How should I continue?',
      options: [
        { label: 'Ship now', description: 'continue immediately' },
        { label: 'Wait', description: 'pause for review' },
      ],
    }],
  }, '100');

  flow = toggleQuestionOption(flow, 1);
  const keyboard = buildQuestionKeyboard(flow);
  const text = buildQuestionMessage(flow);

  assert.equal(keyboard.inline_keyboard[1][0].text.includes('✅ Wait'), true);
  assert.match(text, /How should I continue\?/);
  assert.deepEqual(collectQuestionAnswers(flow), [['Wait']]);
});

test('question interaction service keeps multi-select answers and custom answer override', () => {
  let flow = createQuestionFlow({
    id: 'req-2',
    sessionID: 'ses-2',
    questions: [{
      header: 'Pick options',
      question: 'Choose everything that applies',
      multiple: true,
      options: [
        { label: 'TypeScript', description: 'static types' },
        { label: 'Zod', description: 'runtime validation' },
      ],
    }],
  }, '100');

  flow = toggleQuestionOption(flow, 0);
  flow = toggleQuestionOption(flow, 1);
  assert.deepEqual(collectQuestionAnswers(flow), [['TypeScript', 'Zod']]);

  flow = startCustomInput(flow);
  flow = setCustomAnswer(flow, 'Use Telegram callback');
  assert.match(buildQuestionMessage(flow), /Custom answer: Use Telegram callback/);
  assert.deepEqual(collectQuestionAnswers(flow), [['Use Telegram callback']]);
});
