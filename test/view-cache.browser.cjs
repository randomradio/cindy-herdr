'use strict';
// Reload test for the saved herdr view. All herdr responses are mocked.
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('http://herdr.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(root, pathname === '/' ? 'view.html' : pathname);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      await route.fulfill({ body: await fs.readFile(file), contentType: type });
    });
    await context.addInitScript(() => {
      window.fetch = async () => ({ ok: true });
      // sessionStorage survives reload in the same tab; it holds the test mode.
      const offline = sessionStorage.getItem('offline') === '1';
      window.historyCalls = [];
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', status: 'idle', cwd: '/test/app' };
      window.BroadcastChannel = class {
        postMessage(message) {
          if (message.type !== 'request') return;
          if (!this.seen) this.seen = new Set();
          if (this.seen.has(message.reqId)) return;
          this.seen.add(message.reqId);
          if (message.method === 'chat/history') window.historyCalls.push(message.params);
          if (offline) return; // herdr never answers: the page must render from its saved view
          let result = {};
          if (message.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          else if (message.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          else if (message.method === 'overview') result = { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'app' }] };
          else if (message.method === 'chat/history') result = { available: true, identity: 'id-1', next: 500, previous: 0, rangeStart: 0, rangeEnd: 500, has_older: false, has_newer: false, events: message.params.after ? [] : [{ id: 'e1', type: 'text', role: 'assistant', text: 'Saved conversation text', byte: 0, endByte: 500 }] };
          queueMicrotask(() => this.onmessage({ data: { type: 'response', reqId: message.reqId, ok: true, result } }));
        }
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://herdr.test/');
    await page.locator('[data-pane="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('Saved conversation text'));
    await page.waitForTimeout(400); // let the debounced cache write land

    await page.evaluate(() => sessionStorage.setItem('offline', '1'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('Saved conversation text'), null, { timeout: 3000 });
    assert.equal(await page.locator('[data-pane="w1:p1"]').count(), 1, 'saved agent list should render without herdr');
    assert.match(await page.locator('#status').textContent(), /saved view/i);
    await page.waitForFunction(() => window.historyCalls.length > 0);
    const call = await page.evaluate(() => window.historyCalls[0]);
    assert.equal(call.identity, 'id-1');
    assert.equal(call.after, 500, 'resume from the saved cursor instead of reloading history');
    assert.deepEqual(errors, []);
    console.log('PASS: reload paints saved agents and chat with herdr unanswered, then resumes from the saved cursor');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
