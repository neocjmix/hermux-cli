'use strict';

// Skeleton: downstream telegram html chunker
// BOUNDARY: This is channel-specific. Core MUST NOT import (BOUNDARY_AUDIT #1).

function splitTelegramHtml(html, maxLen) {
  throw new Error('NOT_IMPLEMENTED: splitTelegramHtml');
}

function decodeHtmlEntity(entity) { throw new Error('NOT_IMPLEMENTED: decodeHtmlEntity'); }
function splitTextToken(text, maxLen) { throw new Error('NOT_IMPLEMENTED: splitTextToken'); }
function tokenizeHtml(html) { throw new Error('NOT_IMPLEMENTED: tokenizeHtml'); }

module.exports = {
  splitTelegramHtml,
  _internal: {
    decodeHtmlEntity,
    splitTextToken,
    tokenizeHtml,
  },
};
