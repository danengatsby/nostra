'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function worker(cacheControl = 'public, max-age=3600') {
  const handlers = {};
  const saved = [];
  const deleted = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), {
    URL, location: { origin: 'https://example.com' },
    self: {
      addEventListener: (name, fn) => { handlers[name] = fn; },
      clients: { claim: async () => {} },
    },
    fetch: async () => new Response('asset', { headers: { 'Cache-Control': cacheControl } }),
    caches: {
      open: async () => ({ put: async (req) => { saved.push(req.url); } }),
      keys: async () => ['nostra-v3', 'nostra-v4', 'nostra-v5', 'nostra-v6', 'nostra-v7', 'nostra-v8', 'other-app'],
      delete: async (key) => { deleted.push(key); },
      match: async () => null,
    },
  });
  return { handlers, saved, deleted };
}

test('service worker-ul nu interceptează pagini de previziuni, plăți sau API pentru cache', () => {
  const { handlers } = worker();
  for (const url of ['/p/private123', '/pay/order123', '/api/p/private123', '/og/private123.png']) {
    for (const mode of ['navigate', 'cors']) {
      let intercepted = false;
      handlers.fetch({
        request: { method: 'GET', url: `https://example.com${url}`, mode },
        respondWith: () => { intercepted = true; },
      });
      assert.equal(intercepted, false, `${url} / ${mode}`);
    }
  }
});

test('service worker-ul respectă private/no-store și continuă să salveze fișierele publice', async () => {
  for (const control of ['private, no-store', 'no-store', 'private, max-age=300', 'public, max-age=3600']) {
    const { handlers, saved } = worker(control);
    let response;
    handlers.fetch({
      request: { method: 'GET', url: 'https://example.com/style.css', mode: 'cors' },
      respondWith: (promise) => { response = promise; },
    });
    assert.equal(await (await response).text(), 'asset');
    assert.equal(saved.length, control.startsWith('public') ? 1 : 0, control);
  }
});

test('activarea service worker-ului nou elimină copiile vechi', async () => {
  const { handlers, deleted } = worker();
  let activated;
  handlers.activate({ waitUntil: (promise) => { activated = promise; } });
  await activated;
  assert.deepEqual(deleted, ['nostra-v3', 'nostra-v4', 'nostra-v5', 'nostra-v6', 'nostra-v7']);
});
