'use strict';
const assert = require('node:assert/strict');
const { TextEncoder } = require('node:util');

const CACHE_MAX_BYTES = 480 * 1024;
const utf8Bytes = (value) => new TextEncoder().encode(String(value)).length;

function trimViewCacheBytes(viewCache) {
  const measure = () => utf8Bytes(JSON.stringify(viewCache));
  while (measure() > CACHE_MAX_BYTES) {
    const chatKeys = Object.keys(viewCache.chats || {}).sort((a, b) => viewCache.chats[a].at - viewCache.chats[b].at);
    const overviewKeys = Object.keys(viewCache.overviews || {}).sort((a, b) => viewCache.overviews[a].at - viewCache.overviews[b].at);
    if (chatKeys.length) delete viewCache.chats[chatKeys[0]];
    else if (overviewKeys.length) delete viewCache.overviews[overviewKeys[0]];
    else break;
  }
}

const viewCache = {
  overviews: { k: { at: 1, fp: 'a', data: { panes: [], workspaces: [] } } },
  chats: {},
};
for (let i = 0; i < 20; i++) {
  viewCache.chats['chat' + i] = {
    at: i,
    cacheVersion: 2,
    identity: 'id',
    tailEnd: 1,
    tailRecords: [{ byte: 0, endByte: 1, events: [{ id: 'x', type: 'text', role: 'assistant', text: 'Y'.repeat(30000), byte: 0, endByte: 1 }] }],
  };
}
trimViewCacheBytes(viewCache);
assert.ok(utf8Bytes(JSON.stringify(viewCache)) <= CACHE_MAX_BYTES);
assert.ok(Object.keys(viewCache.chats).length < 20, 'budget trim should evict oldest chats');
console.log('PASS: UTF-8 cache budget evicts oldest chats without clearing all');
