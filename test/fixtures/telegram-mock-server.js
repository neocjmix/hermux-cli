'use strict';

const http = require('node:http');
const { URL } = require('node:url');

function parseJsonSafe(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function createTokenState() {
  return {
    updates: [],
    nextUpdateId: 1,
    nextMessageId: 1,
    webhook: null,
  };
}

function createTelegramMockServer() {
  const tokenStates = new Map();
  const requests = [];
  const scenarios = [];
  let nextRequestId = 1;

  function getState(token) {
    if (!tokenStates.has(token)) tokenStates.set(token, createTokenState());
    return tokenStates.get(token);
  }

  function json(res, statusCode, body) {
    const raw = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(raw),
    });
    res.end(raw);
  }

  function takeScenario(method, params) {
    for (const scenario of scenarios) {
      if (String(scenario.method || '').toLowerCase() !== String(method || '').toLowerCase()) continue;
      if (scenario.match && typeof scenario.match === 'object') {
        let matched = true;
        for (const [k, v] of Object.entries(scenario.match)) {
          if (params[k] !== v) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
      }
      if (typeof scenario.times === 'number') {
        scenario.times -= 1;
      }
      return scenario;
    }
    return null;
  }

  function cleanupScenarios() {
    for (let i = scenarios.length - 1; i >= 0; i -= 1) {
      if (typeof scenarios[i].times === 'number' && scenarios[i].times <= 0) {
        scenarios.splice(i, 1);
      }
    }
  }

  function buildMethodResult(state, method, params) {
    if (method === 'getUpdates') {
      if (state.webhook && state.webhook.url) {
        return {
          ok: false,
          error_code: 409,
          description: "Conflict: can't use getUpdates method while webhook is active",
        };
      }
      const offset = Number(params.offset || 0) || 0;
      const selected = state.updates.filter((u) => Number(u.update_id || 0) >= offset);
      if (selected.length > 0) {
        const maxId = Math.max(...selected.map((u) => Number(u.update_id || 0) || 0));
        state.updates = state.updates.filter((u) => Number(u.update_id || 0) > maxId);
      }
      return selected;
    }

    if (method === 'setWebhook') {
      state.webhook = {
        url: String(params.url || ''),
        secret_token: String(params.secret_token || ''),
        allowed_updates: Array.isArray(params.allowed_updates) ? params.allowed_updates : [],
        max_connections: Number(params.max_connections || 40) || 40,
      };
      return true;
    }

    if (method === 'getWebhookInfo') {
      const wh = state.webhook || { url: '' };
      return {
        url: String(wh.url || ''),
        has_custom_certificate: false,
        pending_update_count: state.updates.length,
        max_connections: Number(wh.max_connections || 40) || 40,
        allowed_updates: Array.isArray(wh.allowed_updates) ? wh.allowed_updates : [],
      };
    }

    if (method === 'deleteWebhook') {
      state.webhook = null;
      return true;
    }

    if (method === 'answerCallbackQuery') {
      return true;
    }

    if (method === 'setMyCommands') {
      return true;
    }

    if (method === 'deleteMessage') {
      return true;
    }

    if (method === 'sendMessage' || method === 'editMessageText') {
      const chatId = Number(params.chat_id || params.chatId || 0) || 0;
      const text = String(params.text || '');
      return {
        message_id: state.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        text,
        chat: {
          id: chatId,
          type: 'private',
        },
      };
    }

    if (method === 'sendPhoto' || method === 'sendDocument') {
      const chatId = Number(params.chat_id || params.chatId || 0) || 0;
      return {
        message_id: state.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
      };
    }

    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/__control/health') {
      return json(res, 200, { ok: true });
    }

    if (pathname === '/__control/requests' && req.method === 'GET') {
      const method = String(url.searchParams.get('method') || '').trim().toLowerCase();
      const filtered = method
        ? requests.filter((r) => String(r.method || '').toLowerCase() === method)
        : requests;
      return json(res, 200, { requests: filtered });
    }

    if (pathname === '/__control/requests' && req.method === 'DELETE') {
      requests.length = 0;
      return json(res, 200, { ok: true });
    }

    if (pathname === '/__control/scenarios' && req.method === 'GET') {
      return json(res, 200, { scenarios });
    }

    if (pathname === '/__control/scenarios' && req.method === 'DELETE') {
      scenarios.length = 0;
      return json(res, 200, { ok: true });
    }

    if (pathname === '/__control/scenarios' && req.method === 'POST') {
      const raw = await readRequestBody(req);
      const body = parseJsonSafe(raw, {});
      scenarios.push({
        method: String(body.method || ''),
        match: body.match && typeof body.match === 'object' ? body.match : null,
        times: Number.isFinite(Number(body.times)) ? Number(body.times) : null,
        response: body.response && typeof body.response === 'object' ? body.response : null,
        response_data: body.response_data && typeof body.response_data === 'object' ? body.response_data : null,
      });
      return json(res, 200, { ok: true, count: scenarios.length });
    }

    if (pathname === '/__control/updates' && req.method === 'POST') {
      const raw = await readRequestBody(req);
      const body = parseJsonSafe(raw, {});
      const token = String(body.token || 'test-token').trim() || 'test-token';
      const state = getState(token);
      const update = body.update && typeof body.update === 'object' ? body.update : body;
      if (!update.update_id) {
        update.update_id = state.nextUpdateId++;
      }
      state.updates.push(update);
      return json(res, 200, { ok: true, token, update_id: update.update_id });
    }

    const match = pathname.match(/^\/bot([^/]+)\/([^/]+)$/);
    if (!match) {
      return json(res, 404, { ok: false, description: 'Not found' });
    }

    const token = decodeURIComponent(match[1]);
    const method = decodeURIComponent(match[2]);
    const state = getState(token);

    let params = {};
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (req.method === 'GET') {
      for (const [k, v] of url.searchParams.entries()) params[k] = v;
    } else {
      const raw = await readRequestBody(req);
      if (contentType.includes('application/json')) {
        params = parseJsonSafe(raw, {});
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const qs = new URLSearchParams(raw);
        for (const [k, v] of qs.entries()) params[k] = v;
      } else {
        params = { raw };
      }
    }

    const scenario = takeScenario(method, params);
    let payload;

    if (scenario && scenario.response) {
      payload = {
        ok: false,
        ...scenario.response,
      };
    } else {
      const result = buildMethodResult(state, method, params);
      if (result && result.ok === false) {
        payload = result;
      } else {
        payload = { ok: true, result };
        if (scenario && scenario.response_data && payload.result && typeof payload.result === 'object') {
          payload.result = { ...payload.result, ...scenario.response_data };
        }
      }
    }

    requests.push({
      id: nextRequestId++,
      timestamp: new Date().toISOString(),
      token,
      method,
      params,
      scenario: scenario ? { method: scenario.method, match: scenario.match, times: scenario.times } : null,
      response: payload,
    });

    cleanupScenarios();
    return json(res, 200, payload);
  });

  async function start(port = 0) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const addr = server.address();
    return {
      host: '127.0.0.1',
      port: addr.port,
      baseApiUrl: `http://127.0.0.1:${addr.port}`,
      controlUrl: `http://127.0.0.1:${addr.port}/__control`,
    };
  }

  async function stop() {
    if (!server.listening) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    start,
    stop,
  };
}

module.exports = {
  createTelegramMockServer,
};
