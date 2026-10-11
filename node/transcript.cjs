'use strict';
// Read only the transcript herdr identifies for the selected local agent pane.
// No arbitrary paths from the page; all cursors are byte offsets bound to this file's identity.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PAGE_BYTES = 128 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_TEXT = 24000;
const MAX_TOOL = 4000;
const roots = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  codex: path.join(os.homedir(), '.codex', 'sessions'),
  pi: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  omp: path.join(os.homedir(), '.omp', 'agent', 'sessions'),
  cursor: path.join(os.homedir(), '.cursor', 'projects'),
};
const supported = Object.freeze(Object.keys(roots));
const pathCache = new Map();
function within(file, root) { return file.startsWith(root + path.sep); }
function findId(root, id) {
  const key = root + ':' + id;
  const cached = pathCache.get(key);
  if (cached && Date.now() - cached.at < 30000 && fs.existsSync(cached.file)) return cached.file;
  const dirs = [root];
  const matches = [];
  let visited = 0;
  while (dirs.length && visited++ < 20000 && matches.length < 2) {
    const dir = dirs.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.jsonl') && (e.name === `${id}.jsonl` || e.name.endsWith(`-${id}.jsonl`) || e.name.endsWith(`_${id}.jsonl`))) matches.push(path.join(dir, e.name));
    }
  }
  if (matches.length !== 1) return null;
  pathCache.set(key, { file: matches[0], at: Date.now() });
  return matches[0];
}
function findCursorId(root, id) {
  const key = root + ':' + id;
  const cached = pathCache.get(key);
  if (cached && Date.now() - cached.at < 30000 && fs.existsSync(cached.file)) return cached.file;
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const matches = [];
  // The project listing is shallow. Never traverse SDK stores, subagents or
  // unrelated directories just to look up a Cursor conversation.
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const file = path.join(root, project.name, 'agent-transcripts', id, id + '.jsonl');
    try { if (fs.statSync(file).isFile()) matches.push(file); } catch {}
    if (matches.length > 1) return null;
  }
  if (matches.length !== 1) return null;
  pathCache.set(key, { file: matches[0], at: Date.now() });
  return matches[0];
}
function resolve(session, agent) {
  const root = roots[agent];
  if (!root || !session || session.agent !== agent) return null;
  let file;
  if (session.kind === 'path' && typeof session.value === 'string' && path.isAbsolute(session.value)) file = session.value;
  else if (session.kind === 'id' && /^[\w-]{10,100}$/.test(session.value || '')) {
    file = agent === 'cursor' ? findCursorId(root, session.value) : findId(root, session.value);
  }
  if (!file || !file.endsWith('.jsonl')) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    if (!within(real, realRoot) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}
// Older herdr integrations may know the live pane but not its transcript id.
// Match only a newly launched Codex process to a unique session_meta record:
// same cwd and creation timestamp within 15 seconds of that process start.
// Resumed sessions, ambiguous matches and missing process metadata stay unavailable.
function resolveOmpProcess(pid, cwd) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let launched;
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2500 }).trim();
    launched = new Date(raw).getTime();
  } catch { return null; }
  if (!Number.isFinite(launched)) return null;
  const root = roots.omp;
  // Session folders reflect the working directory (Pi-compatible layout).
  // Check only the exact cwd folder and adjacent launch dates.
  const home = os.homedir();
  const rel = cwd === home ? '' : cwd.startsWith(home + path.sep) ? cwd.slice(home.length) : cwd;
  const sessionDir = path.join(root, rel.replaceAll(path.sep, '-'));
  let entries;
  try { entries = fs.readdirSync(sessionDir, { withFileTypes: true }); } catch { return null; }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z_[\w-]+\.jsonl$/.exec(entry.name);
    if (!m) continue;
    const created = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (Math.abs(created - launched) > 15000) continue;
    const file = path.join(sessionDir, entry.name);
    let head;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(PAGE_BYTES);
        const size = fs.readSync(fd, buf, 0, buf.length, 0);
        let start = 0;
        for (let i = 0; i < 4 && start < size; i++) {
          const end = buf.indexOf(10, start);
          if (end < 0 || end >= size) break;
          const record = JSON.parse(buf.toString('utf8', start, end));
          if (record.type === 'session') { head = record; break; }
          start = end + 1;
        }
      } finally { fs.closeSync(fd); }
      if (head?.type !== 'session' || head.cwd !== cwd || Math.abs(Date.parse(head.timestamp) - launched) > 15000) continue;
      const real = fs.realpathSync(file);
      if (within(real, fs.realpathSync(root)) && fs.statSync(real).isFile()) matches.push(real);
    } catch {}
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0] : null;
}
function resolveCodexProcess(pid, cwd, launchedAt) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let launched = launchedAt;
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2500 }).trim();
    const actual = new Date(raw).getTime();
    if (!Number.isFinite(actual) || launched !== undefined && Math.abs(actual - launched) > 1000) return null;
    launched = actual;
  } catch { return null; }
  if (!Number.isFinite(launched)) return null;
  const root = roots.codex;
  // The JSONL filename includes the local calendar date. Scan only the launch
  // day and its two neighbours (midnight/time-zone boundary), not all history.
  const dirs = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(launched + offset * 86400000);
    const day = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    dirs.push(day);
  }
  const matches = [];
  let visited = 0;
  while (dirs.length && visited++ < 3 && matches.length < 2) {
    const dir = dirs.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (!entry.isFile()) continue;
      const namedAt = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-[\w-]+\.jsonl$/.exec(entry.name);
      if (!namedAt) continue;
      const [, year, month, day, hour, minute, second] = namedAt;
      const filenameTime = new Date(+year, +month - 1, +day, +hour, +minute, +second).getTime();
      if (!Number.isFinite(filenameTime) || Math.abs(filenameTime - launched) > 15000) continue;
      let head;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          // Codex's first session_meta row can include a large CLI configuration.
          // Bound the probe to one transcript page; skip larger/partial records.
          const buf = Buffer.alloc(PAGE_BYTES);
          const size = fs.readSync(fd, buf, 0, buf.length, 0);
          const end = buf.indexOf(10);
          if (end < 0 || end >= size) continue;
          head = JSON.parse(buf.toString('utf8', 0, end));
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      if (head.type !== 'session_meta' || head.payload?.cwd !== cwd) continue;
      const created = Date.parse(head.timestamp);
      if (!Number.isFinite(created) || Math.abs(created - launched) > 15000) continue;
      try {
        const realRoot = fs.realpathSync(root);
        const realFile = fs.realpathSync(file);
        if (within(realFile, realRoot) && fs.statSync(realFile).isFile()) matches.push(realFile);
      } catch {}
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
function brief(value, limit = MAX_TEXT) { return String(value || '').slice(0, limit); }
function stringify(value, limit = MAX_TOOL) {
  if (typeof value === 'string') return brief(value, limit);
  try { return brief(JSON.stringify(value), limit); } catch { return ''; }
}
function blocks(content, prefix, timestamp) {
  if (typeof content === 'string') return [{ id: prefix + ':text', type: 'text', text: brief(content), timestamp }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b, i) => {
    if (!b || typeof b !== 'object') return [];
    const id = prefix + ':' + i;
    if (['text', 'input_text', 'output_text'].includes(b.type)) return [{ id, type: 'text', text: brief(b.text), timestamp }];
    if (b.type === 'thinking') return [{ id, type: 'thinking', text: brief(b.thinking), timestamp }];
    if (b.type === 'tool_use' || b.type === 'toolCall') return [{ id, type: 'tool', name: brief(b.name, 120), text: stringify(b.input ?? b.arguments), timestamp }];
    if (b.type === 'tool_result') return [{ id, type: 'result', text: stringify(b.content), timestamp }];
    return [];
  });
}
function project(row, agent, lineOffset) {
  const id = String(row.uuid || row.id || lineOffset);
  const timestamp = row.timestamp || row.message?.timestamp || null;
  if (agent === 'claude') {
    if (row.isSidechain || !['user', 'assistant'].includes(row.type)) return [];
    const m = row.message || {};
    if (row.type === 'user' && !Array.isArray(m.content) && typeof m.content !== 'string') return [];
    return blocks(m.content, id, timestamp).map((v) => ({ ...v, role: row.type }));
  }
  if (agent === 'cursor') {
    if (!['user', 'assistant'].includes(row.role)) return [];
    return blocks(row.message?.content, id, timestamp).map((v) => ({ ...v, role: row.role }));
  }
  if (agent === 'pi' || agent === 'omp') {
    if (row.type !== 'message') return [];
    const m = row.message || {};
    if (!['user', 'assistant', 'toolResult'].includes(m.role)) return [];
    if (m.role === 'toolResult') return [{ id, type: 'result', role: 'assistant', name: brief(m.toolName, 120), text: stringify(m.content), timestamp }];
    return blocks(m.content, id, timestamp).map((v) => ({ ...v, role: m.role }));
  }
  if (agent === 'codex') {
    if (row.type !== 'response_item') return [];
    const p = row.payload || {};
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      return blocks(p.content, id, timestamp).map((v) => ({ ...v, role: p.role }));
    }
    if (p.type === 'reasoning' && Array.isArray(p.summary)) return p.summary.flatMap((s, i) => blocks([s], id + ':reasoning:' + i, timestamp)).map((v) => ({ ...v, type: 'thinking', role: 'assistant' }));
    if (p.type === 'function_call' || p.type === 'custom_tool_call') return [{ id, type: 'tool', role: 'assistant', name: brief(p.name, 120), text: stringify(p.arguments ?? p.input), timestamp }];
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return [{ id, type: 'result', role: 'assistant', text: stringify(p.output), timestamp }];
  }
  return [];
}
function fileIdentity(file) {
  const stat = fs.statSync(file);
  return crypto.createHash('sha256').update(file + ':' + stat.dev + ':' + stat.ino).digest('hex').slice(0, 20);
}
function createIo(fd, stats) {
  return {
    read(pos, len) {
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      const slice = buf.subarray(0, n);
      if (stats) stats.bytesRead += slice.length;
      return slice;
    },
    byteAt(pos) {
      if (pos < 0) return -1;
      const b = this.read(pos, 1);
      return b.length ? b[0] : -1;
    },
  };
}
function lineStartAt(io, pos) {
  if (pos <= 0) return 0;
  if (io.byteAt(pos - 1) === 10) return pos;
  const back = Math.min(pos, MAX_RECORD_BYTES);
  const buf = io.read(pos - back, back);
  const rel = buf.lastIndexOf(10);
  return rel < 0 ? pos - back : pos - back + rel + 1;
}
function oversizedMarker(lineStart, bytes, lineEnd) {
  const kb = Math.round(bytes / 1024);
  const end = lineEnd ?? lineStart + bytes + 1;
  return [{
    id: 'oversized:' + lineStart,
    type: 'oversized',
    role: 'assistant',
    text: `Transcript line at byte ${lineStart} is about ${kb} KB and exceeds the ${Math.round(MAX_RECORD_BYTES / 1024)} KB load cap. The on-disk log is unchanged.`,
    byte: lineStart,
    endByte: end,
    bytes,
  }];
}
function withByte(events, lineStart, lineEnd) {
  return events.map((e) => ({ ...e, byte: lineStart, endByte: lineEnd }));
}
function readCompleteLine(io, size, lineStart) {
  let pos = lineStart;
  const parts = [];
  let scanned = 0;
  let step = 4096;
  while (pos < size) {
    const take = Math.min(step, size - pos, PAGE_BYTES);
    const chunk = io.read(pos, take);
    if (!chunk.length) break;
    const nl = chunk.indexOf(10);
    if (nl >= 0) {
      parts.push(chunk.subarray(0, nl));
      const line = Buffer.concat(parts);
      const end = pos + nl + 1;
      return { line, end, overCap: line.length > MAX_RECORD_BYTES };
    }
    parts.push(chunk);
    scanned += chunk.length;
    pos += chunk.length;
    step = Math.min(step * 2, PAGE_BYTES);
    if (scanned > MAX_RECORD_BYTES) {
      while (pos < size) {
        const skip = io.read(pos, Math.min(PAGE_BYTES, size - pos));
        const nlx = skip.indexOf(10);
        if (nlx >= 0) return { line: Buffer.alloc(0), end: pos + nlx + 1, overCap: true, bytes: scanned };
        pos += skip.length;
        if (!skip.length) break;
      }
      return { partial: true, next: lineStart };
    }
  }
  return { partial: true, next: lineStart };
}
function parseLine(agent, lineStart, line, lineEnd, overCap, bytes) {
  if (overCap) return oversizedMarker(lineStart, bytes || line.length, lineEnd);
  if (line.length > MAX_RECORD_BYTES) return oversizedMarker(lineStart, line.length, lineEnd);
  try { return withByte(project(JSON.parse(line.toString('utf8')), agent, lineStart), lineStart, lineEnd); }
  catch { return []; }
}
function read(file, agent, opts = {}) {
  const stat = fs.statSync(file);
  const identity = fileIdentity(file);
  let before = opts.before;
  let after = opts.after;
  if (opts.identity !== identity) { before = undefined; after = undefined; }
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0 || before > stat.size)) before = undefined;
  const reset = after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > stat.size);
  if (reset) after = undefined;
  const size = stat.size;
  const afterCursor = after;
  let windowEnd = before !== undefined ? before : size;
  if (afterCursor !== undefined) windowEnd = Math.min(size, afterCursor + PAGE_BYTES);
  const windowStart = afterCursor !== undefined ? afterCursor : Math.max(0, (before !== undefined ? before : size) - PAGE_BYTES);
  const fd = fs.openSync(file, 'r');
  const stats = opts._stats || null;
  const io = createIo(fd, stats);
  const events = [];
  let firstLine = null;
  let lastComplete = afterCursor !== undefined ? afterCursor : 0;
  let partialAt = null;
  try {
    const alignedStart = lineStartAt(io, afterCursor !== undefined ? afterCursor : windowStart);
    const tailStart = afterCursor === undefined && before === undefined
      ? Math.max(alignedStart, lineStartAt(io, windowStart))
      : alignedStart;
    const spanEnd = before !== undefined ? before : (afterCursor !== undefined ? windowEnd : size);
    const windowBuf = spanEnd > tailStart ? io.read(tailStart, spanEnd - tailStart) : Buffer.alloc(0);
    let rel = 0;
    if (tailStart > 0 && io.byteAt(tailStart - 1) !== 10) {
      const nl = windowBuf.indexOf(10);
      rel = nl < 0 ? windowBuf.length : nl + 1;
    }
    while (rel < windowBuf.length) {
      const nl = windowBuf.indexOf(10, rel);
      if (nl < 0) {
        const lineStart = tailStart + rel;
        if (lineStart >= size) break;
        if (spanEnd >= size) {
          partialAt = lineStart;
          break;
        }
        const extended = readCompleteLine(io, size, lineStart);
        if (extended.partial) { partialAt = lineStart; break; }
        if (afterCursor !== undefined && extended.end <= afterCursor) {
          rel = windowBuf.length;
          continue;
        }
        if (before !== undefined && lineStart >= before) break;
        if (firstLine === null) firstLine = lineStart;
        events.push(...parseLine(agent, lineStart, extended.line, extended.end, extended.overCap, extended.bytes));
        lastComplete = extended.end;
        break;
      }
      const lineStart = tailStart + rel;
      if (before !== undefined && lineStart >= before) break;
      if (afterCursor !== undefined && lineStart + (nl - rel) + 1 <= afterCursor) {
        rel = nl + 1;
        continue;
      }
      const line = windowBuf.subarray(rel, nl);
      const lineEnd = lineStart + line.length + 1;
      if (firstLine === null) firstLine = lineStart;
      events.push(...parseLine(agent, lineStart, line, lineEnd, false));
      lastComplete = lineEnd;
      rel = nl + 1;
    }
  } finally { fs.closeSync(fd); }
  const rangeStart = firstLine === null ? (afterCursor !== undefined ? afterCursor : windowStart) : firstLine;
  let next = partialAt !== null ? partialAt : lastComplete;
  if (!events.length && afterCursor !== undefined && partialAt === null) next = afterCursor;
  const previous = rangeStart;
  const has_older = rangeStart > 0;
  const has_newer = partialAt !== null ? true : next < size;
  return {
    identity, events, reset,
    next,
    previous,
    rangeStart,
    rangeEnd: partialAt !== null ? partialAt : lastComplete,
    has_older,
    has_newer,
  };
}
module.exports = { supported, resolve, resolveCodexProcess, resolveOmpProcess, read, project, fileIdentity, PAGE_BYTES, MAX_RECORD_BYTES };
