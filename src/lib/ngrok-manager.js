'use strict';

const net = require('net');
const ngrok = require('@ngrok/ngrok');

const tunnelsByScope = new Map();

function normalizeScopeKey(scopeKey) {
  return String(scopeKey || '').trim();
}

function normalizePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return 0;
  return value;
}

function maskUrl(url) {
  return String(url || '').trim();
}

function toPublicTunnel(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    scopeKey: normalizeScopeKey(record.scopeKey),
    port: normalizePort(record.port),
    url: maskUrl(record.url),
    startedAt: String(record.startedAt || ''),
  };
}

async function ensurePortReachable(port, host = '127.0.0.1', timeoutMs = 1500) {
  const normalizedPort = normalizePort(port);
  if (!normalizedPort) throw new Error('invalid_port');
  await new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host, port: normalizedPort });
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error('local_port_timeout')));
    socket.once('error', () => finish(new Error('local_port_unreachable')));
  });
}

async function closeTunnel(scopeKey) {
  const key = normalizeScopeKey(scopeKey);
  if (!key) throw new Error('missing_scope_key');
  const current = tunnelsByScope.get(key);
  if (!current) return { closed: false, tunnel: null };
  tunnelsByScope.delete(key);
  try {
    await current.listener.close();
  } catch (_err) {
  }
  return { closed: true, tunnel: toPublicTunnel(current) };
}

async function openTunnel(input) {
  const options = input && typeof input === 'object' ? input : {};
  const scopeKey = normalizeScopeKey(options.scopeKey);
  const port = normalizePort(options.port);
  const authtoken = String(options.authtoken || '').trim();
  if (!scopeKey) throw new Error('missing_scope_key');
  if (!port) throw new Error('invalid_port');
  if (!authtoken) throw new Error('missing_authtoken');

  const current = tunnelsByScope.get(scopeKey);
  if (current && current.port === port && current.url) {
    return { reused: true, tunnel: toPublicTunnel(current) };
  }

  await ensurePortReachable(port);
  if (current) await closeTunnel(scopeKey);

  const listener = await ngrok.forward({
    addr: port,
    authtoken,
  });
  const record = {
    scopeKey,
    port,
    url: String(listener.url() || '').trim(),
    startedAt: new Date().toISOString(),
    listener,
  };
  tunnelsByScope.set(scopeKey, record);
  return { reused: false, tunnel: toPublicTunnel(record) };
}

function getTunnelStatus(scopeKey) {
  const key = normalizeScopeKey(scopeKey);
  if (!key) throw new Error('missing_scope_key');
  return toPublicTunnel(tunnelsByScope.get(key));
}

async function closeAllTunnels() {
  const keys = Array.from(tunnelsByScope.keys());
  const closed = [];
  for (const key of keys) {
    const result = await closeTunnel(key);
    if (result.closed && result.tunnel) closed.push(result.tunnel);
  }
  return closed;
}

module.exports = {
  openTunnel,
  closeTunnel,
  getTunnelStatus,
  closeAllTunnels,
  _internal: {
    ensurePortReachable,
    normalizePort,
    normalizeScopeKey,
  },
};
