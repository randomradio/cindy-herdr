'use strict';
const { chromium } = require('playwright-core');
const path = require('node:path');
const assert = require('node:assert/strict');
const nativeMenu = require('../node/native-menu.cjs');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let failures = 0;
  async function scenario(name, check) {
    const page = await browser.newPage();
    try {
      await page.setContent('<textarea id="input"></textarea><div id="menu" hidden><div id="list"></div><div id="preview"></div><button id="close">Close</button><button id="terminal">Terminal</button></div>');
      await page.addScriptTag({ path: path.join(__dirname, '..', 'slash-controller.js') });
      await page.evaluate(() => {
        const element = id => document.getElementById(id);
        window.calls = [];
        window.nativeInput = '';
        window.delay = 100;
        window.failed = false;
        window.terminalOpened = false;
        window.identity = 'first';
        window.controller = new HerdrSlashController({
          input: element('input'), menu: element('menu'), list: element('list'), preview: element('preview'),
          dismiss: element('close'), fullTerminal: element('terminal'),
          capture: () => ({ identity, params: { target: identity, identity } }),
          valid: target => target.identity === identity,
          status: (message, error) => { window.statusText = message; window.statusError = !!error; },
          change: () => { element('input').disabled = !!window.controller?.inputLocked; },
          terminal: () => { window.terminalOpened = true; },
          request: async (method, params) => {
            calls.push({ method, ...params });
            if (failed) return { ok: false, message: 'Transport failed.' };
            if (params.operation === 'open') nativeInput = params.text;
            if (params.operation === 'edit') nativeInput = params.text;
            if (params.operation === 'key' && params.key === 'tab') nativeInput = '/model ';
            if (params.operation === 'key' && params.key === 'enter') {
              window.sentInput = params.draft ?? nativeInput;
              if (window.enterDialog) return { ok: true, result: { ok: true, recognized: false, input: null, options: [] } };
              const oldInput = nativeInput;
              nativeInput = '';
              return { ok: true, result: { ok: true, recognized: true, input: window.staleEnter ? oldInput : '', options: [] } };
            }
            if (params.operation === 'cancel') return { ok: true, result: { ok: true, recognized: true, input: nativeInput, options: [] } };
            const snapshot = nativeInput;
            await new Promise(resolve => setTimeout(resolve, delay));
            return { ok: true, result: { ok: true, recognized: true, input: snapshot, selected: 0, options: snapshot === '/' ? [{ label: '/model', description: 'Choose model' }] : [] } };
          },
        });
      });
      await check(page);
      console.log('PASS: ' + name);
    } catch (error) {
      failures++;
      console.error('FAIL: ' + name + '\n' + error.stack);
    } finally { await page.close(); }
  }
  try {
    await scenario('arrow navigation preserves browser spaces without inserting invisible native spaces', async page => {
      let draft = '';
      await page.exposeFunction('nativeBridge', async params => ({
        ok: true,
        result: await nativeMenu.interact(params, 'codex', async (args, raw) => {
          if (raw) return '› ' + draft + '\n  /review  Review changes';
          if (args[1] === 'send-text') draft += args[3];
          else for (const key of args.slice(3)) if (key === 'backspace') draft = draft.slice(0, -1);
        }),
      }));
      await page.evaluate(() => { controller.request = (method, params) => nativeBridge(params); });
      await page.locator('#input').fill('/review');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').pressSequentially(' ');
      await page.locator('#input').press('ArrowDown');
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#input').inputValue(), '/review ');
      assert.equal(draft, '/review');
      await page.locator('#input').pressSequentially('hello');
      await page.waitForFunction(() => controller.session.native === '/review hello');
      assert.equal(draft, '/review hello');
      assert.equal(await page.evaluate(() => !!controller.session.failed), false);
    });
    await scenario('late native Tab completion rebases typing and queued Enter without replaying Tab', async page => {
      let draft = '';
      let staleReads = 0;
      const writes = [];
      const submitted = [];
      const screen = input => ['─────────────────────────────', input + '\x1b[7m \x1b[27m', '─────────────────────────────', input === '/m' ? '→ model     Choose model' : ''].join('\n');
      await page.exposeFunction('nativeBridge', async params => ({
        ok: true,
        result: await nativeMenu.interact(params, 'pi', async (args, raw) => {
          if (raw) return screen(staleReads-- > 0 ? '/m' : draft);
          writes.push(args);
          if (args[1] === 'send-text') draft += args[3];
          else for (const key of args.slice(3)) {
            if (key === 'backspace') draft = draft.slice(0, -1);
            if (key === 'tab') { draft = '/model '; staleReads = 6; }
            if (key === 'enter') { submitted.push(draft); draft = ''; }
          }
        }),
      }));
      await page.evaluate(() => { controller.request = (method, params) => nativeBridge(params); });
      await page.locator('#input').fill('/m');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Tab');
      await page.locator('#input').pressSequentially('hello');
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => !controller.active);
      assert.deepEqual(submitted, ['/model hello']);
      assert.equal(writes.filter(args => args.includes('tab')).length, 1);
      assert.equal(writes.filter(args => args.includes('enter')).length, 1);
    });
    await scenario('typing and cursor movement continue locally after a native request fails', async page => {
      await page.locator('#input').fill('/m');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => { failed = true; });
      await page.locator('#input').pressSequentially('o');
      await page.waitForFunction(() => controller.session.failed);
      const requests = await page.evaluate(() => calls.length);
      assert.equal(await page.locator('#input').isEnabled(), true);
      await page.locator('#input').pressSequentially('del arguments');
      assert.equal(await page.locator('#input').inputValue(), '/model arguments');
      await page.locator('#input').press('ArrowLeft');
      await page.locator('#input').press('Backspace');
      assert.equal(await page.locator('#input').inputValue(), '/model argumens');
      await page.locator('#input').press('Enter');
      await page.locator('#input').press('Tab');
      await page.waitForTimeout(180);
      assert.equal(await page.evaluate(() => calls.length), requests);
      await page.locator('#input').press('Escape');
      assert.equal(await page.locator('#input').inputValue(), '/model argumens');
      assert.equal(await page.evaluate(() => controller.active), false);
    });
    await scenario('a transient unrecognized terminal screen cannot stop typing or send speculative edits', async page => {
      await page.locator('#input').fill('/m');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => {
        const request = controller.request;
        window.screenMissing = true;
        controller.request = (method, params) => screenMissing
          ? Promise.resolve({ ok: true, result: { ok: true, recognized: false, input: null, options: [] } })
          : request(method, params);
        controller.pump(controller.session);
      });
      await page.waitForFunction(() => !!controller.session.pendingEdit);
      await page.locator('#input').pressSequentially('odel');
      assert.equal(await page.locator('#input').inputValue(), '/model');
      assert.equal(await page.evaluate(() => nativeInput), '/m');
      await page.evaluate(() => { screenMissing = false; });
      await page.waitForFunction(() => nativeInput === '/model');
      assert.equal(await page.evaluate(() => !!controller.session.failed), false);
    });
    await scenario('trailing spaces stay in the browser until an argument can be observed in the terminal', async page => {
      let draft = '';
      const writes = [];
      await page.exposeFunction('nativeBridge', async params => ({
        ok: true,
        result: await nativeMenu.interact(params, 'codex', async (args, raw) => {
          if (raw) return '› ' + draft + '     ';
          writes.push(args);
          if (args[1] === 'send-text') draft += args[3];
          else for (const key of args.slice(3)) if (key === 'backspace') draft = draft.slice(0, -1);
        }),
      }));
      await page.evaluate(() => { controller.request = (method, params) => nativeBridge(params); });
      await page.locator('#input').fill('/review');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').pressSequentially('  ');
      await page.waitForTimeout(180);
      assert.equal(await page.locator('#input').inputValue(), '/review  ');
      assert.equal(draft, '/review');
      await page.locator('#input').pressSequentially('my changes');
      await page.waitForFunction(() => controller.session.native === '/review  my changes');
      assert.equal(draft, '/review  my changes');
      assert.equal(await page.locator('#input').inputValue(), draft);
      assert.equal(await page.locator('#input').isEnabled(), true);
      assert.equal(writes.some(args => args.includes('enter')), false);
    });
    await scenario('a native draft changed elsewhere cannot replace the browser draft', async page => {
      await page.locator('#input').fill('/m');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => { nativeInput = '/different'; controller.pump(controller.session); });
      await page.waitForFunction(() => controller.session.failed);
      assert.equal(await page.locator('#input').inputValue(), '/m');
      await page.locator('#input').pressSequentially('odel');
      assert.equal(await page.locator('#input').inputValue(), '/model');
      assert.equal(await page.evaluate(() => nativeInput), '/different');
    });
    await scenario('an unacknowledged edit pauses without repeating native input', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => {
        controller.request = async (method, params) => {
          calls.push({ method, ...params });
          return { ok: true, result: { ok: true, input: '/', recognized: true, options: [] } };
        };
      });
      await page.locator('#input').pressSequentially('missing');
      await page.waitForFunction(() => !!controller.session.pendingEdit);
      await page.evaluate(() => { controller.session.pendingEdit.started -= 2100; });
      await page.waitForFunction(() => controller.session.failed);
      assert.equal(await page.locator('#input').inputValue(), '/missing');
      assert.equal(await page.evaluate(() => calls.filter(call => call.operation === 'edit').length), 1);
      assert.equal(await page.evaluate(() => calls.some(call => call.operation === 'read')), true);
    });
    await scenario('consecutive backspaces wait for delayed native acknowledgement without replaying edits', async page => {
      let draft = '';
      let stale = '';
      let staleReads = 0;
      const writes = [];
      const screen = input => ['› ' + input, input && '/model'.startsWith(input) ? '  /model  Choose model' : ''].join('\n');
      await page.exposeFunction('draftState', () => draft);
      await page.exposeFunction('nativeBridge', async params => ({
        ok: true,
        result: await nativeMenu.interact(params, 'codex', async (args, raw) => {
          if (raw) return staleReads-- > 0 ? stale : screen(draft);
          writes.push(args);
          if (args[1] === 'send-text') draft += args[3];
          else for (const key of args.slice(3)) {
            if (key === 'backspace') {
              stale = screen(draft);
              staleReads = 6;
              draft = draft.slice(0, -1);
            }
          }
        }),
      }));
      await page.evaluate(() => { controller.request = (method, params) => nativeBridge(params); });
      await page.locator('#input').fill('/modelx');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Backspace');
      await page.waitForFunction(async () => await draftState() === '/model');
      await page.locator('#input').press('Backspace');
      await page.waitForFunction(() => controller.session.native === '/mode');
      assert.equal(await page.locator('#input').inputValue(), '/mode');
      assert.equal(await page.locator('#list button').count(), 1);
      assert.equal(await page.evaluate(() => !!controller.session.failed || statusError), false);
      assert.equal(writes.flatMap(args => args.slice(3)).filter(key => key === 'backspace').length, 2);
    });
    await scenario('unmatched prefixes stay editable and backspace restores native suggestions', async page => {
      let draft = '';
      const writes = [];
      await page.exposeFunction('nativeBridge', async params => ({
        ok: true,
        result: await nativeMenu.interact(params, 'codex', async (args, raw) => {
          if (raw) return ['› ' + draft, draft && '/model'.startsWith(draft) ? '  /model  Choose model' : ''].join('\n');
          writes.push(args);
          if (args[1] === 'send-text') draft += args[3];
          else for (const key of args.slice(3)) {
            if (key === 'backspace') draft = draft.slice(0, -1);
            if (key === 'tab') draft = '/model';
          }
        }),
      }));
      await page.evaluate(() => { controller.request = (method, params) => nativeBridge(params); });
      await page.locator('#input').fill('/models');
      await page.waitForFunction(() => controller.session?.empty && !controller.session.opening);
      assert.equal(await page.locator('#input').isEnabled(), true);
      assert.match(await page.locator('#preview').textContent(), /No matching command suggestions/);
      await page.locator('#input').press('Tab');
      await page.locator('#input').press('ArrowDown');
      assert.equal(writes.some(args => args.includes('tab') || args.includes('down')), false);
      await page.locator('#input').press('Backspace');
      await page.waitForFunction(() => document.querySelector('#list button')?.textContent.includes('/model'));
      assert.equal(await page.locator('#input').inputValue(), '/model');
      assert.equal(await page.evaluate(() => !!controller.session.failed || statusError), false);
      await page.locator('#input').press('Backspace');
      await page.waitForFunction(() => controller.session.native === '/mode');
      await page.locator('#input').press('Tab');
      await page.waitForFunction(() => controller.session.native === '/model');
      assert.equal(await page.locator('#input').inputValue(), '/model');
    });
    await scenario('an unavailable option refreshes the menu without pausing input', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => {
        const request = controller.request;
        controller.request = (method, params) => params.operation === 'select'
          ? Promise.resolve({ ok: true, result: { ok: true, selectionChanged: true, recognized: true, input: '/', options: [] } })
          : request(method, params);
      });
      await page.locator('#list button').click();
      await page.waitForFunction(() => controller.session.empty);
      assert.equal(await page.locator('#input').isEnabled(), true);
      assert.equal(await page.evaluate(() => !!controller.session.failed || statusError), false);
      await page.locator('#input').pressSequentially('m');
      await page.waitForFunction(() => nativeInput === '/m');
    });
    await scenario('typing continues while the native menu opens', async page => {
      await page.locator('#input').fill('/');
      assert.equal(await page.locator('#input').isEnabled(), true);
      await page.locator('#input').pressSequentially('model');
      await page.waitForFunction(() => nativeInput === '/model');
      assert.equal(await page.locator('#input').inputValue(), '/model');
    });
    await scenario('pasting a complete command opens suggestions without submitting', async page => {
      await page.locator('#input').fill('/review instructions');
      await page.waitForFunction(() => calls.some(call => call.operation === 'open'), null, { timeout: 1500 });
      assert.equal(await page.evaluate(() => calls.some(call => call.key === 'enter')), false);
    });
    await scenario('IME text survives a pending native reply and sends only after composition', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.locked);
      await page.evaluate(() => {
        controller.pump(controller.session);
        const input = document.getElementById('input');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.value = '/model 中';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      await page.waitForTimeout(220);
      assert.equal(await page.locator('#input').inputValue(), '/model 中');
      assert.equal(await page.evaluate(() => calls.some(call => call.operation === 'edit')), false);
      await page.evaluate(() => {
        const input = document.getElementById('input');
        input.value = '/model 中文';
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      await page.waitForFunction(() => nativeInput === '/model 中文');
    });
    await scenario('failed input is never retried when the window becomes visible', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.locked);
      await page.evaluate(() => { failed = true; });
      await page.locator('#input').fill('/m');
      await page.waitForFunction(() => statusText === 'Transport failed.');
      const count = await page.evaluate(() => calls.length);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(160);
      assert.equal(await page.evaluate(() => calls.length), count);
    });
    await scenario('a delayed native repaint after Enter closes the menu without replaying input', async page => {
      await page.evaluate(() => { staleEnter = true; controller.open('/model'); });
      await page.waitForFunction(() => !controller.locked);
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => !controller.active, null, { timeout: 1800 });
      assert.equal(await page.evaluate(() => calls.filter(call => call.key === 'enter').length), 1);
      assert.equal(await page.locator('#input').inputValue(), '');
    });
    await scenario('native command dialogs continue in Terminal', async page => {
      await page.evaluate(() => { enterDialog = true; controller.open('/model'); });
      await page.waitForFunction(() => !controller.locked);
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => terminalOpened, null, { timeout: 1500 });
      assert.equal(await page.evaluate(() => controller.active), false);
    });
    await scenario('late replies cannot change the next agent composer', async page => {
      await page.locator('#input').fill('/');
      await page.evaluate(() => { identity = 'second'; controller.reset(); document.getElementById('input').value = 'second draft'; });
      await page.waitForTimeout(180);
      assert.equal(await page.locator('#input').inputValue(), 'second draft');
      assert.equal(await page.evaluate(() => calls.some(call => call.target === 'second')), false);
    });
    await scenario('typing and Enter immediately after Tab use the completed command', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Tab');
      assert.equal(await page.locator('#input').isEnabled(), true);
      await page.locator('#input').pressSequentially('hello');
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => !controller.active);
      assert.equal(await page.evaluate(() => sentInput), '/model hello');
      assert.equal(await page.evaluate(() => calls.filter(call => call.key === 'enter').length), 1);
    });
    await scenario('rapid arrow presses reach the native menu in order', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('ArrowDown');
      await page.locator('#input').press('ArrowDown');
      await page.locator('#input').press('ArrowUp');
      await page.waitForFunction(() => calls.filter(call => call.operation === 'key').length === 3);
      assert.deepEqual(await page.evaluate(() => calls.filter(call => call.operation === 'key').map(call => call.key)), ['down', 'down', 'up']);
    });
    await scenario('typing after a queued Tab survives the earlier read response', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => { controller.pump(controller.session); });
      await page.locator('#input').press('Tab');
      await page.locator('#input').pressSequentially('queued');
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#input').inputValue(), '/model queued');
      assert.equal(await page.evaluate(() => nativeInput), '/model queued');
    });
    await scenario('typing after a queued arrow survives the earlier read response', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.evaluate(() => { controller.pump(controller.session); });
      await page.locator('#input').press('ArrowDown');
      await page.locator('#input').pressSequentially('keep');
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#input').inputValue(), '/keep');
      assert.equal(await page.evaluate(() => nativeInput), '/keep');
    });
    await scenario('native dialog handoff restores the saved normal-message draft', async page => {
      await page.locator('#input').fill('unfinished message');
      await page.evaluate(() => { enterDialog = true; controller.open('/model'); });
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => terminalOpened);
      assert.equal(await page.locator('#input').inputValue(), 'unfinished message');
    });
    await scenario('opening Terminal manually restores the saved normal-message draft', async page => {
      await page.locator('#input').fill('unfinished message');
      await page.evaluate(() => { controller.open('/model'); });
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#terminal').click();
      assert.equal(await page.locator('#input').inputValue(), 'unfinished message');
    });
    await scenario('IME started after Tab merges only committed characters into the completed command', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Tab');
      await page.evaluate(() => {
        const input = document.getElementById('input');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.value = '/中文';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      await page.waitForTimeout(180);
      assert.equal(await page.locator('#input').inputValue(), '/中文');
      assert.equal(await page.evaluate(() => calls.some(call => call.operation === 'edit')), false);
      await page.locator('#input').dispatchEvent('compositionend');
      await page.waitForFunction(() => nativeInput === '/model 中文');
      assert.equal(await page.locator('#input').inputValue(), '/model 中文');
    });
    await scenario('Escape after pending completion preserves arguments and native cancellation', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Tab');
      await page.locator('#input').pressSequentially('keep');
      await page.locator('#input').press('Escape');
      await page.waitForFunction(() => !controller.active);
      assert.equal(await page.locator('#input').inputValue(), '/model keep');
      assert.equal(await page.evaluate(() => nativeInput), '/model keep');
      assert.equal(await page.evaluate(() => calls.filter(call => call.operation === 'cancel').length), 1);
    });
    await scenario('a pasted command is cleared after a single native submission', async page => {
      await page.locator('#input').fill('/review instructions');
      await page.waitForFunction(() => controller.active && !controller.session.opening);
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => !controller.active);
      assert.equal(await page.locator('#input').inputValue(), '');
      assert.equal(await page.evaluate(() => sentInput), '/review instructions');
    });
    await scenario('deleting the command returns to an empty chat composer', async page => {
      await page.locator('#input').fill('/');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Backspace');
      await page.waitForFunction(() => !controller.active);
      assert.equal(await page.evaluate(() => nativeInput), '');
      assert.equal(await page.locator('#input').inputValue(), '');
    });
    await scenario('browser completion and submission pass through the real native-menu adapter', async page => {
      let draft = '';
      const submitted = [];
      const writes = [];
      await page.exposeFunction('nativeBridge', async params => ({
        ok: true,
        result: await nativeMenu.interact(params, 'pi', async (args, raw) => {
          if (raw) return ['─────────────────────────────', draft + '\x1b[7m \x1b[27m', '─────────────────────────────', draft && !draft.includes(' ') ? '→ model     Choose model' : ''].join('\n');
          writes.push(args);
          if (args[1] === 'send-text') draft += args[3];
          else for (const key of args.slice(3)) {
            if (key === 'tab') draft = '/model ';
            if (key === 'backspace') draft = draft.slice(0, -1);
            if (key === 'enter') { submitted.push(draft); draft = ''; }
          }
        }),
      }));
      await page.evaluate(() => { controller.request = (method, params) => nativeBridge(params); });
      await page.locator('#input').fill('/m');
      await page.waitForFunction(() => !controller.session.opening);
      await page.locator('#input').press('Tab');
      await page.locator('#input').pressSequentially('hello');
      await page.locator('#input').press('Enter');
      await page.waitForFunction(() => !controller.active);
      assert.deepEqual(submitted, ['/model hello']);
      assert.equal(writes.filter(args => args.includes('enter')).length, 1);
      assert.equal(await page.locator('#input').inputValue(), '');
    });
  } finally { await browser.close(); }
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
