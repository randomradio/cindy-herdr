// herdr plugin brain (browser sandbox).
// Routes Agent tool calls and panel requests to the bundled Node worker,
// which runs the herdr CLI locally or over SSH on a saved herdr machine.

const TOOL_METHODS = {
  herdr_machines: 'machines/list',
  herdr_sessions: 'sessions/list',
  herdr_overview: 'overview',
  herdr_agent_get: 'agents/get',
  herdr_read: 'read',
  herdr_prompt_agent: 'agents/prompt',
  herdr_wait_agent: 'agents/wait',
  herdr_send_keys: 'keys',
  herdr_run_command: 'panes/run',
  herdr_send_text: 'panes/send_text',
  herdr_wait_output: 'panes/wait_output',
  herdr_split_pane: 'panes/split',
  herdr_start_agent: 'agents/start',
  herdr_create: 'create',
  herdr_focus: 'focus',
  herdr_close: 'close',
};

// Methods allowed from the herdr page (user clicks; no Agent call in flight).
const PANEL_METHODS = new Set(['machines/list', 'sessions/list', 'overview', 'read', 'agents/get', 'agents/prompt', 'keys', 'panes/run']);

// Long-running methods: keep the tool call alive while the worker waits.
const LONG_METHODS = new Set(['agents/prompt', 'agents/wait', 'agents/start', 'panes/run', 'panes/wait_output']);

function nodeTimeouts(method, args) {
  if (!LONG_METHODS.has(method)) return { timeoutMs: 60000 };
  const waitMs = Number(args && args.timeout_ms) || 110000;
  return { timeoutMs: 120000, maxTotalMs: Math.min(900000, waitMs + 60000) };
}

function errorCodeOf(response) {
  const msg = String((response && response.message) || '');
  const m = /^([A-Z][A-Z0-9_]{2,40}):/.exec(msg);
  // Host-reserved codes must not be emitted by plugins.
  const reserved = new Set(['GHOST_NOT_FOUND', 'GHOST_ASLEEP', 'GHOST_CRASHED', 'TIMEOUT', 'INTERNAL', 'TOOL_NOT_FOUND']);
  if (m && !reserved.has(m[1])) return m[1];
  if (m && m[1] === 'TIMEOUT') return 'HERDR_TIMEOUT';
  return 'HERDR_FAILED';
}

async function callWorker(method, params, callId) {
  const opts = nodeTimeouts(method, params);
  const request = { method, params: params || {}, timeoutMs: opts.timeoutMs };
  if (opts.maxTotalMs) request.maxTotalMs = opts.maxTotalMs;
  if (callId) {
    request.callId = callId;
    request.cancelWithCall = true;
  }
  return cindy.node.request(request);
}

async function heartbeat(callId, promise) {
  const timer = setInterval(() => {
    cindy.send({ type: 'tool-progress', callId });
  }, 45000);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

function where(args) {
  const machine = args.machine && args.machine !== 'local' ? args.machine : 'this computer';
  const session = args.session ? ` (session "${args.session}")` : '';
  return machine + session;
}

async function confirmClose(args) {
  const kind = String(args.kind || '');
  const id = String(args.id || '');
  const extra = kind === 'workspace' ? ' Every tab, pane and process in it will be stopped.' : kind === 'tab' ? ' Every pane and process in it will be stopped.' : ' Its running process will be stopped.';
  const r = await cindy.confirm({
    body: `Close herdr ${kind} ${id} on ${where(args)}?${extra}`.slice(0, 300),
    confirmText: 'Close',
    cancelText: 'Keep it',
    danger: true,
  });
  if (!r.ok) return { ok: false, code: 'CONFIRM_UNAVAILABLE', message: `Could not ask for confirmation (${r.errorCode || 'unknown'}). Nothing was closed; ask the user to try again.` };
  if (!r.confirmed) return { ok: false, code: 'USER_DECLINED', message: 'The user declined to close it. Nothing was closed; do not ask again unless the user requests it.' };
  return { ok: true };
}

cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  const method = TOOL_METHODS[msg.tool];
  if (!method) {
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: 'UNKNOWN_TOOL', message: `Unknown tool ${msg.tool}.` });
    return;
  }
  const args = msg.args && typeof msg.args === 'object' ? { ...msg.args } : {};
  try {
    if (method === 'close') {
      const gate = await confirmClose(args);
      if (!gate.ok) {
        await cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: gate.code, message: gate.message });
        return;
      }
    }
    const pending = callWorker(method, args, msg.callId);
    const response = LONG_METHODS.has(method) ? await heartbeat(msg.callId, pending) : await pending;
    if (!response.ok) {
      await cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: false,
        errorCode: errorCodeOf(response),
        message: String(response.message || 'herdr request failed.') + ' Check the machine/session/target and retry; use herdr_overview to rediscover ids.',
      });
      return;
    }
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: response.result });
    if (method !== 'read' && method !== 'overview' && !method.endsWith('/list') && method !== 'agents/get') {
      panelChannel.postMessage({ type: 'changed', machine: args.machine || 'local', session: args.session || null });
    }
  } catch (err) {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'HERDR_FAILED',
      message: 'herdr request failed: ' + String((err && err.message) || err) + '. Retry once; if it persists, check that herdr is running.',
    });
  }
});

// ---------- panel bridge ----------
const panelChannel = new BroadcastChannel('herdr-panel');
const seen = new Map(); // reqId -> response (dedupe panel retries)

panelChannel.onmessage = async function (event) {
  const data = event.data || {};
  if (data.type !== 'request' || !data.reqId) return;
  if (seen.has(data.reqId)) {
    const cached = seen.get(data.reqId);
    if (cached) panelChannel.postMessage(cached);
    return;
  }
  seen.set(data.reqId, null);
  if (seen.size > 200) seen.delete(seen.keys().next().value);
  let out;
  if (!PANEL_METHODS.has(data.method)) {
    out = { type: 'response', reqId: data.reqId, ok: false, message: 'Not allowed from the panel.' };
  } else {
    try {
      const params = { ...(data.params || {}) };
      // The page polls output itself; never block on agent completion or pane output here.
      if (data.method === 'agents/prompt') params.wait = false;
      if (data.method === 'panes/run') delete params.wait_for;
      const r = await callWorker(data.method, params, null);
      out = r.ok
        ? { type: 'response', reqId: data.reqId, ok: true, result: r.result }
        : { type: 'response', reqId: data.reqId, ok: false, message: String(r.message || 'Request failed') };
    } catch (err) {
      out = { type: 'response', reqId: data.reqId, ok: false, message: String((err && err.message) || err) };
    }
  }
  seen.set(data.reqId, out);
  panelChannel.postMessage(out);
};
