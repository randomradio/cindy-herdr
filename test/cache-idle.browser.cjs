'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const transcript = require('../node/transcript.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const dir = await fs.mkdtemp(path.join(root, '.cache-idle-'));
  const file = path.join(dir, 'history.jsonl');
  const row = (i) => JSON.stringify({ type: 'message', id: 'm' + i, message: { role: 'user', content: [{ type: 'text', text: 'message ' + i }] } }) + '\n';
  await fs.writeFile(file, Array.from({ length: 40 }, (_, i) => row(i)).join(''));
  const initialPage = { available: true, agent: 'pi', ...transcript.read(file, 'pi') };
  const unchanged = { available: true, agent: 'pi', ...transcript.read(file, 'pi', { identity: initialPage.identity, after: initialPage.next }) };

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
    await context.addInitScript(({ initialPage, unchanged }) => {
      window.fetch = async () => ({ ok: true });
      window.writes = [];
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'herdr-view-cache-v2') window.writes.push(v);
        return orig.call(this, k, v);
      };
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', status: 'idle', cwd: '/fixture' };
      const overview = { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] };
      window.BroadcastChannel = class {
        postMessage(message) {
          if (message.type !== 'request') return;
          this.seen ??= new Set();
          if (this.seen.has(message.reqId)) return;
          this.seen.add(message.reqId);
          let result = {};
          if (message.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          else if (message.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          else if (message.method === 'overview') result = overview;
          else if (message.method === 'chat/history') result = message.params.after ? unchanged : initialPage;
          queueMicrotask(() => this.onmessage({ data: { type: 'response', reqId: message.reqId, ok: true, result } }));
        }
      };
    }, { initialPage, unchanged });

    const page = await context.newPage();
    await page.goto('http://herdr.test/');
    await page.locator('[data-pane="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').children.length > 0);
    await page.waitForTimeout(500);
    const baseline = await page.evaluate(() => window.writes.length);
    await page.waitForTimeout(8500);
    const after = await page.evaluate(() => window.writes.length);
    assert.equal(after, baseline, 'unchanged idle chat must not rewrite cache');
    console.log('PASS: unchanged idle polling does not persist cache');
  } finally {
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
