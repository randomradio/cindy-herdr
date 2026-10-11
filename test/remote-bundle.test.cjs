'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fakeHerdr(script) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.remote-bundle-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return { dir, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } };
}

function bundledHelper() {
  const previous = process.env.HERDR_EXPORT_FOR_TESTS;
  process.env.HERDR_EXPORT_FOR_TESTS = '1';
  const workerPath = require.resolve('../node/worker.cjs');
  delete require.cache[workerPath];
  try {
    return require(workerPath).REMOTE_HISTORY_SCRIPT_FOR_TESTS;
  } finally {
    delete require.cache[workerPath];
    if (previous === undefined) delete process.env.HERDR_EXPORT_FOR_TESTS;
    else process.env.HERDR_EXPORT_FOR_TESTS = previous;
  }
}

test('remote helper bundle emits JSON when run with node -e', () => {
  const fake = fakeHerdr(`
const args = process.argv.slice(2);
if (args.includes('api')) console.log(JSON.stringify({ result: { snapshot: { panes: [] } } }));
`);
  try {
    const stdout = execFileSync(process.execPath, [
      '-e', bundledHelper(), '--',
      JSON.stringify({ action: 'history', session: 'agents', target: 'w1:p1' }),
    ], { env: fake.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(stdout), { available: false, reason: 'The agent is no longer in this pane.' });
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});
