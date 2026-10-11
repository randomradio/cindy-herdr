'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMain(request) {
  const posts = [];
  let channel;
  const context = {
    BroadcastChannel: class {
      constructor() { channel = this; }
      postMessage(message) { posts.push(message); }
    },
    cindy: {
      onHostMessage() {},
      node: { request },
      send() {},
    },
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  return { channel, posts };
}

function request(reqId, method = 'term/screen', params = {}) {
  return { data: { type: 'request', reqId, method, params } };
}

test('main.js keeps a pending page request deduped after many completed requests', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { channel, posts } = loadMain(async ({ method, params }) => {
    calls.push({ method, id: params.id });
    if (params.id === 'pending') await gate;
    return { ok: true, result: { id: params.id } };
  });

  const first = channel.onmessage(request('pending-request', 'chat/history', { id: 'pending' }));
  for (let i = 0; i < 250; i++) await channel.onmessage(request(`completed-${i}`, 'term/screen', { id: i }));
  await channel.onmessage(request('pending-request', 'chat/history', { id: 'pending' }));
  assert.equal(calls.filter((call) => call.id === 'pending').length, 1, 'pending request must not run twice');

  release();
  await first;
  await channel.onmessage(request('pending-request', 'chat/history', { id: 'pending' }));
  assert.equal(calls.filter((call) => call.id === 'pending').length, 1, 'completed response is replayed, not rerun');
  assert.equal(posts.filter((post) => post.reqId === 'pending-request').length, 2);
});

test('page cannot use unguarded agents/prompt', async () => {
  const calls = [];
  const { channel, posts } = loadMain(async (requestBody) => {
    calls.push(requestBody.method);
    return { ok: true, result: {} };
  });
  await channel.onmessage(request('raw-prompt', 'agents/prompt', { target: 'w1:p1', text: 'hello' }));
  assert.deepEqual(calls, []);
  assert.equal(posts[0].ok, false);
  assert.match(posts[0].message, /Not allowed/);
});
