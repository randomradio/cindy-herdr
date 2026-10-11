'use strict';
// Run with playwright-core available via NODE_PATH; CHROME_PATH may override the browser.
// All herdr responses are mocked; this never sends input to a real pane.
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://herdr.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(root, pathname === '/' ? 'view.html' : pathname);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      await route.fulfill({ body: await fs.readFile(file), contentType: type });
    });
    await page.addInitScript(() => {
      window.fetch = async () => ({ ok: true });
      window.pendingHistory = [];
      window.calls = [];
      window.historyMode = 'missing';
      window.historyReply = (request, result) => request.channel.onmessage({ data: { type: 'response', reqId: request.message.reqId, ok: true, result } });
      const panes = ['wA', 'wB'].map((id) => ({ pane_id: id + ':p1', workspace_id: id, agent: 'codex', status: 'idle', cwd: '/test/' + id }));
      window.BroadcastChannel = class {
        postMessage(message) {
          if (message.type !== 'request') return;
          // Mirror brain deduplication, including while a history response is pending.
          if (!this.seen) this.seen = new Set();
          if (this.seen.has(message.reqId)) return;
          this.seen.add(message.reqId);
          window.calls.push(message.method);
          let result;
          if (message.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          else if (message.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          else if (message.method === 'overview') result = { panes, workspaces: panes.map(p => ({ workspace_id: p.workspace_id, label: p.workspace_id })) };
          else if (message.method === 'chat/history') {
            const request = { channel: this, message };
            if (window.historyMode === 'pending') { window.pendingHistory.push(request); return; }
            result = window.historyMode === 'missing' ? { available: false, reason: 'herdr has not reported an exact transcript for this agent.' }
              : { available: true, identity: message.params.target, next: 100, previous: 0, events: message.params.after ? [] : [{ id: 'one', type: 'text', role: 'assistant', text: 'Matched conversation' }] };
          } else if (message.method === 'term/screen') result = { text: 'Mock terminal', hash: 'one', cols: 80, rows: 24 };
          else result = {};
          queueMicrotask(() => window.historyReply({ channel: this, message }, result));
        }
      };
    });
    await page.goto('http://herdr.test/');
    await page.locator('[data-pane="wA:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-state-title').textContent === 'Chat history is unavailable');
    assert.equal(await page.locator('#show-chat').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#chat-input').isDisabled(), true);
    const count = await page.evaluate(() => window.calls.filter(c => c === 'chat/history').length);
    await page.waitForTimeout(4500);
    assert.equal(await page.evaluate(() => window.calls.filter(c => c === 'chat/history').length), count, 'unavailable history must not poll automatically');
    await page.locator('#chat-open-terminal').click();
    assert.equal(await page.locator('#show-terminal').getAttribute('aria-pressed'), 'true');
    await page.locator('#show-chat').click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'chat/history').length >= 2);
    assert.equal(await page.locator('#chat-panel').isVisible(), true);

    // Retry recovers and restores the composer.
    await page.evaluate(() => { window.historyMode = 'ready'; });
    await page.locator('#chat-retry').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('Matched conversation'));
    assert.equal(await page.locator('#chat-input').isEnabled(), true);
    assert.equal(await page.locator('#chat-state').isVisible(), false);

    // A missing-history reply delivered after switching views must not change the selected tab.
    await page.locator('#show-terminal').click();
    await page.evaluate(() => { window.historyMode = 'pending'; });
    await page.locator('#show-chat').click();
    await page.waitForFunction(() => window.pendingHistory.length === 1);
    await page.locator('#show-terminal').click();
    await page.evaluate(() => window.historyReply(window.pendingHistory.shift(), { available: false, reason: 'late missing session' }));
    assert.equal(await page.locator('#show-terminal').getAttribute('aria-pressed'), 'true');

    // A reply for pane A cannot overwrite pane B, even when A was still in flight.
    await page.locator('#show-chat').click();
    await page.waitForFunction(() => window.pendingHistory.length === 1);
    await page.locator('[data-pane="wB:p1"]').click();
    await page.evaluate(() => window.historyReply(window.pendingHistory.shift(), { available: false, reason: 'WRONG PANE' }));
    await page.waitForFunction(() => window.pendingHistory.length === 1);
    await page.evaluate(() => window.historyReply(window.pendingHistory.shift(), { available: true, identity: 'B', next: 200, previous: 0, events: [{ id: 'b', role: 'assistant', type: 'text', text: 'Pane B conversation' }] }));
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('Pane B conversation'));
    assert.equal(await page.locator('#chat-state').isVisible(), false);
    assert.equal(await page.locator('#show-chat').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
    console.log('PASS: missing history, no polling loop, Chat/Terminal switches, Retry recovery, delayed replies and pane switches');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
