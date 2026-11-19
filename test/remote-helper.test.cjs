'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runHerdrPrompt } = require('../node/remote-history.cjs');
const vm = require('node:vm');

function slashHelper(identity, status = 'idle') {
  const writes = [];
  const module = { exports: {} };
  const context = {
    module,
    process: { argv: ['node', 'remote-history.cjs', JSON.stringify({ action: 'slash', session: 'agents', target: 'w1:p1', identity, text: '/' })] },
    require(name) {
      if (name === './native-menu.cjs') return require('../node/native-menu.cjs');
      if (name === './transcript.cjs') return {
        supported: ['pi'], resolve: () => '/fixture/log.jsonl', fileIdentity: () => 'expected-id',
      };
      if (name === 'node:child_process') return { execFileSync(bin, args) {
        if (args.includes('snapshot')) return JSON.stringify({ result: { snapshot: { panes: [{ pane_id: 'w1:p1', agent: 'pi', agent_status: status }] } } });
        writes.push(args);
        return '';
      } };
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../node/remote-history.cjs'), 'utf8'), context);
  return { main: module.exports.main, writes };
}

function menuHelper(identity, operation = 'read', status = 'idle') {
  const writes = [];
  const module = { exports: {} };
  const context = {
    module,
    process: { argv: ['node', 'remote-history.cjs', JSON.stringify({ action: 'menu', session: 'agents', target: 'w1:p1', identity, operation, text: '/' })] },
    require(name) {
      if (name === './native-menu.cjs') return {
        validate() { if (operation === 'bad') throw new Error('Invalid command menu operation.'); },
        async interact() { writes.push('interact'); if (operation === 'explode') throw new Error('internal stack /secret'); if (operation === 'known') throw new Error('The agent input changed.'); return { ok: true, input: '/', options: [], selected: -1, recognized: true }; },
      };
      if (name === './transcript.cjs') return {
        supported: ['pi'], resolve: () => '/fixture/log.jsonl', fileIdentity: () => 'expected-id',
      };
      if (name === 'node:child_process') return { execFileSync() {
        return JSON.stringify({ result: { snapshot: { panes: [{ pane_id: 'w1:p1', agent: 'pi', agent_status: status }] } } });
      } };
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../node/remote-history.cjs'), 'utf8'), context);
  return { main: module.exports.main, writes };
}

test('remote menu returns controlled errors and does not write on mismatch', async () => {
  const stale = menuHelper('stale-id', 'open');
  assert.equal((await stale.main()).code, 'SESSION_MISMATCH');
  assert.equal(stale.writes.length, 0);
  const busy = menuHelper('expected-id', 'open', 'working');
  assert.equal((await busy.main()).code, 'AGENT_NOT_READY');
  const bad = await menuHelper('expected-id', 'bad').main();
  assert.equal(bad.code, 'MENU_FAILED');
  assert.equal(bad.message, 'Invalid command menu operation.');
  const boom = await menuHelper('expected-id', 'explode').main();
  assert.equal(boom.ok, false);
  assert.equal(boom.message, 'Command menu request failed. Open Terminal to check the agent.');
  assert.equal((await menuHelper('expected-id', 'known').main()).message, 'The agent input changed.');
  const ready = menuHelper('expected-id', 'read');
  assert.equal((await ready.main()).ok, true);
});

test('remote slash checks identity and agent readiness before typing', async () => {
  const stale = slashHelper('stale-id');
  assert.equal((await stale.main()).code, 'SESSION_MISMATCH');
  assert.equal(stale.writes.length, 0);
  const busy = slashHelper('expected-id', 'working');
  assert.equal((await busy.main()).code, 'AGENT_NOT_READY');
  assert.equal(busy.writes.length, 0);
  const ready = slashHelper('expected-id');
  assert.equal((await ready.main()).ok, true);
  assert.deepEqual(Array.from(ready.writes[0]), ['--session', 'agents', 'pane', 'send-text', 'w1:p1', '/']);
});

function withFakeHerdr(output, code, fn) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.remote-helper-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${code});\n`);
  fs.chmodSync(bin, 0o755);
  const original = process.env.PATH;
  process.env.PATH = dir + path.delimiter + original;
  try { fn(); } finally {
    process.env.PATH = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runHerdrPrompt validates a zero-exit JSON response', () => {
  withFakeHerdr(JSON.stringify({ error: { code: 'AGENT_BLOCKED', message: 'needs input' } }), 0, () => {
    const out = runHerdrPrompt('agents', 'w1:p1', 'hello');
    assert.deepEqual(out, { ok: false, code: 'AGENT_BLOCKED', message: 'needs input' });
  });
  withFakeHerdr(JSON.stringify({ result: { type: 'agent_prompted' } }), 0, () => {
    assert.deepEqual(runHerdrPrompt('agents', 'w1:p1', 'hello'), { ok: true });
  });
});

test('runHerdrPrompt parses JSON failure from herdr stdout', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.remote-helper-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({ code: 'AGENT_BLOCKED', message: 'needs input' }));
process.exit(1);
`);
  fs.chmodSync(bin, 0o755);
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
  const orig = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    const out = runHerdrPrompt('agents', 'w1:p1', 'hello');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'AGENT_BLOCKED');
  } finally {
    process.env.PATH = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native slash types the prefix without pressing Enter or submitting a prompt', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.remote-helper-'));
  const original = process.env.PATH;
  const log = path.join(dir, 'argv.json');
  try {
    fs.writeFileSync(path.join(dir, 'herdr'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    fs.chmodSync(path.join(dir, 'herdr'), 0o755);
    process.env.PATH = dir + path.delimiter + original;
    assert.equal(runHerdrPrompt('agents', 'w1:p1', '/model', true).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(log)), ['--session', 'agents', 'pane', 'send-text', 'w1:p1', '/model']);
  } finally {
    process.env.PATH = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remote helper prompt rejects missing pane with ok false', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.remote-helper-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[2] === 'api') {
  console.log(JSON.stringify({ result: { snapshot: { panes: [] } } }));
  process.exit(0);
}
process.exit(0);
`);
  fs.chmodSync(bin, 0o755);
  const script = path.join(__dirname, '../node/remote-history.cjs');
  const payload = JSON.stringify({ action: 'prompt', session: 'agents', target: 'w1:p1', identity: 'abc', text: 'hi' });
  try {
    const stdout = execFileSync(process.execPath, [script, payload], {
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
      encoding: 'utf8',
    });
    const body = JSON.parse(stdout);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'UNAVAILABLE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
