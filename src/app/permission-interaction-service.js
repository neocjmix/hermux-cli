'use strict';

function toText(value) {
  return String(value == null ? '' : value);
}

function normalizePermissionRequest(request, chatId) {
  const raw = request && typeof request === 'object' ? request : {};
  const tool = raw.tool && typeof raw.tool === 'object' ? raw.tool : null;
  return {
    requestId: toText(raw.requestId || raw.requestID || raw.id).trim(),
    sessionId: toText(raw.sessionId || raw.sessionID).trim(),
    chatId: toText(chatId).trim(),
    permission: toText(raw.permission).trim(),
    patterns: Array.isArray(raw.patterns) ? raw.patterns.map((v) => toText(v).trim()).filter(Boolean) : [],
    always: Array.isArray(raw.always) ? raw.always.map((v) => toText(v).trim()).filter(Boolean) : [],
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {},
    tool: tool ? {
      messageId: toText(tool.messageId || tool.messageID).trim(),
      callId: toText(tool.callId || tool.callID).trim(),
    } : null,
  };
}

function createPermissionFlow(request, chatId) {
  const normalized = normalizePermissionRequest(request, chatId);
  return {
    requestId: normalized.requestId,
    sessionId: normalized.sessionId,
    chatId: normalized.chatId,
    permission: normalized.permission,
    patterns: normalized.patterns,
    always: normalized.always,
    metadata: normalized.metadata,
    tool: normalized.tool,
    messageId: 0,
    renderSignature: '',
  };
}

function syncPermissionFlow(flow, request, chatId) {
  const normalized = normalizePermissionRequest(request, chatId);
  if (!normalized.requestId || !normalized.permission) return null;
  if (!flow || flow.requestId !== normalized.requestId) {
    return createPermissionFlow(normalized, chatId);
  }
  return {
    ...flow,
    sessionId: normalized.sessionId,
    chatId: normalized.chatId,
    permission: normalized.permission,
    patterns: normalized.patterns,
    always: normalized.always,
    metadata: normalized.metadata,
    tool: normalized.tool,
  };
}

function buildPermissionMessage(flow) {
  if (!flow) return '';
  const lines = [];
  lines.push(`Permission: ${toText(flow.permission).trim() || 'approval required'}`);
  if (flow.tool && (flow.tool.callId || flow.tool.messageId)) {
    const refs = [flow.tool.callId ? `call ${flow.tool.callId}` : '', flow.tool.messageId ? `message ${flow.tool.messageId}` : '']
      .filter(Boolean)
      .join(' · ');
    if (refs) {
      lines.push('');
      lines.push(`Source: ${refs}`);
    }
  }
  if (Array.isArray(flow.patterns) && flow.patterns.length > 0) {
    lines.push('');
    lines.push(`Patterns: ${flow.patterns.join(', ')}`);
  }
  if (Array.isArray(flow.always) && flow.always.length > 0) {
    lines.push('');
    lines.push(`Always scope: ${flow.always.join(', ')}`);
  }
  return lines.join('\n');
}

function buildPermissionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Allow once', callback_data: 'p:o' }],
      [{ text: 'Always allow', callback_data: 'p:a' }],
      [{ text: 'Reject', callback_data: 'p:x' }],
    ],
  };
}

function buildPermissionRenderSignature(flow) {
  return JSON.stringify({ text: buildPermissionMessage(flow), keyboard: buildPermissionKeyboard(flow) });
}

module.exports = {
  createPermissionFlow,
  syncPermissionFlow,
  buildPermissionMessage,
  buildPermissionKeyboard,
  buildPermissionRenderSignature,
};
