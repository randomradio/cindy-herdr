'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const transcripts = require('../node/transcript.cjs');

function pi(id, role, content) {
  return { type: 'message', id, message: { role, content: [{ type: 'text', text: content }] } };
}

test('page read scans O(page) bytes for many small rows', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.transcript-io-'));
  const file = path.join(dir, 'many.jsonl');
  try {
    const rows = Array.from({ length: 800 }, (_, i) => pi(`m${i}`, 'user', 'x'.repeat(120)));
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const stats = { bytesRead: 0 };
    const page = transcripts.read(file, 'pi', { _stats: stats });
    assert.ok(page.events.length > 0);
    assert.ok(stats.bytesRead < transcripts.PAGE_BYTES * 3, `expected bounded IO, got ${stats.bytesRead}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('300KB tail record crossing page boundary is retained', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.transcript-io-'));
  const file = path.join(dir, 'big-tail.jsonl');
  try {
    const prefix = Array.from({ length: 400 }, (_, i) => pi(`p${i}`, 'user', 'fill ' + i));
    fs.writeFileSync(file, prefix.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const big = JSON.stringify(pi('big', 'user', 'Z'.repeat(300 * 1024))) + '\n';
    fs.appendFileSync(file, big + JSON.stringify(pi('after', 'user', 'tail')) + '\n');
    const tail = transcripts.read(file, 'pi');
    const ids = new Set(tail.events.map((e) => e.id));
    let page = tail;
    const all = new Set(ids);
    while (page.has_older) {
      page = transcripts.read(file, 'pi', { identity: page.identity, before: page.previous });
      page.events.forEach((e) => all.add(e.id));
    }
    assert.ok(all.has('big:0'), '300KB tail row must appear');
    assert.ok(all.has('after:0'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('over-cap partial line at EOF does not advance next cursor', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.transcript-io-'));
  const file = path.join(dir, 'partial-cap.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify(pi('one', 'user', 'ok')) + '\n');
    const first = transcripts.read(file, 'pi');
    const cap = transcripts.MAX_RECORD_BYTES + 64 * 1024;
    fs.appendFileSync(file, 'x'.repeat(cap));
    const partial = transcripts.read(file, 'pi', { identity: first.identity, after: first.next });
    assert.equal(partial.events.length, 0);
    assert.equal(partial.next, first.next);
    assert.equal(partial.has_newer, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
