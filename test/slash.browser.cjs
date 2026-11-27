'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://herdr.test/**', async route => {
      const f = path.join(root, new URL(route.request().url()).pathname === '/' ? 'view.html' : new URL(route.request().url()).pathname);
      await route.fulfill({ body: await fs.readFile(f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.png') ? 'image/png' : 'text/html' });
    });
    await page.addInitScript(() => {
      window.fetch = async () => ({ ok: true }); window.calls = []; window.rejectMenu = false;
      window.nativeInput = ''; window.highlight = 0;
      const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', status: 'idle', cwd: '/fixture' };
      window.BroadcastChannel = class {
        postMessage(m) {
          if (m.type !== 'request') return;
          this.seen ??= new Set(); if (this.seen.has(m.reqId)) return; this.seen.add(m.reqId); calls.push(m);
          let result = {}, ok = true;
          if (m.method === 'machines/list') result = { machines: [{ label: 'local' }] };
          if (m.method === 'sessions/list') result = { result: { sessions: [{ name: 'agents', running: true }] } };
          if (m.method === 'overview') result = { panes: [pane], workspaces: [{ workspace_id: 'w1', label: 'fixture' }] };
          if (m.method === 'chat/history') result = { available: true, identity: 'live-id', next: 10, previous: 0, rangeStart: 0, rangeEnd: 10, events: m.params.after ? [] : [{ id: 'e1', type: 'text', role: 'assistant', text: 'Ready', byte: 0, endByte: 10 }] };
          if (m.method === 'chat/commands') {
            ok = !window.rejectMenu;
            let resumed = false;
            if (ok) {
              const p = m.params;
              if (p.operation === 'open') {
                resumed = (p.text === '/' && /^\/\S*$/.test(nativeInput)) || nativeInput === p.text;
                if (!resumed && nativeInput) ok = false;
                if (!resumed && ok) nativeInput = p.text;
              }
              if (p.operation === 'edit') { if (p.expectedText !== nativeInput) throw Error('stale input'); nativeInput = p.text; }
              if (p.operation === 'key' && p.key === 'down') highlight = 1;
              if (p.operation === 'key' && p.key === 'tab') nativeInput = highlight ? '/help ' : '/model ';
              if (p.operation === 'select') nativeInput = p.label + ' ';
              if (p.operation === 'key' && p.key === 'enter') nativeInput = '';
            }
            const filtering = nativeInput === '/' || nativeInput === '/model' || nativeInput === '/help';
            result = { ok, resumed, input: nativeInput, recognized: true, selected: filtering ? highlight : -1, options: filtering ? [{ label: '/model', description: 'Choose model' }, { label: '/help', description: 'Agent help' }] : [] };
          }
          setTimeout(() => this.onmessage({ data: { type: 'response', reqId: m.reqId, ok, result, message: ok ? undefined : 'SESSION_MISMATCH: Agent changed.' } }), 30);
        }
      };
    });
    await page.goto('http://herdr.test/');await page.locator('[data-pane="w1:p1"]').click();
    await page.addStyleTag({ content: 'body { font-family: system-ui, sans-serif; }' });
    await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
    await page.locator('#chat-input').fill('/');
    await page.waitForFunction(() => document.querySelectorAll('.slash-option').length === 2);
    for (const theme of ['light', 'dark']) {
      await page.addStyleTag({ content: theme === 'dark'
        ? ':root { --surface: #191919; --panel-bg: #202020; --surface-elevated: #272727; --surface-chip: #333; --text-primary: #eee; --text-secondary: #bbb; --text-tertiary: #999; --border-default: #404040; --accent-soft: #353535; --accent-cta-bg: #eee; --accent-pure-cta-fg: #191919; }'
        : ':root { --surface: #fafafa; --panel-bg: #f4f4f4; --surface-elevated: #fff; --surface-chip: #eee; --text-primary: #222; --text-secondary: #555; --text-tertiary: #777; --border-default: #ddd; --accent-soft: #e9e9e9; --accent-cta-bg: #222; --accent-pure-cta-fg: #fff; }' });
      for (const [width, height] of [[320, 768], [420, 768], [900, 768], [1280, 768], [320, 400], [900, 350]]) {
        await page.setViewportSize({ width, height });
        await page.locator('#chat-input').evaluate((input, resized) => { input.style.height = resized ? '180px' : ''; }, height < 768);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const layout = await page.evaluate(() => {
          const menu = document.querySelector('#slash-menu');
          const composer = document.querySelector('.composer');
          const visibleTop = composer.getBoundingClientRect().top;
          menu.hidden = true;
          const hiddenTop = composer.getBoundingClientRect().top;
          menu.hidden = false;
          const menuRect = menu.getBoundingClientRect();
          const controls = ['#chat-input', '#chat-send', '#chat-slash', '#show-chat', '#show-terminal', '#slash-dismiss'];
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            composerMoves: visibleTop !== hiddenTop,
            menuAboveComposer: menuRect.bottom <= visibleTop && menuRect.top >= 0,
            controlsVisible: controls.every(selector => {
              const rect = document.querySelector(selector).getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
            }),
            logoLoaded: document.querySelector('.brand img').naturalWidth > 0,
          };
        });
        assert.deepEqual(layout, { overflow: false, composerMoves: false, menuAboveComposer: true, controlsVisible: true, logoLoaded: true }, `${theme} at ${width}×${height}px`);
        assert.match(await page.locator('[data-pane="w1:p1"] .row-meta').innerText(), /fixture/);
        if (process.env.LAYOUT_SCREENSHOT_DIR && height === 768) {
          await fs.mkdir(process.env.LAYOUT_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.LAYOUT_SCREENSHOT_DIR, `herdr-${theme}-${width}.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.locator('#chat-input').evaluate(input => { input.style.height = ''; });
    assert.equal(await page.locator('#show-chat').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#chat-input').inputValue(), '/');
    await page.locator('#chat-input').press('ArrowDown');
    await page.waitForFunction(() => document.querySelectorAll('.slash-option')[1]?.getAttribute('aria-selected') === 'true');
    await page.locator('#chat-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#chat-input').value === '/help ');
    await page.locator('#chat-input').fill('/model');
    await page.waitForFunction(() => window.nativeInput === '/model' && !document.querySelector('#chat-input').disabled);
    await page.locator('.slash-option').first().click();
    await page.waitForFunction(() => document.querySelector('#chat-input').value === '/model ');
    await page.locator('#chat-input').fill('/model 中文');
    await page.waitForFunction(() => window.nativeInput === '/model 中文');
    await page.locator('#chat-input').fill('/model 替换');
    await page.waitForFunction(() => window.nativeInput === '/model 替换');
    // Composition Enter must not execute the native command.
    const before = await page.evaluate(() => calls.length);
    await page.locator('#chat-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await page.evaluate(() => calls.slice(-1)[0].params.key === 'enter'), false);
    await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#slash-menu').hidden);
    assert.equal(await page.locator('#chat-input').inputValue(), '');
    assert.equal(await page.evaluate(() => calls.some(c => ['chat/prompt', 'term/input', 'term/screen'].includes(c.method))), false);
    await page.evaluate(() => { window.nativeInput = '/models'; });
    await page.locator('#chat-input').fill('/');
    await page.waitForFunction(() => document.querySelector('#chat-input').value === '/models' && !document.querySelector('#chat-input').disabled);
    assert.match(await page.locator('#chat-note').textContent(), /Resumed/);
    await page.locator('#chat-input').fill('/model');
    await page.waitForFunction(() => window.nativeInput === '/model' && document.querySelectorAll('.slash-option').length === 2);
    const beforeResumeClose = await page.evaluate(() => calls.length);
    await page.locator('#slash-dismiss').click();
    await page.waitForFunction(() => document.querySelector('#slash-menu').hidden);
    assert.equal(await page.locator('#slash-menu').isVisible(), false);
    assert.equal(await page.evaluate(() => window.nativeInput), '/model');
    assert.deepEqual(await page.evaluate(start => calls.slice(start).filter(call => call.method === 'chat/commands' && call.params.operation !== 'read').map(call => call.params.operation), beforeResumeClose), ['cancel']);
    await page.locator('#chat-input').fill('/');
    await page.waitForFunction(() => document.querySelector('#chat-input').value === '/model' && !document.querySelector('#chat-input').disabled);
    await page.evaluate(() => {
      const input = document.querySelector('#chat-input');
      input.value = '/model unsent';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#slash-dismiss').click();
    });
    await page.waitForFunction(() => document.querySelector('#slash-menu').hidden);
    assert.equal(await page.locator('#chat-input').inputValue(), '/model unsent');
    assert.equal(await page.evaluate(() => window.nativeInput), '/model unsent');
    await page.locator('#chat-input').fill('/review important unsent instructions');
    await page.waitForFunction(() => document.querySelector('#chat-note').textContent.includes('Agent changed'));
    await page.locator('#slash-dismiss').click();
    assert.equal(await page.locator('#chat-input').inputValue(), '/review important unsent instructions');
    assert.equal(await page.evaluate(() => window.nativeInput), '/model unsent');
    await page.evaluate(() => { window.rejectMenu = true; });
    await page.locator('#chat-input').fill('/');
    await page.waitForFunction(() => document.querySelector('#chat-note').textContent.includes('Agent changed'));
    assert.equal(await page.locator('#chat-input').inputValue(), '/');
    const beforeFailedClose = await page.evaluate(() => calls.length);
    assert.equal(await page.locator('#chat-input').isEnabled(), true);
    await page.locator('#chat-input').pressSequentially('model keep typing');
    await page.locator('#chat-input').press('Enter');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#chat-input').inputValue(), '/model keep typing');
    assert.equal(await page.locator('#chat-send').isEnabled(), false);
    assert.equal(await page.evaluate(start => calls.slice(start).some(call => call.method === 'chat/commands'), beforeFailedClose), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#slash-menu').isVisible(), false);
    assert.equal(await page.locator('#chat-input').isEnabled(), true);
    assert.equal(await page.locator('#chat-input').inputValue(), '/model keep typing');
    assert.equal(await page.evaluate(() => window.nativeInput), '/model unsent');
    assert.equal(await page.evaluate(start => calls.slice(start).some(call => call.method === 'chat/commands'), beforeFailedClose), false);
    await page.locator('#chat-input').fill('/');
    await page.waitForFunction(() => document.querySelector('#chat-note').textContent.includes('Agent changed'));
    await page.locator('#slash-dismiss').click();
    assert.equal(await page.locator('#slash-menu').isVisible(), false);
    assert.equal(await page.locator('#chat-input').isEnabled(), true);
    const mutations = await page.evaluate(() => calls.filter(c => c.method === 'chat/commands' && c.params.operation !== 'read'));
    assert(mutations.every(m => m.params.identity === 'live-id'));
    assert.deepEqual(errors, []);
    console.log('PASS: native options, Tab, editing, IME, Enter once, resumed native drafts, Escape and close after failures');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
