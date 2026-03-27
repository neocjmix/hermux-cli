'use strict';

const runner = require('./runner');
const renderState = require('./render-state');
const runViewSnapshot = require('./run-view-snapshot');
const payloadIntrospection = require('./payload-introspection');

function createUpstreamAdapter() {
  return Object.freeze({
    id: 'opencode',
    capabilities: () => ({
      supportsSessionResume: true,
      supportsRevert: true,
      supportsUnrevert: true,
      cancelScopes: ['run', 'repo'],
    }),
    runtime: Object.freeze({
      runOpencode: runner.runOpencode,
      subscribeSessionEvents: runner.subscribeSessionEvents,
      endSessionLifecycle: runner.endSessionLifecycle,
      runSessionRevert: runner.runSessionRevert,
      runSessionUnrevert: runner.runSessionUnrevert,
      runPermissionReply: runner.runPermissionReply,
      runQuestionReply: runner.runQuestionReply,
      runQuestionReject: runner.runQuestionReject,
      stopAllRuntimeExecutors: runner.stopAllRuntimeExecutors,
      getRuntimeStatusForInstance: runner.getRuntimeStatusForInstance,
    }),
    render: Object.freeze({
      createRunViewSnapshotState: runViewSnapshot.createRunViewSnapshotState,
      applyPayloadToRunViewSnapshot: runViewSnapshot.applyPayloadToRunViewSnapshot,
      inspectRunViewSnapshotState: runViewSnapshot.inspectRunViewSnapshotState,
      formatPayloadPreview: payloadIntrospection.formatPayloadPreview,
      parsePayloadMeta: payloadIntrospection.parsePayloadMeta,
      rankPayloadPriority: payloadIntrospection.rankPayloadPriority,
      readAssistantLifecycleEvent: payloadIntrospection.readAssistantLifecycleEvent,
      readBusySignalFromSessionPayload: payloadIntrospection.readBusySignalFromSessionPayload,
    }),
  });
}

module.exports = {
  createUpstreamAdapter,
};
