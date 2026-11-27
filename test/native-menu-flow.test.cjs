'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const menu = require('../node/native-menu.cjs');

const target = 'w1:p1';
const piScreen = (input, options = '', footer = '') =>
  ['─────────────────────────────', input, '─────────────────────────────', options, footer].join('\n');

test('Codex editor preserves repeated spaces instead of treating arguments as menu descriptions', () => {
  const result = menu.parseScreen('› /review  my changes\n  GPT context remaining', 'codex');
  assert.equal(result.recognized, true);
  assert.equal(result.input, '/review  my changes');
  assert.deepEqual(result.options, []);
});

test('an unsupported selection returns the current native suggestions without writing or throwing', async () => {
  const result = await menu.interact({ operation: 'select', label: 'missing', expectedText: '/', target }, 'pi', async (args, raw) => {
    if (raw) return piScreen('/', '→ model     Select model');
    assert.fail('An unavailable command must not send keys.');
  });
  assert.equal(result.ok, true);
  assert.equal(result.selectionChanged, true);
  assert.deepEqual(result.options.map(option => option.label), ['model']);
});

test('native Escape dismisses completion while preserving a resumed command draft', async () => {
  let input = '/model';
  let options = '→ model     Select model';
  const writes = [];
  const result = await menu.interact({ operation: 'cancel', expectedText: input, target }, 'pi', async (args, raw) => {
    if (raw) return piScreen(input, options);
    writes.push(args);
    for (const key of args.slice(3)) {
      if (key === 'esc') options = '';
      if (key === 'backspace') input = input.slice(0, -1);
    }
  });
  assert.equal(input, '/model');
  assert.equal(result.input, '/model');
  assert.deepEqual(writes, [['pane', 'send-keys', target, 'esc']]);
});

test('Pi selected-row ANSI preserves visible choices above the highlight', () => {
  const options = [
    '  model                           Select model',
    '\x1b[36m→ settings                        Edit settings\x1b[39m',
    '  help                            Show help',
  ].join('\n');
  const result = menu.parseScreen(piScreen('/', options), 'pi');
  assert.deepEqual(result.options.map(option => option.label), ['model', 'settings', 'help']);
  assert.equal(result.selected, 1);
});

test('Pi inverse cursor within a draft does not discard text after the cursor', () => {
  const result = menu.parseScreen(piScreen('/m\x1b[7mo\x1b[27mdel     '), 'pi');
  assert.equal(result.input, '/model');
});

test('editing after completion accounts for the observed trailing space', async () => {
  let input = '/model ';
  await menu.interact({ operation: 'edit', expectedText: '/model', text: '/mode', target }, 'pi', async (args, raw) => {
    if (raw) return piScreen(input + '\x1b[7m \x1b[27m');
    if (args[1] === 'send-text') input += args[3];
    for (const key of args.slice(3)) {
      if (args[1] === 'send-keys' && key === 'backspace') input = input.slice(0, -1);
    }
  });
  assert.equal(input, '/mode');
});

test('select waits for an arrow repaint before deciding the selection changed', async () => {
  const before = piScreen('/', '→ model     Select model\n  settings  Edit settings');
  const after = piScreen('/', '  model     Select model\n→ settings  Edit settings');
  let reads = 0;
  const writes = [];
  await menu.interact({ operation: 'select', label: 'settings', target }, 'pi', async (args, raw) => {
    if (raw) return ++reads <= 2 ? before : after;
    writes.push(args);
  });
  assert.deepEqual(writes, [
    ['pane', 'send-keys', target, 'down'],
    ['pane', 'send-keys', target, 'tab'],
  ]);
});

test('a footer repaint does not acknowledge Tab before the editor repaints', async () => {
  const screens = [
    piScreen('/m', '→ model     Select model', '1 token'),
    piScreen('/m', '→ model     Select model', '2 tokens'),
    piScreen('/model \x1b[7m \x1b[27m', '', '2 tokens'),
  ];
  let reads = 0;
  const writes = [];
  const result = await menu.interact({ operation: 'key', key: 'tab', target }, 'pi', async (args, raw) => {
    if (raw) return screens[Math.min(reads++, screens.length - 1)];
    writes.push(args);
  });
  assert.equal(result.input, '/model ');
  assert.deepEqual(writes, [['pane', 'send-keys', target, 'tab']]);
});
test('Enter is withheld when the native editor does not accept the pending draft', async () => {
  const writes = [];
  const result = await menu.interact({ operation: 'key', key: 'enter', expectedText: '/m', draft: '/model hello', target }, 'pi', async (args, raw) => {
    if (raw) return piScreen('/m', '→ model     Select model');
    writes.push(args);
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EDITOR_CHANGED');
  assert.equal(writes.some(args => args.includes('enter')), false);
});
