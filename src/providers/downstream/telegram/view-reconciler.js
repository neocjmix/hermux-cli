'use strict';

// Skeleton: downstream telegram view reconciler
// See docs/REBUILD_CONTRACTS.md § 3 (RunViewSnapshot boundary)
// Contract: consumes RunViewSnapshot ONLY, never raw upstream events

function buildRunViewReconcileCommands(params) { throw new Error('NOT_IMPLEMENTED: buildRunViewReconcileCommands'); }
function expandRunViewTextsToTelegramSlots(params) { throw new Error('NOT_IMPLEMENTED: expandRunViewTextsToTelegramSlots'); }
function shouldEagerlyMaterializeTail(params) { throw new Error('NOT_IMPLEMENTED: shouldEagerlyMaterializeTail'); }

async function reconcileRunViewForTelegram(params) {
  throw new Error('NOT_IMPLEMENTED: reconcileRunViewForTelegram');
}

module.exports = {
  reconcileRunViewForTelegram,
  _internal: {
    buildRunViewReconcileCommands,
    expandRunViewTextsToTelegramSlots,
    shouldEagerlyMaterializeTail,
  },
};
