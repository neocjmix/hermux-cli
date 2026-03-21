// @ts-check
'use strict';

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitByOmoInitiatorMarker(text) {
  const src = String(text || '');
  if (!src) return [];
  return src
    .split(/(?:<!--\s*OMO_INTERNAL_INITIATOR\s*-->|&lt;!--\s*OMO_INTERNAL_INITIATOR\s*--&gt;)/gi)
    .map((part) => String(part || '').trim())
    .filter(Boolean);
}

function extractLatestSystemReminder(text) {
  const src = String(text || '');
  if (!src) return { text: '', reminderText: '' };
  const regex = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
  let latest = '';
  const stripped = src.replace(regex, (_m, body) => {
    latest = String(body || '').trim();
    return '';
  }).trim();
  return {
    text: stripped,
    reminderText: latest,
  };
}

function sanitizeCanonicalOutputText(text, _promptText) {
  return String(text || '').trim();
}

function sanitizeDisplayOutputText(text) {
  return String(text || '').trim();
}

function sanitizeWithoutPromptEchoStrip(text) {
  return String(text || '').trim();
}

function sanitizeFinalOutputText(text, promptText) {
  return sanitizeCanonicalOutputText(text, promptText);
}

module.exports = {
  splitByOmoInitiatorMarker,
  extractLatestSystemReminder,
  sanitizeCanonicalOutputText,
  sanitizeDisplayOutputText,
  sanitizeWithoutPromptEchoStrip,
  sanitizeFinalOutputText,
};
