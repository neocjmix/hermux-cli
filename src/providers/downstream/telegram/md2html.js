'use strict';

// Skeleton: downstream telegram markdown-to-html converter
// Relocated from src/lib/md2html.js per BOUNDARY_AUDIT #2
// This module is Telegram-specific (tg-spoiler, tg:// protocol)

/** @param {string} s */
function escapeHtml(s) {
  throw new Error('NOT_IMPLEMENTED: escapeHtml');
}

/** @param {string} md */
function md2html(md) {
  throw new Error('NOT_IMPLEMENTED: md2html');
}

module.exports = { md2html, escapeHtml };
