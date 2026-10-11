'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { assertRemotePromptBody } = require('../node/prompt-guard.cjs');

test('worker remote prompt requires ok true, not merely non-false', () => {
  assert.throws(() => assertRemotePromptBody({ available: false, reason: 'missing pane' }));
  assert.throws(() => assertRemotePromptBody({ ok: false, code: 'UNAVAILABLE' }));
  assert.deepEqual(assertRemotePromptBody({ ok: true }), { ok: true });
});
