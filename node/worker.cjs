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
function absPath(v, label) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !(v.startsWith('/') || v.startsWith('~')) || v.length > 4096 || /[\0\n\r]/.test(v)) {
    throw new UserError('INVALID_ARGS', `${label} must be an absolute path.`);
  }
  return v;
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

function runSsh(target, args, timeoutMs) {
  const ssh = findBinary('ssh');
  if (!ssh) return Promise.reject(new UserError('SSH_NOT_FOUND', 'ssh is not available on this computer.'));
  const remoteCmd = REMOTE_PATH_PREFIX + ['herdr', ...args].map(shQuote).join(' ');
  const sshArgs = ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15'];
  const controlDir = sshControlDir();
  if (controlDir) {
    // Reuse one connection for repeated panel refreshes / tool calls.
    sshArgs.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/%C`, '-o', 'ControlPersist=120');
  }
  sshArgs.push('-T', target, remoteCmd);
  return execCapture(ssh, sshArgs, timeoutMs).then((res) => {
    if (res.code === 255 && !res.stdout) {
      throw new UserError('SSH_FAILED', `SSH to ${target} failed: ${res.stderr.trim().slice(0, 500) || 'exit 255'}. Check that passwordless SSH works (BatchMode).`);
    }
    if (res.code === 127) {
      throw new UserError('HERDR_NOT_FOUND', `herdr was not found on ${target}.`);
    }
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
  const full = useSession && session ? ['--session', session, ...args] : args;
  const res = machine.kind === 'ssh'
    ? await runSsh(machine.target, full, timeoutMs)
    : await runLocal(full, timeoutMs);
  if (raw) {
    if (res.code !== 0) parseHerdr(res);
    return { machine: machine.label, session: session || 'default', text: res.stdout };
  }
  const result = parseHerdr(res);
  return { machine: machine.label, session: session || 'default', result };
}

// ---------- methods ----------
function waitTimeout(params, fallback) {
  const t = posInt(params.timeout_ms, 'timeout_ms', 1000, 600000);
  return t === undefined ? fallback : t;
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
      })),
      tabs: (s.tabs || []).map((t) => ({
        tab_id: t.tab_id,
        workspace_id: t.workspace_id,
        label: t.label,
        status: t.agent_status,
        pane_count: t.pane_count,
      })),
      panes: (s.panes || []).map(slimPane),
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

  async 'keys'(p) {
    const target = str(req(p, 'target'), ID_RE, 'target');
    const keys = toArray(p.keys);
    if (!keys.length || keys.length > 32) throw new UserError('INVALID_ARGS', 'keys must contain 1..32 key names.');
    for (const k of keys) str(k, KEY_RE, 'key');
    const isPane = target.includes(':');
    return herdr(p, [isPane ? 'pane' : 'agent', 'send-keys', target, ...keys]);
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

  async 'panes/send_text'(p) {
    const pane = str(req(p, 'pane_id'), ID_RE, 'pane_id');
    const text = positionalText(req(p, 'text'), 'text', 20000);
    return herdr(p, ['pane', 'send-text', pane, text]);
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
    const cwd = absPath(p.cwd, 'cwd');
    if (cwd) args.push('--cwd', cwd);
    return herdr(p, args);
  },

  async 'workspaces/create'(p) {
    const args = ['workspace', 'create', p.focus ? '--focus' : '--no-focus'];
    const cwd = absPath(p.cwd, 'cwd');
    if (cwd) args.push('--cwd', cwd);
    if (p.label) args.push('--label', positionalText(p.label, 'label', 64));
    return herdr(p, args);
  },

  async 'tabs/create'(p) {
    const args = ['tab', 'create', '--workspace', str(req(p, 'workspace_id'), ID_RE, 'workspace_id'), p.focus ? '--focus' : '--no-focus'];
    const cwd = absPath(p.cwd, 'cwd');
    if (cwd) args.push('--cwd', cwd);
    if (p.label) args.push('--label', positionalText(p.label, 'label', 64));
    return herdr(p, args);
  },

  async 'create'(p) {
    if (p.kind === 'workspace') return METHODS['workspaces/create'](p);
    if (p.kind === 'tab') return METHODS['tabs/create'](p);
    throw new UserError('INVALID_ARGS', 'kind must be workspace or tab.');
  },

  async 'close'(p) {
    const kind = req(p, 'kind');
    const id = str(req(p, 'id'), ID_RE, 'id');
    if (!['pane', 'tab', 'workspace'].includes(kind)) throw new UserError('INVALID_ARGS', 'kind must be pane, tab or workspace.');
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
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

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
