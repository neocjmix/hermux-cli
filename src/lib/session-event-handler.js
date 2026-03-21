// @ts-check
'use strict';

const { routeEventBySession } = require('./event-router');

/**
 * @typedef {Object} SessionEventResult
 * @property {boolean} handled
 * @property {string} nextSessionId
 * @property {boolean} delivered
 * @property {string} dropReason
 */

async function runChain(steps, initialContext) {
  let ctx = initialContext;
  for (let i = 0; i < steps.length; i++) {
    ctx = await steps[i](ctx);
    if (ctx && ctx.handled) break;
  }
  return ctx;
}

function createSessionEventHandler({ deliverPayload, onDeliver }) {
  if (typeof deliverPayload !== 'function') {
    throw new Error('deliverPayload is required');
  }

  const steps = [
    async (ctx) => {
      const routed = routeEventBySession({
        event: ctx.event,
        activeSessionId: ctx.activeSessionId,
      });
      return {
        ...ctx,
        routed,
        nextSessionId: routed.sessionId || ctx.activeSessionId,
      };
    },
    async (ctx) => {
      if (!ctx.routed || !ctx.routed.deliver) {
        return {
          ...ctx,
          delivered: false,
          dropReason: String((ctx.routed && ctx.routed.reason) || 'router_rejected'),
          handled: true,
        };
      }
      return ctx;
    },
    async (ctx) => {
      if (typeof onDeliver === 'function') {
        await onDeliver({
          payload: ctx.routed.payload,
          sessionId: ctx.routed.sessionId || ctx.nextSessionId || '',
          event: ctx.event,
        });
      }
      await deliverPayload(ctx.routed.payload, 'raw_event');
      return {
        ...ctx,
        delivered: true,
        dropReason: '',
        handled: true,
      };
    },
  ];

  return async function handleSessionEvent({ event, activeSessionId }) {
    const result = await runChain(steps, {
      event,
      activeSessionId: String(activeSessionId || ''),
      routed: null,
      nextSessionId: String(activeSessionId || ''),
      delivered: false,
      dropReason: '',
      handled: false,
    });

    return {
      handled: !!(result && result.handled),
      nextSessionId: String((result && result.nextSessionId) || ''),
      delivered: !!(result && result.delivered),
      dropReason: String((result && result.dropReason) || ''),
    };
  };
}

module.exports = {
  createSessionEventHandler,
};
