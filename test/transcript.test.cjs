'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const transcripts = require('../node/transcript.cjs');

function withTranscript(rows, fn) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.transcript-test-'));
  const file = path.join(dir, 'fixture.jsonl');
  try {
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return fn(file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function pi(id, role, content) {
  return { type: 'message', id, message: { role, content: [{ type: 'text', text: content }] } };
}
test('Claude, Codex and Pi project user, assistant and tool records', () => {
  assert.deepEqual(transcripts.project({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'reply' }] } }, 'claude', 1).map((e) => e.text), ['reply']);
  assert.deepEqual(transcripts.project({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } }, 'codex', 1).map((e) => e.text), ['reply']);
  assert.deepEqual(transcripts.project(pi('a', 'user', 'hello'), 'pi', 1).map((e) => e.role), ['user']);
  assert.equal(transcripts.project({ type: 'assistant', isSidechain: true, message: { content: 'internal' } }, 'claude', 1).length, 0);
});
test('OMP uses Pi-style blocks; Cursor uses role and message blocks', () => {
  assert.deepEqual(transcripts.project(pi('omp-1', 'assistant', 'OMP reply'), 'omp', 1).map((e) => e.text), ['OMP reply']);
  const cursor = { role: 'assistant', message: { content: [{ type: 'text', text: 'Cursor reply' }, { type: 'tool_use', name: 'read_file', input: { path: 'x' } }] } };
  assert.deepEqual(transcripts.project(cursor, 'cursor', 1).map((e) => e.type), ['text', 'tool']);
  assert.deepEqual(transcripts.supported, ['claude', 'codex', 'pi', 'omp', 'cursor']);
});
test('page cursors move strictly backward; tailing returns only newly complete lines', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => pi(`m${i}`, i % 2 ? 'assistant' : 'user', 'message ' + i));
  withTranscript(rows, (file) => {
    const tail = transcripts.read(file, 'pi');
    assert(tail.events.length < rows.length);
    assert(tail.has_older);
    const older = transcripts.read(file, 'pi', { identity: tail.identity, before: tail.previous });
    assert(older.previous < tail.previous);
    assert(older.events.length > 0);
    assert.equal(transcripts.read(file, 'pi', { identity: tail.identity, after: tail.next }).events.length, 0);
    fs.appendFileSync(file, JSON.stringify(pi('extra', 'user', 'late')) + '\n');
    const update = transcripts.read(file, 'pi', { identity: tail.identity, after: tail.next });
    assert.deepEqual(update.events.map((e) => e.text), ['late']);
  });
});
test('backward pagination retains every record across aligned and oversized lines', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => pi(`m${i}`, i % 2 ? 'assistant' : 'user', 'message ' + i));
  withTranscript(rows, (file) => {
    let page = transcripts.read(file, 'pi');
    const seen = new Set(page.events.map((e) => e.id));
    let pages = 1;
    while (page.has_older && pages < 40) {
      page = transcripts.read(file, 'pi', { identity: page.identity, before: page.previous });
      page.events.forEach((e) => seen.add(e.id));
      pages++;
    }
    assert.equal(seen.size, 2500);
  });
  withTranscript([], (file) => {
    const line = JSON.stringify(pi('a', 'user', 'ok'));
    const aligned = line + ' '.repeat(1023 - line.length) + '\n';
    fs.writeFileSync(file, Array.from({ length: 256 }, () => aligned.replace('"a"', '"a"')).join(''));
    assert.equal(transcripts.read(file, 'pi').events.length, 128);
  });
  withTranscript([pi('m0', 'user', 'start')], (file) => {
    const initial = transcripts.read(file, 'pi');
    fs.appendFileSync(file, JSON.stringify(pi('m1', 'user', 'Y'.repeat(150000))) + '\n' + JSON.stringify(pi('m2', 'user', 'end')) + '\n');
    const events = [];
    let next = initial.next;
    for (let i = 0; i < 20; i++) {
      const page = transcripts.read(file, 'pi', { identity: initial.identity, after: next });
      events.push(...page.events);
      if (page.next === next || !page.has_newer) break;
      next = page.next;
    }
    assert(events.some((e) => e.id === 'm1:0'));
    assert(events.some((e) => e.id === 'm2:0'));
  });
});
test('partial JSONL rows are retried after newline and never rendered early', () => {
  withTranscript([pi('one', 'user', 'complete')], (file) => {
    const row = JSON.stringify(pi('two', 'assistant', 'later'));
    fs.appendFileSync(file, row.slice(0, 12));
    const first = transcripts.read(file, 'pi');
    assert.deepEqual(first.events.map((e) => e.text), ['complete']);
    fs.appendFileSync(file, row.slice(12) + '\n');
    const next = transcripts.read(file, 'pi', { identity: first.identity, after: first.next });
    assert.deepEqual(next.events.map((e) => e.text), ['later']);
  });
});
