#!/usr/bin/env node
'use strict';

const http = require('http');

const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '--port') {
    port = Number(args[i + 1]);
  }
}
if (!Number.isFinite(port) || port <= 0) {
  const index = args.indexOf('--port');
  port = index >= 0 && Number.isFinite(Number(args[index + 1])) ? Number(args[index + 1]) : 0;
}
if (!Number.isFinite(port) || port <= 0) process.exit(1);

const sessionId = 'serve-session';
const sseClients = [];

function sendSse(payload) {
  const packet = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(packet);
    } catch (_err) {
      // best effort
    }
  }
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  if (url === '/doc' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url === '/session' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: sessionId }));
    return;
  }
  if (url === '/session' && method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: sessionId }));
    return;
  }

  if (url === `/session/${sessionId}` && method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: sessionId }));
    return;
  }

  if (url === `/session/${sessionId}/prompt_async` && method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      sendSse({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'busy' } },
      });

      sendSse({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'b',
          partIndex: 2,
          type: 'text',
          field: 'text',
          delta: 'second segment',
        },
      });
      sendSse({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'a',
          partIndex: 1,
          type: 'text',
          field: 'text',
          delta: 'first segment',
        },
      });
      sendSse({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'b',
            sessionID: sessionId,
            index: 2,
            type: 'text',
            text: '',
          },
        },
      });
      sendSse({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'a',
            sessionID: sessionId,
            index: 1,
            type: 'text',
            text: '',
          },
        },
      });
      sendSse({
        type: 'session.idle',
        properties: { sessionID: sessionId },
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url === '/event' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('');
    sseClients.push(res);
    return;
  }

  if (url.startsWith('/session/') && url.endsWith('/abort') && method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '127.0.0.1');
process.stdout.write(`serve fixture ready on ${port}
`);
