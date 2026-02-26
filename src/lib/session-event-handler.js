'use strict';

const { routeEventBySession } = require('./event-router');

async function runChain(steps, initialContext) {
  let ctx = initialContext;
  for (let i = 0; i < steps.length; i++) {
    ctx = await steps[i](ctx);
    if (ctx && ctx.handled) break;
  }
  return ctx;
}

function createSessionEventHandler({ sendRawTelegram }) {
  if (typeof sendRawTelegram !== 'function') {
    throw new Error('sendRawTelegram is required');
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
          handled: true,
        };
      }
      return ctx;
    },
    async (ctx) => {
      await sendRawTelegram(ctx.routed.payload, 'raw_event');
      return {
        ...ctx,
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
      handled: false,
    });

    return {
      handled: !!(result && result.handled),
      nextSessionId: String((result && result.nextSessionId) || ''),
    };
  };
}

module.exports = {
  createSessionEventHandler,
};
