'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const context = await browser.newContext();
    await context.route('http://herdr.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const f = path.join(root, pathname === '/' ? 'view.html' : pathname);
      const type = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html';
      await route.fulfill({ body: await fs.readFile(f), contentType: type });
    });
    await context.addInitScript(() => {
      window.fetch = async () => ({ ok: true });
      window.mode = sessionStorage.getItem('mode') || 'defer';
      window.delivered = null;
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', status: 'idle', cwd: '/fixture' };
      window.BroadcastChannel = class {
        postMessage(message) {
          if (message.type !== 'request') return;
          this.seen ??= new Set();
          if (this.seen.has(message.reqId)) return;
          this.seen.add(message.reqId);
          if (window.mode === 'defer') return;
          let result = {};
          let ok = true;
          if (message.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          else if (message.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          else if (message.method === 'overview') result = { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] };
          else if (message.method === 'chat/history') {
            result = { available: true, identity: 'live-session', next: 10, previous: 0, rangeStart: 0, rangeEnd: 10, has_older: false, has_newer: false, events: [{ id: 'e1', type: 'text', role: 'assistant', text: 'Live text', byte: 0 }] };
          } else if (message.method === 'chat/prompt') {
            window.delivered = message.params;
            result = { ok: true };
          }
          queueMicrotask(() => this.onmessage({ data: { type: 'response', reqId: message.reqId, ok, result } }));
        }
      };
    });

    const page = await context.newPage();
    await page.goto('http://herdr.test/');
    await page.evaluate(() => {
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', status: 'idle', cwd: '/fixture' };
      localStorage.setItem('herdr-view-cache-v2', JSON.stringify({
        machines: [{ label: 'local', enabled: true }],
        sessions: { local: [{ name: 'agents', running: true }] },
        overviews: { 'local\u0000agents': { at: Date.now(), data: { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] } } },
        chats: {
          'local\u0000agents\u0000w1:p1': {
            cacheVersion: 2,
            at: Date.now(),
            identity: 'stale-session',
            tailEnd: 10,
            tailRecords: [{ byte: 0, endByte: 10, events: [{ id: 'old', type: 'text', role: 'assistant', text: 'Cached only', byte: 0, endByte: 10 }] }],
            hasOlder: false,
          },
        },
      }));
      localStorage.setItem('herdr-view-prefs', JSON.stringify({ machine: 'local', 'session:local': 'agents' }));
    });
    await page.reload();
    await page.locator('[data-pane="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('Cached only'));
    assert.equal(await page.evaluate(() => document.querySelector('#chat-send').disabled), true);
    await page.evaluate(() => {
      document.querySelector('#chat-input').value = 'must not send yet';
      document.querySelector('#chat-form').requestSubmit();
    });
    assert.equal(await page.evaluate(() => window.delivered), null);

    await page.evaluate(() => { window.mode = 'ready'; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('Live text'));
    await page.locator('#chat-input').fill('verified send');
    await page.locator('#chat-send').click();
    await page.waitForFunction(() => window.delivered && window.delivered.text === 'verified send');
    const params = await page.evaluate(() => window.delivered);
    assert.equal(params.identity, 'live-session');
    console.log('PASS: cached chat is read-only until identity is verified; prompt carries identity');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
