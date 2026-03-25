'use strict';

function toText(value) {
  return String(value == null ? '' : value);
}

function truncateButtonText(value, maxLen) {
  const limit = Number(maxLen || 0) || 60;
  const text = toText(value).trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 3))}...`;
}

function normalizeQuestionOption(option) {
  const raw = option && typeof option === 'object' ? option : {};
  const label = toText(raw.label).trim();
  const description = toText(raw.description).trim();
  if (!label && !description) return null;
  return { label, description };
}

function normalizeQuestion(question) {
  const raw = question && typeof question === 'object' ? question : {};
  const header = toText(raw.header).trim();
  const prompt = toText(raw.question).trim();
  const options = Array.isArray(raw.options)
    ? raw.options.map(normalizeQuestionOption).filter(Boolean)
    : [];
  if (!header && !prompt && options.length === 0) return null;
  return {
    header,
    question: prompt,
    options,
    multiple: !!raw.multiple,
    custom: raw.custom !== false,
  };
}

function normalizeQuestionRequest(request, chatId) {
  const raw = request && typeof request === 'object' ? request : {};
  const questions = Array.isArray(raw.questions)
    ? raw.questions.map(normalizeQuestion).filter(Boolean)
    : [];
  return {
    requestId: toText(raw.requestId || raw.requestID || raw.id).trim(),
    sessionId: toText(raw.sessionId || raw.sessionID).trim(),
    chatId: toText(chatId).trim(),
    questions,
  };
}

function cloneSelections(flow) {
  const source = flow && flow.selectedOptionIndexes && typeof flow.selectedOptionIndexes === 'object'
    ? flow.selectedOptionIndexes
    : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = Array.isArray(value) ? value.slice() : [];
  }
  return out;
}

function cloneCustomAnswers(flow) {
  const source = flow && flow.customAnswers && typeof flow.customAnswers === 'object'
    ? flow.customAnswers
    : {};
  return { ...source };
}

function createQuestionFlow(request, chatId) {
  const normalized = normalizeQuestionRequest(request, chatId);
  return {
    requestId: normalized.requestId,
    sessionId: normalized.sessionId,
    chatId: normalized.chatId,
    questions: normalized.questions,
    currentIndex: 0,
    selectedOptionIndexes: {},
    customAnswers: {},
    waitingForCustomInput: false,
    messageId: 0,
    renderSignature: '',
  };
}

function syncQuestionFlow(flow, request, chatId) {
  const normalized = normalizeQuestionRequest(request, chatId);
  if (!normalized.requestId || normalized.questions.length === 0) return null;
  if (!flow || flow.requestId !== normalized.requestId) {
    return createQuestionFlow(normalized, chatId);
  }
  return {
    ...flow,
    sessionId: normalized.sessionId,
    chatId: normalized.chatId,
    questions: normalized.questions,
    selectedOptionIndexes: cloneSelections(flow),
    customAnswers: cloneCustomAnswers(flow),
  };
}

function getCurrentQuestion(flow) {
  if (!flow || !Array.isArray(flow.questions)) return null;
  const idx = Number(flow.currentIndex || 0) || 0;
  return flow.questions[idx] || null;
}

function getSelectedOptionIndexes(flow, questionIndex) {
  if (!flow || !flow.selectedOptionIndexes) return [];
  const out = flow.selectedOptionIndexes[String(questionIndex)];
  return Array.isArray(out) ? out.slice() : [];
}

function setSelectedOptionIndexes(flow, questionIndex, indexes) {
  return {
    ...flow,
    selectedOptionIndexes: {
      ...cloneSelections(flow),
      [String(questionIndex)]: Array.isArray(indexes) ? indexes.slice() : [],
    },
    waitingForCustomInput: false,
    renderSignature: '',
  };
}

function toggleQuestionOption(flow, optionIndex) {
  const question = getCurrentQuestion(flow);
  const questionIndex = Number(flow && flow.currentIndex ? flow.currentIndex : 0) || 0;
  if (!question) return flow;
  const options = Array.isArray(question.options) ? question.options : [];
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) return flow;
  const selected = getSelectedOptionIndexes(flow, questionIndex);
  if (question.multiple) {
    const next = selected.includes(optionIndex)
      ? selected.filter((idx) => idx !== optionIndex)
      : selected.concat(optionIndex).sort((a, b) => a - b);
    return setSelectedOptionIndexes(flow, questionIndex, next);
  }
  return setSelectedOptionIndexes(flow, questionIndex, [optionIndex]);
}

function startCustomInput(flow) {
  return {
    ...flow,
    waitingForCustomInput: true,
    renderSignature: '',
  };
}

function setCustomAnswer(flow, answer) {
  const questionIndex = Number(flow && flow.currentIndex ? flow.currentIndex : 0) || 0;
  return {
    ...flow,
    customAnswers: {
      ...cloneCustomAnswers(flow),
      [String(questionIndex)]: toText(answer).trim(),
    },
    waitingForCustomInput: false,
    renderSignature: '',
  };
}

function clearCustomAnswer(flow, questionIndex) {
  const next = cloneCustomAnswers(flow);
  delete next[String(questionIndex)];
  return {
    ...flow,
    customAnswers: next,
    renderSignature: '',
  };
}

function advanceQuestion(flow) {
  return {
    ...flow,
    currentIndex: (Number(flow && flow.currentIndex ? flow.currentIndex : 0) || 0) + 1,
    waitingForCustomInput: false,
    messageId: Number(flow && flow.messageId ? flow.messageId : 0) || 0,
    renderSignature: '',
  };
}

function hasNextQuestion(flow) {
  const idx = Number(flow && flow.currentIndex ? flow.currentIndex : 0) || 0;
  const total = Array.isArray(flow && flow.questions) ? flow.questions.length : 0;
  return idx + 1 < total;
}

function canSubmitCurrentQuestion(flow) {
  const question = getCurrentQuestion(flow);
  if (!question) return false;
  const questionIndex = Number(flow && flow.currentIndex ? flow.currentIndex : 0) || 0;
  const custom = toText(flow && flow.customAnswers && flow.customAnswers[String(questionIndex)]).trim();
  if (custom) return true;
  const selected = getSelectedOptionIndexes(flow, questionIndex);
  return selected.length > 0;
}

function collectQuestionAnswers(flow) {
  const out = [];
  const total = Array.isArray(flow && flow.questions) ? flow.questions.length : 0;
  for (let i = 0; i < total; i += 1) {
    const custom = toText(flow && flow.customAnswers && flow.customAnswers[String(i)]).trim();
    if (custom) {
      out.push([custom]);
      continue;
    }
    const question = flow.questions[i] || {};
    const options = Array.isArray(question.options) ? question.options : [];
    const selected = getSelectedOptionIndexes(flow, i)
      .map((idx) => options[idx])
      .filter(Boolean)
      .map((opt) => toText(opt.label).trim())
      .filter(Boolean);
    out.push(selected);
  }
  return out;
}

function buildQuestionMessage(flow) {
  const question = getCurrentQuestion(flow);
  if (!question) return '';
  const currentIndex = Number(flow && flow.currentIndex ? flow.currentIndex : 0) || 0;
  const total = Array.isArray(flow && flow.questions) ? flow.questions.length : 0;
  const lines = [];
  const title = [total > 0 ? `${currentIndex + 1}/${total}` : '', toText(question.header).trim() || 'Question']
    .filter(Boolean)
    .join(' · ');
  lines.push(`Question: ${title}`);
  lines.push('');
  lines.push(toText(question.question).trim());
  if (question.multiple) {
    lines.push('');
    lines.push('Select one or more options, then press Submit.');
  }
  if (flow && flow.waitingForCustomInput) {
    lines.push('');
    lines.push('Send your custom answer as a normal chat message now.');
  }
  const custom = toText(flow && flow.customAnswers && flow.customAnswers[String(currentIndex)]).trim();
  if (custom) {
    lines.push('');
    lines.push(`Custom answer: ${custom}`);
  }
  return lines.join('\n');
}

function buildQuestionKeyboard(flow) {
  const question = getCurrentQuestion(flow);
  if (!question) return null;
  const selected = new Set(getSelectedOptionIndexes(flow, Number(flow.currentIndex || 0) || 0));
  const rows = [];
  const options = Array.isArray(question.options) ? question.options : [];
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i] || {};
    const prefix = selected.has(i) ? '✅ ' : '';
    const text = truncateButtonText(`${prefix}${toText(option.label).trim()}${option.description ? ` - ${toText(option.description).trim()}` : ''}`, 58);
    rows.push([{ text, callback_data: `q:s:${Number(flow.currentIndex || 0) || 0}:${i}` }]);
  }
  if (question.multiple) {
    rows.push([{ text: 'Submit', callback_data: `q:u:${Number(flow.currentIndex || 0) || 0}` }]);
  }
  if (question.custom !== false) {
    rows.push([{ text: 'Type your own answer', callback_data: `q:c:${Number(flow.currentIndex || 0) || 0}` }]);
  }
  rows.push([{ text: 'Cancel', callback_data: `q:x:${Number(flow.currentIndex || 0) || 0}` }]);
  return { inline_keyboard: rows };
}

function buildQuestionRenderSignature(flow) {
  const text = buildQuestionMessage(flow);
  const keyboard = buildQuestionKeyboard(flow);
  return JSON.stringify({ text, keyboard });
}

function summarizeQuestionAnswers(flow) {
  const answers = collectQuestionAnswers(flow);
  const lines = ['Sent answers:'];
  for (let i = 0; i < answers.length; i += 1) {
    const question = flow.questions[i] || {};
    const prompt = toText(question.question).trim() || `Question ${i + 1}`;
    const answer = answers[i] && answers[i].length > 0 ? answers[i].join(', ') : '(no answer)';
    lines.push(`${i + 1}. ${prompt}`);
    lines.push(`   -> ${answer}`);
  }
  return lines.join('\n');
}

module.exports = {
  createQuestionFlow,
  syncQuestionFlow,
  getCurrentQuestion,
  getSelectedOptionIndexes,
  toggleQuestionOption,
  startCustomInput,
  setCustomAnswer,
  clearCustomAnswer,
  advanceQuestion,
  hasNextQuestion,
  canSubmitCurrentQuestion,
  collectQuestionAnswers,
  buildQuestionMessage,
  buildQuestionKeyboard,
  buildQuestionRenderSignature,
  summarizeQuestionAnswers,
};
