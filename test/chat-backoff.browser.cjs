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
      window.historyCount = 0;
      window.failOnce = false;
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', status: 'idle', cwd: '/fixture' };
      window.BroadcastChannel = class {
        postMessage(message) {
          if (message.type !== 'request') return;
          this.seen ??= new Set();
          if (this.seen.has(message.reqId)) return;
          this.seen.add(message.reqId);
          let result = {};
          let ok = true;
          if (message.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          else if (message.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          else if (message.method === 'overview') result = { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] };
          else if (message.method === 'chat/history') {
            window.historyCount++;
            if (window.failOnce) {
              window.failOnce = false;
              ok = false;
            } else {
              result = { available: true, identity: 'id-1', next: 1, previous: 0, rangeStart: 0, rangeEnd: 1, has_older: false, has_newer: false, events: [{ id: 'e1', type: 'text', role: 'assistant', text: 'hello', byte: 0 }] };
            }
          } else if (message.method === 'term/screen') result = { text: 'mock', hash: '1', cols: 80, rows: 24 };
          queueMicrotask(() => this.onmessage({ data: { type: 'response', reqId: message.reqId, ok, result, message: ok ? undefined : 'temporarily unavailable' } }));
        }
      };
    });

    const page = await context.newPage();
    await page.goto('http://herdr.test/');
    await page.locator('[data-pane="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('hello'));
    const before = await page.evaluate(() => window.historyCount);
    await page.evaluate(() => { window.failOnce = true; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#chat-note').textContent.includes('Retrying'));
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => window.historyCount);
    assert.ok(after > before, 'chat history should retry after transient error');
    await page.waitForFunction(() => document.querySelector('#chat-events').textContent.includes('hello'));
    console.log('PASS: transient chat errors use backoff and recover automatically');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
