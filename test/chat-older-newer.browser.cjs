'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const transcript = require('../node/transcript.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const dir = await fs.mkdtemp(path.join(root, '.older-newer-'));
  const file = path.join(dir, 'history.jsonl');
  const row = (i) => JSON.stringify({ type: 'message', id: 'm' + i, message: { role: 'user', content: [{ type: 'text', text: 'msg ' + i + ' ' + 'x'.repeat(400) }] } }) + '\n';
  await fs.writeFile(file, Array.from({ length: 500 }, (_, i) => row(i)).join(''));
  const tail = transcript.read(file, 'pi');
  const olderPage = transcript.read(file, 'pi', { identity: tail.identity, before: tail.previous });

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
    await context.addInitScript(({ tail, olderPage }) => {
      window.fetch = async () => ({ ok: true });
      window.tail = tail;
      window.olderPage = olderPage;
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', status: 'idle', cwd: '/fixture' };
      window.BroadcastChannel = class {
        postMessage(message) {
          if (message.type !== 'request') return;
          this.seen ??= new Set();
          if (this.seen.has(message.reqId)) return;
          this.seen.add(message.reqId);
          let result = {};
          if (message.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          else if (message.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          else if (message.method === 'overview') result = { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] };
          else if (message.method === 'chat/history') {
            result = { available: true, agent: 'pi', ...(message.params.before ? window.olderPage : message.params.after ? window.tail : window.tail) };
            if (!message.params.before && !message.params.after) Object.assign(result, window.tail);
          }
          queueMicrotask(() => this.onmessage({ data: { type: 'response', reqId: message.reqId, ok: true, result } }));
        }
      };
    }, { tail, olderPage });

    const page = await context.newPage();
    await page.goto('http://herdr.test/');
    await page.locator('[data-pane="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').children.length > 0);
    const liveCount = await page.evaluate(() => document.querySelector('#chat-events').children.length);
    await page.locator('#chat-older').click();
    await page.waitForTimeout(800);
    const newerVisible = await page.evaluate(() => !document.querySelector('#chat-newer').hidden);
    assert.equal(newerVisible, true);
    await page.locator('#chat-newer').click();
    await page.waitForFunction((n) => document.querySelector('#chat-events').children.length >= n, liveCount);
    const newerHidden = await page.evaluate(() => document.querySelector('#chat-newer').hidden);
    assert.equal(newerHidden, true);
    console.log('PASS: older navigation shows Jump to latest and restores live tail');
  } finally {
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
