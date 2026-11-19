'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const menu = require('../node/native-menu.cjs');
const piScreen = (input, options = '→ model     Select model\n  settings  Edit settings') => `Prior transcript\n─────────────────────────────\n${input}\n─────────────────────────────\n${options}\n  (1/25)`;
const codexScreen = input => `Earlier /help example\n› ${input}\n  /model     Choose model\n❯ /review    Review changes\n  /skills    Project skills\nPress enter to select`;
const codexPlaceholder = '\x1b[0m\x1b[1m\x1b[48;2;66;67;72m›\x1b[0m\x1b[48;2;66;67;72m \x1b[0m\x1b[2m\x1b[48;2;66;67;72mAsk Codex to do anything\x1b[0m\x1b[48;2;66;67;72m     \x1b[0m';
test('Codex dim placeholder is an empty editor, while ordinary text remains a draft', async () => {
  const parsed = menu.parseScreen(codexPlaceholder, 'codex');
  assert.equal(parsed.input, '');
  assert.equal(parsed.recognized, true);
  let screen = codexPlaceholder;
  const writes = [];
  const opened = await menu.interact({ operation: 'open', text: '/', target: 'w1:p1' }, 'codex', async (args, raw) => {
    if (raw) return screen;
    writes.push(args);
    screen = codexScreen('/');
  });
  assert.equal(opened.input, '/');
  assert.equal(opened.options.length, 3);
  assert.deepEqual(writes, [['pane', 'send-text', 'w1:p1', '/']]);
  for (const draft of ['Ask Codex to do anything', '/review my changes']) {
    await assert.rejects(menu.interact({ operation: 'open', text: '/', target: 'w1:p1' }, 'codex', async (args, raw) => {
      if (raw) return '› ' + draft;
      assert.fail('Existing drafts must not receive input.');
    }), /not empty/);
  }
});
test('Codex uses the current editor below historical slash prompts', () => {
  const previous = '› /review\nPrevious response\n';
  assert.equal(menu.parseScreen(previous + codexPlaceholder, 'codex').input, '');
  assert.equal(menu.parseScreen(previous + '› /model', 'codex').input, '/model');
  assert.notEqual(menu.parseScreen(previous + '› keep this draft', 'codex').input, '/review');
});
test('Codex continuation and completion markers cannot replace its editor', async () => {
  const multiline = '› /review my changes\n  > ';
  assert.equal(menu.parseScreen(multiline, 'codex').input, '/review my changes');
  await assert.rejects(menu.interact({ operation: 'open', text: '/', target: 'w1:p1' }, 'codex', async (args, raw) => {
    if (raw) return multiline;
    assert.fail('A continuation row must not receive input.');
  }), /not empty/);
  const completion = '› /m\n❯ /model\n  /review    Review changes';
  const parsed = menu.parseScreen(completion, 'codex');
  assert.equal(parsed.input, '/m');
  assert.equal(parsed.selected, 0);
  assert.deepEqual(parsed.options.map(option => option.label), ['/model', '/review']);
  await assert.rejects(menu.interact({ operation: 'edit', expectedText: '/model', text: '/models', target: 'w1:p1' }, 'codex', async (args, raw) => {
    if (raw) return completion;
    assert.fail('An option label must not be used as the editor text.');
  }), /changed/);
});
test('Pi/OMP framed editor and selected bare labels project into a browser list', () => {
  for (const agent of ['pi', 'omp']) {
    const r = menu.parseScreen(piScreen('/m'), agent);
    assert.equal(r.input, '/m');
    assert.deepEqual(r.options.map(x => x.label), ['model', 'settings']);
    assert.equal(r.selected, 0);
    assert.equal(r.options[0].description, 'Select model');
  }
  const noisy = menu.parseScreen(piScreen('/m', 'user typed tokens\n→ model     Select model\n  settings  Edit settings\ncontext window'), 'pi');
  assert.deepEqual(noisy.options.map(x => x.label), ['model', 'settings']);
});
test('Codex, Claude and Cursor prompt rows keep slash prefixes and selection', () => {
  for (const agent of ['codex', 'claude', 'cursor']) {
    const r = menu.parseScreen(codexScreen('/'), agent);
    assert.equal(r.input, '/');
    assert.deepEqual(r.options.map(x => x.label), ['/model', '/review', '/skills']);
    assert.equal(r.selected, 1);
  }
  assert.equal(menu.parseScreen('An assistant mentions /model and /help', 'codex').recognized, false);
});
test('a key carries an unsent draft so Tab cannot complete the stale prefix', async () => {
  const writes = [];
  let text = piScreen('/');
  const r = await menu.interact({ operation: 'key', key: 'tab', draft: '/mo', expectedText: '/', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (raw) return text;
    writes.push(args);
    if (args[1] === 'send-text') text = piScreen('/mo');
    if (args.includes('tab')) text = piScreen('/model');
  });
  assert.deepEqual(writes.map(a => a[1]), ['send-text', 'send-keys']);
  assert.equal(writes[0][3], 'mo');
  assert.equal(r.input, '/model');
});

test('click selection re-reads the highlight and refuses Tab when it moved', async () => {
  let calls = 0;
  await assert.rejects(menu.interact({ operation: 'select', label: 'settings', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (!raw) return;
    calls++;
    return calls === 1 ? piScreen('/') : piScreen('/', '→ model     Select model\n  settings  Edit settings');
  }), /selection changed/);
});

test('Tab is a logical herdr key, returned input is authoritative', async () => {
  const writes = [];
  let text = piScreen('/m');
  const r = await menu.interact({ operation: 'key', key: 'tab', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (raw) return text;
    writes.push(args);
    text = piScreen('/model openai/gpt', '→ openai/gpt    Current provider');
  });
  assert.deepEqual(writes, [['pane', 'send-keys', 'w1:p1', 'tab']]);
  assert.equal(r.input, '/model openai/gpt');
});
test('clicking an observed option navigates then completes without pressing Enter', async () => {
  const writes = [];
  let selected = 0;
  await menu.interact({ operation: 'select', label: 'settings', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (raw) return piScreen('/', selected ? '  model     Select model\n→ settings  Edit settings' : undefined);
    writes.push(args);
    if (args.includes('down')) selected = 1;
  });
  assert.deepEqual(writes, [['pane', 'send-keys', 'w1:p1', 'down'], ['pane', 'send-keys', 'w1:p1', 'tab']]);
});
test('middle replacement is suffix editing with grapheme backspaces, never clear-line', async () => {
  const writes = [];
  let text = piScreen('/say 你😀', '');
  const r = await menu.interact({ operation: 'edit', expectedText: '/say 你😀', text: '/say 他', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (raw) return text;
    writes.push(args);
    if (args[1] === 'send-text') text = piScreen('/say 他', '');
  });
  assert.deepEqual(writes, [['pane', 'send-keys', 'w1:p1', 'backspace', 'backspace'], ['pane', 'send-text', 'w1:p1', '他']]);
  assert.equal(r.input, '/say 他');
});
test('cancel sends esc then backspaces only the owned command and stops on failure', async () => {
  const writes = [];
  let text = piScreen('/model');
  await menu.interact({ operation: 'cancel', expectedText: '/model', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (raw) return text;
    writes.push(args);
    if (args.includes('esc')) text = piScreen('/model', '');
  });
  assert.deepEqual(writes[0], ['pane', 'send-keys', 'w1:p1', 'esc']);
  assert.equal(writes[1].filter(k => k === 'backspace').length, 6);
  writes.length = 0;
  await assert.rejects(menu.interact({ operation: 'cancel', expectedText: '/model', target: 'w1:p1' }, 'pi', async (args, raw) => {
    if (raw) return piScreen('/model', '');
    writes.push(args);
    if (args.includes('backspace')) throw new Error('transport');
  }), /dismissing/);
  assert.equal(writes.filter(a => a.includes('backspace')).length, 1);
});

test('no writes when editor draft changed or menu is unrecognized', async () => {
  let writes = 0;
  const run = async (args, raw) => { if (raw) return piScreen('/someone-else'); writes++; };
  await assert.rejects(menu.interact({ operation: 'open', text: '/', target: 'w1:p1' }, 'pi', run), /not empty/);
  await assert.rejects(menu.interact({ operation: 'edit', text: '/m', expectedText: '/', target: 'w1:p1' }, 'pi', run), /changed/);
  assert.equal(writes, 0);
  assert.throws(() => menu.validate({ operation: 'edit', text: '/x\n/quit', expectedText: '/' }), /single line/);
});
