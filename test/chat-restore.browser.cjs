'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const transcript = require('../node/transcript.cjs');
const root = path.resolve(__dirname, '..');

function toRecords(events) {
  const map = new Map();
  for (const e of events) {
    if (!Number.isFinite(e.byte)) continue;
    if (!map.has(e.byte)) map.set(e.byte, { byte: e.byte, endByte: e.endByte || e.byte, events: [] });
    const rec = map.get(e.byte);
    if (Number.isFinite(e.endByte)) rec.endByte = e.endByte;
    rec.events.push(e);
  }
  return [...map.values()].sort((a, b) => a.byte - b.byte);
}

(async () => {
  const dir = await fs.mkdtemp(path.join(root, '.restore-test-'));
  const file = path.join(dir, 'history.jsonl');
  const row = (i, text = 'message ' + i) => JSON.stringify({ type: 'message', id: 'm' + i, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  await fs.writeFile(file, Array.from({ length: 200 }, (_, i) => row(i)).join(''));
  const initialPage = { available: true, agent: 'pi', ...transcript.read(file, 'pi') };
  const tailRecords = toRecords(initialPage.events.slice(-120));
  const tailEnd = initialPage.rangeEnd ?? initialPage.next;

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
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', status: 'idle', cwd: '/fixture' };
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
          else if (message.method === 'chat/history') result = { available: true, identity: 'live', next: 1, previous: 0, rangeStart: 0, rangeEnd: 1, has_older: false, has_newer: false, events: [] };
          queueMicrotask(() => this.onmessage({ data: { type: 'response', reqId: message.reqId, ok, result } }));
        }
      };
    });

    const page = await context.newPage();
    await page.addInitScript(({ tailRecords, tailEnd, identity }) => {
      localStorage.setItem('herdr-view-cache-v2', JSON.stringify({
        machines: [{ label: 'local', enabled: true }],
        sessions: { local: [{ name: 'agents', running: true }] },
        overviews: { 'local\u0000agents': { at: Date.now(), fp: 'x', data: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'pi', status: 'idle', cwd: '/fixture' }], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] } } },
        chats: {
          'local\u0000agents\u0000w1:p1': {
            cacheVersion: 2,
            at: Date.now(),
            identity,
            tailEnd,
            tailRecords,
            hasOlder: true,
          },
        },
      }));
      localStorage.setItem('herdr-view-prefs', JSON.stringify({ machine: 'local', 'session:local': 'agents' }));
    }, { tailRecords, tailEnd, identity: initialPage.identity });

    await page.goto('http://herdr.test/');
    await page.locator('[data-pane="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-events').children.length === 120);
    const restored = await page.evaluate(() => ({
      olderVisible: !document.querySelector('#chat-older').hidden,
      sendEnabled: !document.querySelector('#chat-send').disabled,
    }));
    assert.equal(restored.olderVisible, true);
    assert.equal(restored.sendEnabled, false);
    console.log('PASS: v2 restored cache keeps byte range and stays read-only until verified');
  } finally {
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
