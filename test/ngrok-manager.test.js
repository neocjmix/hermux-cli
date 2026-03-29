const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const ngrokSdk = require('@ngrok/ngrok');
const ngrokManager = require('../src/lib/ngrok-manager');

test('ngrok manager opens, reports, and closes a tunnel with mocked sdk', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const originalForward = ngrokSdk.forward;
  let closed = false;
  ngrokSdk.forward = async (config) => ({
    url: () => `https://demo-${config.addr}.ngrok-free.app`,
    close: async () => {
      closed = true;
    },
  });

  try {
    const opened = await ngrokManager.openTunnel({
      scopeKey: 'demo::/tmp/demo',
      port,
      authtoken: 'secret-token',
    });
    assert.equal(opened.reused, false);
    assert.equal(opened.tunnel.port, port);
    assert.match(opened.tunnel.url, /ngrok-free\.app/);

    const status = ngrokManager.getTunnelStatus('demo::/tmp/demo');
    assert.equal(status.port, port);

    const closedResult = await ngrokManager.closeTunnel('demo::/tmp/demo');
    assert.equal(closedResult.closed, true);
    assert.equal(closed, true);
    assert.equal(ngrokManager.getTunnelStatus('demo::/tmp/demo'), null);
  } finally {
    ngrokSdk.forward = originalForward;
    await ngrokManager.closeAllTunnels();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('ngrok manager rejects unreachable localhost ports before opening a tunnel', async () => {
  await assert.rejects(
    () => ngrokManager.openTunnel({
      scopeKey: 'demo::/tmp/demo',
      port: 65534,
      authtoken: 'secret-token',
    }),
    /local_port_(unreachable|timeout)/
  );
});
