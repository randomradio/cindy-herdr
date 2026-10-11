(function () {
  'use strict';
  const GHOST_ID = 'herdr';
  const channel = new BroadcastChannel('herdr-panel');
  const waiters = new Map();
  const $ = (id) => document.getElementById(id);
  const machineSel = $('machine');
  const sessionSel = $('session');
  const refreshBtn = $('refresh');
  const statusEl = $('status');
  const listEl = $('list');
  const placeholder = $('placeholder');
  const conversation = $('conversation');
  const headDot = $('head-dot');
  const headTitle = $('head-title');
  const headMeta = $('head-meta');
  const headStatus = $('head-status');
  const output = $('output');
  const jumpBtn = $('jump');
  const input = $('input');
  const sendBtn = $('send');
  const sendNote = $('send-note');

  const PREF_KEY = 'herdr-view-prefs';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { prefs = {}; }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

  let panes = [];
  let selected = null; // pane object
  let overviewBusy = false;
  let readBusy = false;
  let overviewTimer = null;
  let readTimer = null;
  let lastOutput = '';
  let sending = false;

  // ---------- brain bridge ----------
  channel.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === 'response' && waiters.has(data.reqId)) {
      const w = waiters.get(data.reqId);
      waiters.delete(data.reqId);
      w(data);
    } else if (data.type === 'changed') {
      setTimeout(() => refreshOverview(false), 600);
    }
  };

  async function wake() {
    try { await fetch(`cindy-ghost://${GHOST_ID}/wake`); } catch {}
  }

  async function request(method, params, timeoutMs = 60000) {
    await wake();
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearInterval(resend); clearTimeout(timer); waiters.delete(reqId); resolve(v); };
      waiters.set(reqId, finish);
      const send = () => channel.postMessage({ type: 'request', reqId, method, params });
      send();
      const resend = setInterval(send, 700);
      const timer = setTimeout(() => finish({ ok: false, message: 'Timed out waiting for herdr.' }), timeoutMs);
    });
  }

  const target = () => ({ machine: machineSel.value || 'local', session: sessionSel.value || undefined });
  const isRemote = () => (machineSel.value || 'local') !== 'local';

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
  }
  function option(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }
  const statusClass = (s) => (['working', 'blocked', 'done', 'idle'].includes(s) ? s : 'unknown');

  // ---------- machines / sessions ----------
  async function loadMachines() {
    const r = await request('machines/list', {});
    machineSel.replaceChildren();
    const machines = r.ok ? r.result.machines : [{ label: 'local', enabled: true }];
    for (const m of machines) {
      if (m.enabled === false) continue;
      machineSel.appendChild(option(m.label, m.label === 'local' ? 'This computer' : m.label));
    }
    if (prefs.machine && [...machineSel.options].some((o) => o.value === prefs.machine)) machineSel.value = prefs.machine;
  }

  async function loadSessions() {
    const machine = machineSel.value || 'local';
    sessionSel.replaceChildren(option('', 'Loading…'));
    const r = await request('sessions/list', { machine });
    sessionSel.replaceChildren();
    if (!r.ok) {
      sessionSel.appendChild(option('', 'Default'));
      setStatus(r.message, true);
      return;
    }
    const sessions = (r.result.result && r.result.result.sessions) || [];
    for (const s of sessions) sessionSel.appendChild(option(s.name, s.running ? s.name : `${s.name} (stopped)`));
    const key = `session:${machine}`;
    if (prefs[key] && sessions.some((s) => s.name === prefs[key])) sessionSel.value = prefs[key];
    else {
      const pick = sessions.find((s) => s.running && !s.default) || sessions.find((s) => s.default) || sessions[0];
      if (pick) sessionSel.value = pick.name;
    }
  }

  // ---------- list ----------
  function paneTitle(p) {
    if (p.agent) return `${p.agent}${p.agent_name ? ' · ' + p.agent_name : ''}`;
    return 'shell';
  }

  function renderList(data) {
    listEl.replaceChildren();
    const byWs = new Map();
    for (const p of panes) {
      if (!byWs.has(p.workspace_id)) byWs.set(p.workspace_id, []);
      byWs.get(p.workspace_id).push(p);
    }
    if (!(data.workspaces || []).length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No workspaces in this session.';
      listEl.appendChild(empty);
      return;
    }
    for (const ws of data.workspaces) {
      const section = document.createElement('section');
      section.className = 'ws';
      const head = document.createElement('div');
      head.className = 'ws-head';
      const name = document.createElement('span');
      name.textContent = ws.label || ws.workspace_id;
      const id = document.createElement('span');
      id.className = 'ws-id';
      id.textContent = ws.workspace_id;
      head.append(name, id);
      section.appendChild(head);
      for (const p of byWs.get(ws.workspace_id) || []) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row' + (selected && selected.pane_id === p.pane_id ? ' selected' : '');
        const dot = document.createElement('span');
        dot.className = `dot ${p.agent ? statusClass(p.status) : 'unknown'}`;
        const main = document.createElement('span');
        main.className = 'row-main';
        const title = document.createElement('span');
        title.className = 'row-title';
        title.textContent = p.title ? `${paneTitle(p)} — ${p.title}` : paneTitle(p);
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        meta.textContent = `${p.pane_id} · ${p.cwd || ''}`;
        main.append(title, meta);
        row.append(dot, main);
        if (p.agent && p.status && p.status !== 'unknown') {
          const badge = document.createElement('span');
          badge.className = `badge ${p.status === 'blocked' ? 'blocked' : ''}`;
          badge.textContent = p.status;
          row.appendChild(badge);
        }
        row.addEventListener('click', () => selectPane(p));
        section.appendChild(row);
      }
      listEl.appendChild(section);
    }
  }

  async function refreshOverview(spin = true) {
    if (overviewBusy) return;
    overviewBusy = true;
    if (spin) refreshBtn.classList.add('spinning');
    const r = await request('overview', target());
    overviewBusy = false;
    refreshBtn.classList.remove('spinning');
    if (!r.ok) {
      setStatus(r.message, true);
      return;
    }
    panes = r.result.panes || [];
    const agents = r.result.agents || [];
    const counts = agents.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {});
    const parts = [`${agents.length} agent${agents.length === 1 ? '' : 's'}`];
    for (const k of ['working', 'blocked', 'done']) if (counts[k]) parts.push(`${counts[k]} ${k}`);
    setStatus(`${parts.join(' · ')} — updated ${new Date().toLocaleTimeString()}`, false);
    if (selected) {
      const fresh = panes.find((p) => p.pane_id === selected.pane_id);
      if (fresh) { selected = fresh; renderHead(); }
    }
    renderList(r.result);
  }

  // ---------- conversation ----------
  function renderHead() {
    if (!selected) return;
    headDot.className = `dot ${selected.agent ? statusClass(selected.status) : 'unknown'}`;
    headTitle.textContent = selected.title ? `${paneTitle(selected)} — ${selected.title}` : paneTitle(selected);
    headMeta.textContent = `${machineSel.value === 'local' ? 'This computer' : machineSel.value} · ${sessionSel.value || 'default'} · ${selected.pane_id} · ${selected.cwd || ''}`;
    headStatus.textContent = selected.agent && selected.status && selected.status !== 'unknown' ? selected.status : '';
    headStatus.className = `badge ${selected.status === 'blocked' ? 'blocked' : ''}`;
    input.placeholder = selected.agent ? `Message ${selected.agent}` : 'Run a command in this shell';
  }

  function atBottom() {
    return output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  }

  async function readSelected() {
    if (!selected || readBusy) return;
    readBusy = true;
    const paneId = selected.pane_id;
    const r = await request('read', { ...target(), target: paneId, lines: 600, source: 'recent-unwrapped' });
    readBusy = false;
    if (!selected || selected.pane_id !== paneId) return;
    const text = r.ok ? (r.result.output || '').replace(/\s+$/, '') : r.message;
    if (text === lastOutput) return;
    const stick = atBottom() || !lastOutput;
    lastOutput = text;
    output.textContent = text || '(no output yet)';
    if (stick) {
      output.scrollTop = output.scrollHeight;
      jumpBtn.hidden = true;
    } else {
      jumpBtn.hidden = false;
    }
  }

  function selectPane(p) {
    selected = p;
    lastOutput = '';
    output.textContent = 'Loading…';
    sendNote.textContent = '';
    placeholder.hidden = true;
    conversation.hidden = false;
    for (const row of listEl.querySelectorAll('.row')) row.classList.remove('selected');
    renderHead();
    prefs[`pane:${machineSel.value}:${sessionSel.value}`] = p.pane_id;
    savePrefs();
    refreshOverview(false);
    readSelected();
    scheduleRead();
    updateSend();
    input.focus();
  }

  function clearSelection() {
    selected = null;
    lastOutput = '';
    conversation.hidden = true;
    placeholder.hidden = false;
    clearInterval(readTimer);
  }

  function scheduleRead() {
    clearInterval(readTimer);
    readTimer = setInterval(() => { if (!document.hidden) readSelected(); }, isRemote() ? 3000 : 1500);
  }
  function scheduleOverview() {
    clearInterval(overviewTimer);
    overviewTimer = setInterval(() => { if (!document.hidden) refreshOverview(false); }, isRemote() ? 20000 : 8000);
  }

  function note(text, isError) {
    sendNote.textContent = text || '';
    sendNote.classList.toggle('error', !!isError);
  }

  function updateSend() {
    sendBtn.disabled = sending || !selected || !input.value.trim();
  }

  async function send() {
    if (!selected || sending) return;
    const text = input.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    if (text.startsWith('-')) {
      note('herdr cannot send text that starts with "-". Add a leading space.', true);
      return;
    }
    sending = true;
    updateSend();
    note('Sending…');
    const r = selected.agent
      ? await request('agents/prompt', { ...target(), target: selected.pane_id, text, wait: false })
      : await request('panes/run', { ...target(), pane_id: selected.pane_id, command: text });
    sending = false;
    if (r.ok) {
      input.value = '';
      autosize();
      note('Sent');
      setTimeout(() => { if (sendNote.textContent === 'Sent') note(''); }, 2000);
      setTimeout(readSelected, 400);
      setTimeout(() => refreshOverview(false), 1200);
    } else {
      note(r.message || 'Could not send.', true);
    }
    updateSend();
  }

  async function sendKey(key) {
    if (!selected) return;
    note(`Sending ${key}…`);
    const r = await request('keys', { ...target(), target: selected.pane_id, keys: [key] });
    if (r.ok) {
      note('');
      setTimeout(readSelected, 300);
      setTimeout(() => refreshOverview(false), 1200);
    } else {
      note(r.message || 'Could not send key.', true);
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(200, input.scrollHeight) + 'px';
  }

  // ---------- events ----------
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  for (const btn of document.querySelectorAll('.key')) {
    btn.addEventListener('click', () => sendKey(btn.dataset.key));
  }
  jumpBtn.addEventListener('click', () => { output.scrollTop = output.scrollHeight; jumpBtn.hidden = true; });
  output.addEventListener('scroll', () => { if (atBottom()) jumpBtn.hidden = true; });

  machineSel.addEventListener('change', async () => {
    prefs.machine = machineSel.value;
    savePrefs();
    clearSelection();
    await loadSessions();
    await refreshOverview();
    scheduleOverview();
    restoreSelection();
  });
  sessionSel.addEventListener('change', async () => {
    prefs[`session:${machineSel.value}`] = sessionSel.value;
    savePrefs();
    clearSelection();
    await refreshOverview();
    restoreSelection();
  });
  refreshBtn.addEventListener('click', () => { refreshOverview(); readSelected(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshOverview(false); readSelected(); }
  });

  for (const el of document.querySelectorAll('.scroll')) {
    let t = null;
    el.addEventListener('scroll', () => {
      el.classList.add('is-scrolling');
      clearTimeout(t);
      t = setTimeout(() => el.classList.remove('is-scrolling'), 2000);
    });
  }

  function restoreSelection() {
    const id = prefs[`pane:${machineSel.value}:${sessionSel.value}`];
    const p = id && panes.find((x) => x.pane_id === id);
    if (p) selectPane(p);
  }

  (async () => {
    setStatus('Connecting to herdr…');
    await loadMachines();
    await loadSessions();
    await refreshOverview();
    scheduleOverview();
    restoreSelection();
  })();
})();
