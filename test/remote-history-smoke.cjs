'use strict';
// Opt-in read-only integration test against an already configured herdr machine.
// Usage: HERDR_SMOKE_MACHINE=workmbp HERDR_SMOKE_SESSION=agents HERDR_SMOKE_PANE=w9:p1 node test/remote-history-smoke.cjs
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');

async function main() {
  const machine = process.env.HERDR_SMOKE_MACHINE;
  const session = process.env.HERDR_SMOKE_SESSION;
  const target = process.env.HERDR_SMOKE_PANE;
  if (!machine || !session || !target) throw new Error('Set HERDR_SMOKE_MACHINE, HERDR_SMOKE_SESSION and HERDR_SMOKE_PANE.');
  const worker = spawn(process.execPath, [path.join(__dirname, '..', 'node', 'worker.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => worker.kill(), 35000);
  try {
    worker.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat/history', params: { machine, session, target } }) + '\n');
    let buffer = '';
    for await (const chunk of worker.stdout) buffer += chunk;
    const reply = JSON.parse(buffer.trim());
    assert(!reply.error, reply.error?.message);
    const result = reply.result;
    console.log(JSON.stringify({ available: result.available, reason: result.reason, agent: result.agent, eventCount: result.events?.length, hasOlder: result.has_older, hasNewer: result.has_newer }));
    assert(result.available, result.reason);
    assert(result.events.length > 0, 'Expected at least one transcript event');
  } finally {
    clearTimeout(timer);
    worker.kill();
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
