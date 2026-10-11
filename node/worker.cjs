'use strict';
// herdr bridge worker for Cindy.
// Runs a fixed allowlist of herdr subcommands, locally via execFile (no shell)
// or on a saved herdr SSH machine via `ssh -o BatchMode=yes <target> <quoted cmd>`.
// stdout is reserved for JSON-RPC; diagnostics go to stderr.

const readline = require('node:readline');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transcripts = require('./transcript.cjs');
const { assertRemotePromptBody } = require('./prompt-guard.cjs');
// The plugin is installed locally, so send a bundled one-shot helper to Node
// on the saved SSH machine. The remote machine needs Node but no installed files.
const REMOTE_HISTORY_SCRIPT = (() => {
  const library = fs.readFileSync(path.join(__dirname, 'transcript.cjs'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, 'remote-history.cjs'), 'utf8')
    .replace("const transcripts = require('./transcript.cjs');", '');
  return `globalThis.__HERDR_REMOTE_HELPER__ = true;\nconst transcripts = (() => { const module = { exports: {} }; (function(module, require) { ${library}\n })(module, require); return module.exports; })();\n${helper}`;
})();

const MAX_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function log(...args) {
  process.stderr.write('[herdr-worker] ' + args.join(' ') + '\n');
}

// ---------- herdr binary discovery ----------
// Cindy's Node runtime may not inherit the login-shell PATH.
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), '.cargo/bin'),
  '/usr/bin',
  '/bin',
];
const ENV_PATH = Array.from(
  new Set([...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...EXTRA_PATHS]),
).join(path.delimiter);

function findBinary(name) {
  for (const dir of ENV_PATH.split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// Remote PATH prefix: non-interactive ssh shells often miss Homebrew/local bins.
const REMOTE_PATH_PREFIX =
  'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"; export PATH; ';

// ---------- validation ----------
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/; // workspace/tab/pane ids, agent names
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_RE = /^[A-Za-z0-9+_-]{1,32}$/;
const SSH_TARGET_RE = /^[A-Za-z0-9._@:\[\]-]{1,255}$/;
const STATES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const SOURCES = new Set(['visible', 'recent', 'recent-unwrapped', 'detection']);
const AGENT_KINDS = new Set([
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode',
  'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli',
  'qwen', 'maki', 'muse',
]);

class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function req(params, key) {
  const v = params[key];
  if (v === undefined || v === null || v === '') throw new UserError('INVALID_ARGS', `Missing "${key}".`);
  return v;
}
function str(v, re, label) {
  if (typeof v !== 'string' || !re.test(v)) throw new UserError('INVALID_ARGS', `Invalid ${label}: ${JSON.stringify(v)}`);
  return v;
}
// herdr's CLI rejects positional values that start with "-" and has no "--" separator.
function positionalText(v, label, max = 100000) {
  if (typeof v !== 'string' || v.length === 0) throw new UserError('INVALID_ARGS', `Missing ${label}.`);
  if (v.length > max) throw new UserError('INVALID_ARGS', `${label} is too long (max ${max} chars).`);
  if (v.startsWith('-')) {
    throw new UserError('INVALID_ARGS', `${label} cannot start with "-" (herdr CLI limitation); add a leading space or rephrase.`);
  }
  return v;
}
function posInt(v, label, min, max) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError('INVALID_ARGS', `${label} must be an integer in ${min}..${max}.`);
  return n;
}
// A folder relative to the home directory of whichever machine runs herdr.
// herdr does not expand "~", so the worker expands it locally and the remote shell expands $HOME.
class HomePath {
  constructor(rel) {
    this.rel = rel;
  }
}
function folderArg(v, label) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 4096 || /[\0\n\r]/.test(v)) {
    throw new UserError('INVALID_ARGS', `${label} must be an absolute path or start with ~/.`);
  }
  const t = v.trim();
  if (t === '~') return new HomePath('');
  if (t.startsWith('~/')) return new HomePath(t.slice(2).replace(/\/+$/, ''));
  if (t.startsWith('/')) return t.length > 1 ? t.replace(/\/+$/, '') : t;
  throw new UserError('INVALID_ARGS', `${label} must be an absolute path or start with ~/.`);
}
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
function branchArg(v, label) {
  str(v, BRANCH_RE, label);
  if (v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) throw new UserError('INVALID_ARGS', `Invalid ${label}: ${JSON.stringify(v)}`);
  return v;
}
function labelArg(v, label = 'label') {
  if (typeof v !== 'string') throw new UserError('INVALID_ARGS', `${label} must be text.`);
  const t = v.replace(/[\0-\x1f\x7f]/g, ' ').trim();
  if (!t) throw new UserError('INVALID_ARGS', `Missing ${label}.`);
  return positionalText(t, label, 80);
}

// ---------- machine resolution ----------
let machineCache = { at: 0, list: null };

async function listMachines() {
  if (machineCache.list && Date.now() - machineCache.at < 30000) return machineCache.list;
  const res = await runLocal(['machine', 'list', '--json'], 10000);
  let list = [];
  try {
    list = JSON.parse(res.stdout || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  machineCache = { at: Date.now(), list };
  return list;
}

async function resolveMachine(machine) {
  if (machine === undefined || machine === null || machine === '' || machine === 'local') {
    return { kind: 'local', label: 'local' };
  }
  if (typeof machine !== 'string') throw new UserError('INVALID_ARGS', 'machine must be a string.');
  const list = await listMachines();
  const hit = list.find((m) => m && (m.label === machine || m.id === machine || m.target === machine));
  if (!hit) {
    const known = list.map((m) => m.label).filter(Boolean);
    throw new UserError(
      'MACHINE_NOT_FOUND',
      `No saved herdr machine named "${machine}". Known: ${known.length ? known.join(', ') : '(none)'}; use "local" for this computer. Add one with \`herdr machine add\`.`,
    );
  }
  if (hit.enabled === false) throw new UserError('MACHINE_DISABLED', `herdr machine "${hit.label}" is disabled.`);
  str(hit.target, SSH_TARGET_RE, 'ssh target');
  return { kind: 'ssh', label: hit.label, target: hit.target, defaultSession: hit.session };
}

// ---------- execution ----------
function runLocal(args, timeoutMs) {
  const bin = findBinary('herdr');
  if (!bin) {
    return Promise.reject(new UserError('HERDR_NOT_FOUND', 'herdr is not installed on this computer (looked in PATH, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin).'));
  }
  return execCapture(bin, args, timeoutMs);
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Unix socket paths are limited to ~104 bytes on macOS; %C expands to 40 hex chars.
let controlDirCache;
function sshControlDir() {
  if (controlDirCache !== undefined) return controlDirCache;
  controlDirCache = null;
  for (const dir of [path.join(os.homedir(), '.ssh', 'cindy-herdr'), path.join('/tmp', `cindy-herdr-${process.getuid ? process.getuid() : 'u'}`)]) {
    if (dir.length + 42 >= 100) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = fs.statSync(dir);
      if (st.isDirectory() && (!process.getuid || st.uid === process.getuid()) && (st.mode & 0o077) === 0) {
        controlDirCache = dir;
        break;
      }
    } catch {}
  }
  return controlDirCache;
}

function remoteArg(a) {
  if (a instanceof HomePath) return a.rel ? '"$HOME"/' + shQuote(a.rel) : '"$HOME"';
  return shQuote(a);
}

function runSshCommand(target, remoteCmd, timeoutMs) {
  const ssh = findBinary('ssh');
  if (!ssh) return Promise.reject(new UserError('SSH_NOT_FOUND', 'ssh is not available on this computer.'));
  const sshArgs = ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15'];
  const controlDir = sshControlDir();
  if (controlDir) {
    // Reuse one connection for repeated page refreshes / tool calls, and keep it
    // warm long enough that reopening the herdr page skips the SSH handshake.
    sshArgs.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/%C`, '-o', 'ControlPersist=600');
  }
  sshArgs.push('-T', target, remoteCmd);
  return execCapture(ssh, sshArgs, timeoutMs).then((res) => {
    if (res.code === 255 && !res.stdout) {
      throw new UserError('SSH_FAILED', `SSH to ${target} failed: ${res.stderr.trim().slice(0, 500) || 'exit 255'}. Check that passwordless SSH works (BatchMode).`);
    }
    return res;
  });
}
function runSsh(target, args, timeoutMs) {
  const remoteCmd = REMOTE_PATH_PREFIX + ['herdr', ...args].map(remoteArg).join(' ');
  return runSshCommand(target, remoteCmd, timeoutMs).then((res) => {
    if (res.code === 127) throw new UserError('HERDR_NOT_FOUND', `herdr was not found on ${target}.`);
    return res;
  });
}

function execCapture(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, PATH: ENV_PATH, NO_COLOR: '1' },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new UserError('TIMEOUT', `herdr command timed out after ${timeoutMs} ms.`));
          return;
        }
        if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new UserError('OUTPUT_TOO_LARGE', 'herdr output exceeded 4 MB; request fewer lines.'));
          return;
        }
        if (err && typeof err.code !== 'number' && err.code !== undefined) {
          reject(new UserError('EXEC_FAILED', String(err.message || err)));
          return;
        }
        resolve({ code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

// herdr returns JSON on stdout for success and (often) for errors too; syntax errors are plain text.
function parseHerdr(res) {
  const text = (res.stdout || '').trim();
  let json = null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  const errText = (res.stderr || '').trim();
  if (!json && errText.startsWith('{')) {
    try {
      json = JSON.parse(errText);
    } catch {}
  }
  if (json && json.error) {
    throw new UserError(String(json.error.code || 'HERDR_ERROR').toUpperCase(), String(json.error.message || 'herdr error'));
  }
  if (json) return json.result !== undefined ? json.result : json;
  if (res.code !== 0) {
    throw new UserError('HERDR_ERROR', (errText || text || `herdr exited with ${res.code}`).slice(0, 2000));
  }
  return { text: res.stdout };
}

async function herdr(params, args, { timeoutMs = DEFAULT_TIMEOUT_MS, useSession = true, raw = false } = {}) {
  const machine = await resolveMachine(params.machine);
  const session = params.session === undefined || params.session === null || params.session === ''
    ? (machine.kind === 'ssh' ? machine.defaultSession : undefined)
    : str(params.session, SESSION_RE, 'session');
  const withSession = useSession && session ? ['--session', session, ...args] : args;
  let res;
  if (machine.kind === 'ssh') {
    res = await runSsh(machine.target, withSession, timeoutMs);
  } else {
    const full = withSession.map((a) => (a instanceof HomePath ? path.join(os.homedir(), a.rel) : a));
    for (const a of withSession) {
      if (a instanceof HomePath) assertLocalFolder(path.join(os.homedir(), a.rel));
    }
    res = await runLocal(full, timeoutMs);
  }
  if (raw) {
    if (res.code !== 0) parseHerdr(res);
    return { machine: machine.label, session: session || 'default', text: res.stdout };
  }
  const result = parseHerdr(res);
  return { machine: machine.label, session: session || 'default', result };
}

// herdr silently falls back to the home folder when --cwd does not exist; fail loudly instead.
function assertLocalFolder(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new UserError('FOLDER_NOT_FOUND', `Folder not found on this computer: ${p}`);
  }
  if (!st.isDirectory()) throw new UserError('FOLDER_NOT_FOUND', `Not a folder: ${p}`);
}
function localFolderCheck(p, machine) {
  if (typeof p === 'string' && (machine === undefined || machine === null || machine === '' || machine === 'local')) assertLocalFolder(p);
}

const AGENT_START_NOTE_BLOCKED =
  'The agent started but is waiting for an answer (for example a folder-trust or login prompt). Read it with herdr_read and answer only as the user decides.';

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

// ---------- methods ----------
function waitTimeout(params, fallback) {
  const t = posInt(params.timeout_ms, 'timeout_ms', 1000, 600000);
  return t === undefined ? fallback : t;
}

async function resolveChatFile(p, target) {
  const snap = await herdr(p, ['api', 'snapshot']);
  const panes = snap.result?.snapshot?.panes || [];
  const pane = panes.find((a) => a.pane_id === target && a.agent);
  if (!pane) return { available: false, reason: 'The agent is no longer in this pane.' };
  if (!transcripts.supported.includes(pane.agent)) {
    return { available: false, reason: `Chat history for ${pane.agent} is not supported yet. Open Terminal to interact with this agent.` };
  }
  let file = transcripts.resolve(pane.agent_session, pane.agent);
  if (!file && (pane.agent === 'codex' || pane.agent === 'omp')) {
    const info = await herdr(p, ['pane', 'process-info', '--pane', target]);
    const processes = info.result?.process_info?.foreground_processes || [];
    const candidates = processes.filter((proc) => proc.name === pane.agent && proc.cwd === pane.foreground_cwd && Number.isSafeInteger(proc.pid));
    if (candidates.length === 1) file = pane.agent === 'codex'
      ? transcripts.resolveCodexProcess(candidates[0].pid, candidates[0].cwd)
      : transcripts.resolveOmpProcess(candidates[0].pid, candidates[0].cwd);
  }
  if (!file) return { available: false, reason: 'herdr has not reported an exact transcript for this agent.' };
  return { available: true, pane, file };
}

function parseRemoteHelperStdout(stdout) {
  try { return JSON.parse(stdout); }
  catch { throw new UserError('HERDR_FAILED', 'Remote transcript response was not valid.'); }
}
const METHODS = {
  async 'machines/list'() {
    const list = await listMachines();
    return {
      machines: [
        { label: 'local', target: 'this computer', session: 'default', enabled: true },
        ...list.map((m) => ({ label: m.label, target: m.target, session: m.session, enabled: m.enabled !== false })),
      ],
    };
  },

  async 'sessions/list'(p) {
    return herdr(p, ['session', 'list', '--json'], { useSession: false });
  },

  async 'overview'(p) {
    // One round trip: the snapshot carries workspaces, tabs, panes and agents.
    const snap = await herdr(p, ['api', 'snapshot']);
    const s = (snap.result && snap.result.snapshot) || {};
    // Pane size in cells, from the tab layouts (the xterm mirror uses it).
    const rects = new Map();
    for (const l of s.layouts || []) for (const pn of l.panes || []) rects.set(pn.pane_id, pn.rect);
    return {
      machine: snap.machine,
      session: snap.session,
      focused_pane_id: s.focused_pane_id,
      workspaces: (s.workspaces || []).map((w) => ({
        workspace_id: w.workspace_id,
        label: w.label,
        status: w.agent_status,
        tab_count: w.tab_count,
        pane_count: w.pane_count,
        focused: w.focused,
        worktree: w.worktree
          ? { linked: !!w.worktree.is_linked_worktree, repo: w.worktree.repo_name, path: w.worktree.checkout_path }
          : null,
      })),
      tabs: (s.tabs || []).map((t) => ({
        tab_id: t.tab_id,
        workspace_id: t.workspace_id,
        label: t.label,
        status: t.agent_status,
        pane_count: t.pane_count,
      })),
      panes: (s.panes || []).map((pn) => {
        const out = slimPane(pn);
        const rect = rects.get(pn.pane_id);
        out.cols = rect ? rect.width : undefined;
        out.rows = (pn.scroll && pn.scroll.viewport_rows) || (rect ? rect.height : undefined);
        return out;
      }),
      agents: (s.agents || []).map(slimAgent),
    };
  },

  async 'workspaces/list'(p) {
    return herdr(p, ['workspace', 'list']);
  },

  async 'tabs/list'(p) {
    const args = ['tab', 'list'];
    if (p.workspace_id) args.push('--workspace', str(p.workspace_id, ID_RE, 'workspace_id'));
    return herdr(p, args);
  },

  async 'panes/list'(p) {
    const args = ['pane', 'list'];
    if (p.workspace_id) args.push('--workspace', str(p.workspace_id, ID_RE, 'workspace_id'));
    const r = await herdr(p, args);
    if (r.result && Array.isArray(r.result.panes)) r.result.panes = r.result.panes.map(slimPane);
    return r;
  },

  async 'agents/list'(p) {
    const r = await herdr(p, ['agent', 'list']);
    return { machine: r.machine, session: r.session, agents: (r.result.agents || []).map(slimAgent) };
  },

  async 'agents/get'(p) {
    return herdr(p, ['agent', 'get', str(req(p, 'target'), ID_RE, 'target')]);
  },

  async 'read'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    const lines = posInt(p.lines, 'lines', 1, 2000) || 120;
    const source = p.source === undefined ? 'recent-unwrapped' : p.source;
    if (!SOURCES.has(source)) throw new UserError('INVALID_ARGS', 'Invalid source.');
    // Agent names (no colon) go through `agent read`; pane ids through `pane read`.
    const isPane = target.includes(':');
    const args = isPane
      ? ['pane', 'read', target, '--source', source, '--lines', String(lines)]
      : ['agent', 'read', target, '--source', source, '--lines', String(lines)];
    const r = await herdr(p, args, { raw: true });
    return { machine: r.machine, session: r.session, target, output: stripAnsi(r.text) };
  },

  async 'agents/prompt'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    const text = positionalText(req(p, 'text'), 'text');
    const args = ['agent', 'prompt', target, text];
    const wait = p.wait !== false;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (wait) {
      const t = waitTimeout(p, 110000);
      args.push('--wait', '--timeout', String(t));
      timeoutMs = t + 10000;
    }
    return herdr(p, args, { timeoutMs });
  },

  async 'agents/wait'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    const t = waitTimeout(p, 110000);
    const args = ['agent', 'wait', target, '--timeout', String(t)];
    for (const s of toArray(p.until)) {
      if (!STATES.has(s)) throw new UserError('INVALID_ARGS', `Invalid state "${s}".`);
      args.push('--until', s);
    }
    return herdr(p, args, { timeoutMs: t + 10000 });
  },

  async 'agents/start'(p) {
    const name = str(req(p, 'name'), AGENT_NAME_RE, 'agent name');
    const kind = req(p, 'kind');
    if (!AGENT_KINDS.has(kind)) throw new UserError('INVALID_ARGS', `Unsupported agent kind "${kind}".`);
    const pane = str(req(p, 'pane_id'), ID_RE, 'pane_id');
    const t = waitTimeout(p, 30000);
    const args = ['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(t)];
    const extra = toArray(p.agent_args);
    if (extra.length) {
      if (extra.length > 32 || extra.some((a) => typeof a !== 'string' || a.length > 2000)) {
        throw new UserError('INVALID_ARGS', 'agent_args must be up to 32 strings.');
      }
      args.push('--', ...extra);
    }
    return herdr(p, args, { timeoutMs: t + 10000 });
  },

  // Keys and/or literal text. Text needs a pane id (herdr has no agent send-text) and is typed before the keys.
  async 'keys'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    const keys = toArray(p.keys);
    const hasText = p.text !== undefined && p.text !== null && p.text !== '';
    if (!hasText && !keys.length) throw new UserError('INVALID_ARGS', 'Give keys, text, or both.');
    if (keys.length > 32) throw new UserError('INVALID_ARGS', 'keys must contain at most 32 key names.');
    for (const k of keys) str(k, KEY_RE, 'key');
    const isPane = target.includes(':');
    let typed;
    if (hasText) {
      if (!isPane) throw new UserError('INVALID_ARGS', 'text needs a pane id such as "w1:p2" (find it with herdr_overview).');
      typed = await herdr(p, ['pane', 'send-text', target, positionalText(p.text, 'text', 20000)]);
      if (!keys.length) return typed;
    }
    const pressed = await herdr(p, [isPane ? 'pane' : 'agent', 'send-keys', target, ...keys]);
    return typed ? { ...pressed, typed_text: true } : pressed;
  },

  async 'panes/run'(p) {
    const pane = str(req(p, 'pane_id'), ID_RE, 'pane_id');
    const command = positionalText(req(p, 'command'), 'command', 20000);
    const r = await herdr(p, ['pane', 'run', pane, command]);
    if (p.wait_for) {
      const match = positionalText(p.wait_for, 'wait_for', 2000);
      const t = waitTimeout(p, 60000);
      const w = await herdr(p, ['pane', 'wait-output', pane, '--match', match, '--source', 'recent-unwrapped', '--timeout', String(t)], { timeoutMs: t + 10000 });
      return { ...r, waited: w.result };
    }
    return r;
  },

  // Page history: resolve the session through herdr on every request so a pane that
  // restarted cannot continue displaying another session's transcript.
  async 'chat/history'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    if (!target.includes(':')) throw new UserError('INVALID_ARGS', 'target must be a pane id.');
    const machine = await resolveMachine(p.machine);
    if (machine.kind === 'ssh') {
      if (p.before !== undefined && (!Number.isSafeInteger(p.before) || p.before < 0) ||
          p.after !== undefined && (!Number.isSafeInteger(p.after) || p.after < 0)) {
        throw new UserError('INVALID_ARGS', 'Invalid transcript cursor.');
      }
      const session = p.session || machine.defaultSession || 'default';
      str(session, SESSION_RE, 'session');
      const payload = JSON.stringify({ action: 'history', target, session, identity: p.identity, after: p.after, before: p.before });
      const command = REMOTE_PATH_PREFIX + 'node -e ' + shQuote(REMOTE_HISTORY_SCRIPT) + ' -- ' + shQuote(payload);
      const result = await runSshCommand(machine.target, command, 20000);
      if (result.code !== 0) throw new UserError('HERDR_FAILED', 'Remote transcript helper failed. Retry after checking Node on the machine, or open Terminal.');
      return parseRemoteHelperStdout(result.stdout);
    }
    const resolved = await resolveChatFile(p, target);
    if (!resolved.available) return resolved;
    const data = transcripts.read(resolved.file, resolved.pane.agent, {
      identity: p.identity,
      after: p.after,
      before: p.before,
    });
    return { available: true, agent: resolved.pane.agent, ...data };
  },

  // Page send: require the live transcript identity to match before delivering a prompt.
  async 'chat/prompt'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    if (!target.includes(':')) throw new UserError('INVALID_ARGS', 'target must be a pane id.');
    const expected = typeof p.identity === 'string' && p.identity ? p.identity : null;
    if (!expected) throw new UserError('INVALID_ARGS', 'identity is required.');
    const text = positionalText(req(p, 'text'), 'text');
    const machine = await resolveMachine(p.machine);
    if (machine.kind === 'ssh') {
      const session = p.session || machine.defaultSession || 'default';
      str(session, SESSION_RE, 'session');
      const payload = JSON.stringify({ action: 'prompt', target, session, identity: expected, text });
      const command = REMOTE_PATH_PREFIX + 'node -e ' + shQuote(REMOTE_HISTORY_SCRIPT) + ' -- ' + shQuote(payload);
      const result = await runSshCommand(machine.target, command, 120000);
      if (result.code !== 0) throw new UserError('HERDR_FAILED', 'Could not deliver the message on the remote machine.');
      try { return assertRemotePromptBody(parseRemoteHelperStdout(result.stdout)); }
      catch (err) {
        if (err.code) throw new UserError(err.code, err.message);
        throw err;
      }
    }
    const resolved = await resolveChatFile(p, target);
    if (!resolved.available) throw new UserError('UNAVAILABLE', resolved.reason || 'Chat is unavailable.');
    if (transcripts.fileIdentity(resolved.file) !== expected) {
      throw new UserError('SESSION_MISMATCH', 'Live transcript identity does not match the conversation shown.');
    }
    return METHODS['agents/prompt']({ ...p, target, text, wait: false });
  },

  // ---- live terminal for the page (xterm mirror of one pane) ----
  // The pane's visible screen with colors, plus its size in cells. `since` skips unchanged frames.
  async 'term/screen'(p) {
    const pane = str(req(p, 'target'), ID_RE, 'target');
    if (!pane.includes(':')) throw new UserError('INVALID_ARGS', 'target must be a pane id.');
    const r = await herdr(p, ['pane', 'read', pane, '--source', 'visible', '--format', 'ansi'], { raw: true, timeoutMs: 10000 });
    const text = r.text.replace(/\r?\n$/, '');
    const hash = fnv1a(text);
    if (p.since && p.since === hash) return { unchanged: true, hash };
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
    let cols = 0;
    for (const line of lines) cols = Math.max(cols, displayWidth(stripAnsi(line)));
    return {
      hash,
      text: lines.join('\r\n'),
      cols: Math.min(500, Math.max(20, cols)),
      rows: Math.min(300, Math.max(1, lines.length)),
    };
  },

  // Raw terminal input from xterm (keystrokes, escape sequences, pastes), written as-is to the pane.
  async 'term/input'(p) {
    const pane = str(req(p, 'target'), ID_RE, 'target');
    if (!pane.includes(':')) throw new UserError('INVALID_ARGS', 'target must be a pane id.');
    if (typeof p.data !== 'string' || !p.data || p.data.length > 100000) {
      throw new UserError('INVALID_ARGS', 'data must be 1..100000 chars.');
    }
    // herdr's CLI rejects positional text starting with "-" (no "--" separator), so any chunk that
    // would start with "-" sends that dash as the "-" key first.
    let data = p.data.replace(/\0/g, '');
    while (data) {
      let dashes = 0;
      while (dashes < data.length && dashes < 32 && data[dashes] === '-') dashes += 1;
      if (dashes) {
        await herdr(p, ['pane', 'send-keys', pane, ...Array(dashes).fill('-')]);
        data = data.slice(dashes);
        continue;
      }
      const chunk = data.slice(0, 20000);
      await herdr(p, ['pane', 'send-text', pane, chunk]);
      data = data.slice(chunk.length);
    }
    return { ok: true };
  },

  async 'panes/wait_output'(p) {
    const pane = str(req(p, 'pane_id'), ID_RE, 'pane_id');
    const t = waitTimeout(p, 60000);
    const args = ['pane', 'wait-output', pane, '--source', 'recent-unwrapped', '--timeout', String(t)];
    if (p.regex) args.push('--regex', positionalText(p.regex, 'regex', 2000));
    else args.push('--match', positionalText(req(p, 'match'), 'match', 2000));
    return herdr(p, args, { timeoutMs: t + 10000 });
  },

  async 'panes/split'(p) {
    const pane = str(req(p, 'pane_id'), ID_RE, 'pane_id');
    const direction = p.direction === undefined ? 'right' : p.direction;
    if (direction !== 'right' && direction !== 'down') throw new UserError('INVALID_ARGS', 'direction must be right or down.');
    const args = ['pane', 'split', pane, '--direction', direction, p.focus ? '--focus' : '--no-focus'];
    const cwd = folderArg(p.cwd, 'cwd');
    localFolderCheck(cwd, p.machine);
    if (cwd) args.push('--cwd', cwd);
    return herdr(p, args);
  },

  async 'workspaces/create'(p) {
    const args = ['workspace', 'create', p.focus ? '--focus' : '--no-focus'];
    const cwd = folderArg(p.cwd, 'cwd');
    localFolderCheck(cwd, p.machine);
    if (cwd) args.push('--cwd', cwd);
    if (p.label) args.push('--label', labelArg(p.label));
    return herdr(p, args);
  },

  async 'workspaces/rename'(p) {
    const id = str(req(p, 'workspace_id'), ID_RE, 'workspace_id');
    return herdr(p, ['workspace', 'rename', id, labelArg(req(p, 'label'))]);
  },

  async 'tabs/create'(p) {
    const args = ['tab', 'create', '--workspace', str(req(p, 'workspace_id'), ID_RE, 'workspace_id'), p.focus ? '--focus' : '--no-focus'];
    const cwd = folderArg(p.cwd, 'cwd');
    localFolderCheck(cwd, p.machine);
    if (cwd) args.push('--cwd', cwd);
    if (p.label) args.push('--label', labelArg(p.label));
    return herdr(p, args);
  },

  async 'worktrees/list'(p) {
    const args = ['worktree', 'list'];
    if (p.workspace_id) args.push('--workspace', str(p.workspace_id, ID_RE, 'workspace_id'));
    const cwd = folderArg(p.cwd, 'cwd');
    if (!p.workspace_id && !cwd) throw new UserError('INVALID_ARGS', 'Give workspace_id or cwd (a folder inside the git repository).');
    localFolderCheck(cwd, p.machine);
    if (cwd) args.push('--cwd', cwd);
    return herdr(p, args);
  },

  // New branch + checkout under ~/.worktrees/<repo>/<branch> (unless path is given), opened as a workspace.
  async 'worktrees/create'(p) {
    const args = ['worktree', 'create', p.focus ? '--focus' : '--no-focus'];
    const cwd = folderArg(p.cwd, 'cwd');
    if (p.workspace_id) args.push('--workspace', str(p.workspace_id, ID_RE, 'workspace_id'));
    else if (!cwd) throw new UserError('INVALID_ARGS', 'Give cwd (a folder inside the git repository) or workspace_id.');
    localFolderCheck(cwd, p.machine);
    if (cwd) args.push('--cwd', cwd);
    args.push('--branch', branchArg(req(p, 'branch'), 'branch'));
    if (p.base) args.push('--base', branchArg(p.base, 'base'));
    const wtPath = folderArg(p.path, 'path');
    if (wtPath) args.push('--path', wtPath);
    if (p.label) args.push('--label', labelArg(p.label));
    return herdr(p, args, { timeoutMs: 90000 });
  },

  async 'worktrees/open'(p) {
    const args = ['worktree', 'open', p.focus ? '--focus' : '--no-focus'];
    const cwd = folderArg(p.cwd, 'cwd');
    if (p.workspace_id) args.push('--workspace', str(p.workspace_id, ID_RE, 'workspace_id'));
    else if (!cwd) throw new UserError('INVALID_ARGS', 'Give cwd (a folder inside the git repository) or workspace_id.');
    localFolderCheck(cwd, p.machine);
    if (cwd) args.push('--cwd', cwd);
    const wtPath = folderArg(p.path, 'path');
    if (wtPath) args.push('--path', wtPath);
    else if (p.branch) args.push('--branch', branchArg(p.branch, 'branch'));
    else throw new UserError('INVALID_ARGS', 'Give the worktree path or branch to open.');
    if (p.label) args.push('--label', labelArg(p.label));
    return herdr(p, args, { timeoutMs: 60000 });
  },

  // Create a workspace / tab / worktree and, when agent_kind is set, start that agent in its root pane.
  async 'workspaces/launch'(p) {
    const action = p.action || 'create';
    const creators = {
      create: 'workspaces/create',
      tab_create: 'tabs/create',
      worktree_create: 'worktrees/create',
      worktree_open: 'worktrees/open',
    };
    if (!creators[action]) throw new UserError('INVALID_ARGS', `Unsupported action "${action}".`);
    let kind;
    let name;
    if (p.agent_kind) {
      kind = p.agent_kind;
      if (!AGENT_KINDS.has(kind)) throw new UserError('INVALID_ARGS', `Unsupported agent kind "${kind}".`);
      name = p.agent_name ? str(p.agent_name, AGENT_NAME_RE, 'agent name') : `${kind}-${randomSuffix()}`;
    }
    const created = await METHODS[creators[action]](p);
    const r = created.result || {};
    const root = r.root_pane || {};
    log(`launch: ${action} done (${root.pane_id || 'no pane'})${kind ? `, starting ${kind}` : ''}`);
    const out = {
      machine: created.machine,
      session: created.session,
      action,
      workspace_id: (r.workspace && r.workspace.workspace_id) || root.workspace_id,
      tab_id: (r.tab && r.tab.tab_id) || root.tab_id,
      pane_id: root.pane_id,
      cwd: root.foreground_cwd || root.cwd,
      worktree: r.worktree ? { branch: r.worktree.branch, path: r.worktree.path } : undefined,
    };
    // herdr falls back to the home folder when a remote --cwd does not exist (local folders are checked up front).
    if (typeof p.cwd === 'string' && p.cwd.startsWith('/') && action !== 'worktree_create' && action !== 'worktree_open' && out.cwd) {
      const want = p.cwd.replace(/\/+$/, '');
      if (out.cwd !== want && !out.cwd.endsWith(want)) out.note = `herdr opened ${out.cwd} instead of ${want}; that folder may not exist on ${out.machine}.`;
    }
    if (!kind) return out;
    if (!root.pane_id) throw new UserError('HERDR_ERROR', 'herdr did not return the new pane id, so no agent was started.');
    try {
      await METHODS['agents/start']({
        machine: p.machine,
        session: p.session,
        name,
        kind,
        pane_id: root.pane_id,
        timeout_ms: p.timeout_ms || 60000,
        agent_args: p.agent_args,
      });
      return { ...out, agent: { name, kind, status: 'ready' } };
    } catch (err) {
      if (err instanceof UserError && err.code === 'AGENT_NOT_READY') {
        return { ...out, agent: { name, kind, status: 'blocked' }, note: [out.note, AGENT_START_NOTE_BLOCKED].filter(Boolean).join(' ') };
      }
      // Undo a plain workspace/tab we just created so it does not linger without an agent.
      // Worktrees are kept: their checkout and branch are real git state.
      let cleanup = '';
      if (action === 'create' || action === 'tab_create') {
        const what = action === 'create' ? 'workspace' : 'tab';
        const id = action === 'create' ? out.workspace_id : out.tab_id;
        try {
          await herdr(p, [what, 'close', id]);
          cleanup = ` The new ${what} was closed again.`;
        } catch {
          cleanup = ` The new ${what} ${id} is still open without an agent.`;
        }
      } else {
        cleanup = ` The worktree workspace ${out.workspace_id} is open without an agent.`;
      }
      const code = err instanceof UserError ? err.code : 'HERDR_ERROR';
      throw new UserError(code, `Could not start ${kind}: ${String(err.message || err)}.${cleanup}`);
    }
  },

  // Agent tool entry point for workspace management.
  async 'workspace'(p) {
    const action = req(p, 'action');
    switch (action) {
      case 'create':
      case 'tab_create':
      case 'worktree_create':
      case 'worktree_open':
        return METHODS['workspaces/launch'](p);
      case 'rename':
        return METHODS['workspaces/rename'](p);
      case 'worktree_list':
        return METHODS['worktrees/list'](p);
      default:
        throw new UserError('INVALID_ARGS', 'action must be create, tab_create, rename, worktree_create, worktree_open or worktree_list.');
    }
  },

  async 'close'(p) {
    const kind = req(p, 'kind');
    const id = str(req(p, 'id'), ID_RE, 'id');
    if (kind === 'worktree') {
      // Closes the worktree's workspace and deletes the checkout; the branch stays.
      const args = ['worktree', 'remove', '--workspace', id];
      if (p.force === true) args.push('--force');
      return herdr(p, args, { timeoutMs: 60000 });
    }
    if (!['pane', 'tab', 'workspace'].includes(kind)) throw new UserError('INVALID_ARGS', 'kind must be pane, tab, workspace or worktree.');
    return herdr(p, [kind, 'close', id]);
  },

  async 'focus'(p) {
    const kind = req(p, 'kind');
    const id = str(req(p, 'id'), ID_RE, 'id');
    if (kind === 'agent') return herdr(p, ['agent', 'focus', id]);
    if (kind === 'workspace' || kind === 'tab') return herdr(p, [kind, 'focus', id]);
    throw new UserError('INVALID_ARGS', 'kind must be workspace, tab or agent.');
  },
};

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function slimAgent(a) {
  return {
    name: a.name,
    agent: a.agent,
    status: a.agent_status,
    pane_id: a.pane_id,
    tab_id: a.tab_id,
    workspace_id: a.workspace_id,
    cwd: a.foreground_cwd || a.cwd,
    title: a.terminal_title_stripped || a.terminal_title,
    focused: a.focused,
  };
}
function slimPane(pn) {
  return {
    pane_id: pn.pane_id,
    tab_id: pn.tab_id,
    workspace_id: pn.workspace_id,
    agent: pn.agent,
    agent_name: pn.name,
    status: pn.agent_status,
    cwd: pn.foreground_cwd || pn.cwd,
    title: pn.terminal_title_stripped || pn.terminal_title,
    focused: pn.focused,
  };
}
// FNV-1a hash of a screen, to skip unchanged frames.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + s.length;
}
// Terminal cell width: East Asian wide/fullwidth and most emoji take two cells.
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 0x7f && c < 0xa0) || (c >= 0x300 && c <= 0x36f) || c === 0x200b || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

if (process.env.HERDR_EXPORT_FOR_TESTS === "1") {
  module.exports = { REMOTE_HISTORY_SCRIPT_FOR_TESTS: REMOTE_HISTORY_SCRIPT };
} else {
// ---------- JSON-RPC loop ----------
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.id === undefined) return; // notification
  const fn = METHODS[request.method];
  if (!fn) {
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    const result = await fn(params);
    reply({ jsonrpc: '2.0', id: request.id, result });
  } catch (err) {
    const code = err instanceof UserError ? err.code : 'INTERNAL';
    if (!(err instanceof UserError)) log('internal error:', err && err.stack ? err.stack : String(err));
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: `${code}: ${String(err.message || err)}`, data: { code } } });
  }
});
}
