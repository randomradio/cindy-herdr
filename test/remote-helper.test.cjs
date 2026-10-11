'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runHerdrPrompt } = require('../node/remote-history.cjs');

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
