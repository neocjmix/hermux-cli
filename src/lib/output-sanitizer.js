'use strict';

const OMO_MARKER_REGEX = /(?:<!--\s*OMO_INTERNAL_INITIATOR\s*-->|&lt;!--\s*OMO_INTERNAL_INITIATOR\s*--&gt;)/gi;
const SYSTEM_REMINDER_REGEX = /(?:<system-reminder>|&lt;system-reminder&gt;)([\s\S]*?)(?:<\/system-reminder>|&lt;\/system-reminder&gt;)/gi;
const INTERNAL_LINE_PATTERNS = [
  /^\[BACKGROUND TASK COMPLETED\]$/i,
  /^\[ALL BACKGROUND TASKS COMPLETE\]$/i,
  /^\[SYSTEM DIRECTIVE:.*TODO CONTINUATION.*\]$/i,
  /^\*\*ID:\*\*/i,
  /^\*\*Description:\*\*/i,
  /^\*\*Duration:\*\*/i,
  /^\*\*\d+ tasks? still in progress\.\*\*/i,
  /^Do NOT poll - continue productive work\.$/i,
  /^Use `background_output\(task_id=.*\)` to retrieve this result when ready\.$/i,
  /^Use `background_output\(task_id=.*\)` to retrieve each result\.$/i,
];
const INTERNAL_HANDOFF_MARKERS = [
  'the current immediate goal at the time of compaction',
  '## discoveries',
  'next agent should check',
  'the latest visual requirement',
  'outstanding:',
];

function splitByOmoInitiatorMarker(text) {
  const src = String(text || '');
  if (!src) return [];
  return src
    .split(OMO_MARKER_REGEX)
    .map((part) => String(part || '').trim())
    .filter(Boolean);
}

function extractLatestSystemReminder(text) {
  const src = String(text || '');
  if (!src) return { text: '', reminderText: '' };
  let latest = '';
  const stripped = src.replace(SYSTEM_REMINDER_REGEX, (_m, body) => {
    latest = String(body || '').trim();
    return '';
  }).trim();
  return {
    text: stripped,
    reminderText: latest,
  };
}

function stripInternalControlLines(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  if (!src) return '';
  const lines = src.split('\n');
  const wrapperContext = lines.some((line) => {
    const trimmed = String(line || '').trim();
    return trimmed && INTERNAL_LINE_PATTERNS.slice(0, 3).some((pattern) => pattern.test(trimmed));
  });
  if (!wrapperContext) return src;
  const kept = [];
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (trimmed && INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function isLikelyInternalHandoffEcho(text) {
  const src = String(text || '').trim().toLowerCase();
  if (!src) return false;
  let hits = 0;
  for (const marker of INTERNAL_HANDOFF_MARKERS) {
    if (src.includes(marker)) hits += 1;
  }
  return hits >= 3 || (src.includes(INTERNAL_HANDOFF_MARKERS[0]) && hits >= 2);
}

function stripInternalOutputArtifacts(text) {
  const withoutMarkers = String(text || '').replace(OMO_MARKER_REGEX, '\n');
  const extracted = extractLatestSystemReminder(withoutMarkers);
  const strippedControls = stripInternalControlLines(extracted.text);
  const normalized = strippedControls
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text: isLikelyInternalHandoffEcho(normalized) ? '' : normalized,
    reminderText: extracted.reminderText,
  };
}

function sanitizeCanonicalOutputText(text, _promptText) {
  return stripInternalOutputArtifacts(text).text;
}

function sanitizeDisplayOutputText(text) {
  return stripInternalOutputArtifacts(text).text;
}

function sanitizeWithoutPromptEchoStrip(text) {
  return stripInternalOutputArtifacts(text).text;
}

function sanitizeFinalOutputText(text, promptText) {
  return sanitizeCanonicalOutputText(text, promptText);
}

module.exports = {
  splitByOmoInitiatorMarker,
  extractLatestSystemReminder,
  stripInternalOutputArtifacts,
  sanitizeCanonicalOutputText,
  sanitizeDisplayOutputText,
  sanitizeWithoutPromptEchoStrip,
  sanitizeFinalOutputText,
};
