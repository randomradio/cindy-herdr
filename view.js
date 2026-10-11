(function () {
  'use strict';
  const GHOST_ID = 'herdr';
  const channel = new BroadcastChannel('herdr-panel');
  const waiters = new Map();
  const $ = (id) => document.getElementById(id);

  const machineSel = $('machine');
  const sessionSel = $('session');
  const refreshBtn = $('refresh');
  const newBtn = $('new-agent');
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
  const blockedBanner = $('blocked');

  const launchView = $('launch');
  const launchForm = $('launch-form');
  const launchWhere = $('launch-where');
  const fKind = $('f-kind');
  const fCwd = $('f-cwd');
  const fCwdList = $('f-cwd-list');
  const fWt = $('f-wt');
  const wtFields = $('wt-fields');
  const fBranch = $('f-branch');
  const fBase = $('f-base');
  const fName = $('f-name');
  const launchError = $('launch-error');
  const launchProgress = $('launch-progress');
  const launchProgressText = $('launch-progress-text');
  const launchCancel = $('launch-cancel');
  const launchSubmit = $('launch-submit');

  const menu = $('menu');
  const dialog = $('dialog');
  const dialogForm = $('dialog-form');
  const dialogTitle = $('dialog-title');
  const dialogBody = $('dialog-body');
  const dialogInput = $('dialog-input');
  const dialogError = $('dialog-error');
  const dialogCancel = $('dialog-cancel');
  const dialogOk = $('dialog-ok');

  // herdr's supported agent kinds; common ones first.
  const AGENT_KINDS = [
    ['claude', 'Claude Code'], ['codex', 'Codex'], ['pi', 'Pi'], ['grok', 'Grok'], ['cursor', 'Cursor'],
    ['gemini', 'Gemini'], ['opencode', 'OpenCode'], ['copilot', 'Copilot'], ['amp', 'Amp'],
    ['agy', 'agy'], ['cline', 'Cline'], ['devin', 'Devin'], ['droid', 'Droid'], ['hermes', 'Hermes'],
    ['kilo', 'Kilo'], ['kimi', 'Kimi'], ['kiro', 'Kiro'], ['maki', 'Maki'], ['mastracode', 'Mastra Code'],
    ['muse', 'Muse'], ['omp', 'omp'], ['qodercli', 'Qoder CLI'], ['qwen', 'Qwen'],
  ];
  const KIND_LABEL = new Map(AGENT_KINDS);
  const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

  const PREF_KEY = 'herdr-view-prefs';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { prefs = {}; }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

  let snapshot = { workspaces: [], panes: [] };
  let agentPanes = [];
  let selected = null; // agent pane object
  let overviewBusy = false;
  let readBusy = false;
  let overviewTimer = null;
  let readTimer = null;
  let lastOutput = '';
  let sending = false;
  let launching = false;
  let menuWs = null;
  let menuReturnFocus = null;

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
      let resend = null;
      let timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearInterval(resend);
        clearTimeout(timer);
        waiters.delete(reqId);
        resolve(v);
      };
      waiters.set(reqId, finish);
      const send = () => channel.postMessage({ type: 'request', reqId, method, params });
      send();
      resend = setInterval(send, 1000);
      timer = setTimeout(() => finish({ ok: false, message: 'Timed out waiting for herdr.' }), timeoutMs);
    });
  }

  const target = () => ({ machine: machineSel.value || 'local', session: sessionSel.value || undefined });
  const isRemote = () => (machineSel.value || 'local') !== 'local';
  const machineName = () => (machineSel.value === 'local' || !machineSel.value ? 'This computer' : machineSel.value);
  // Strip herdr's "CODE: " prefix for display.
  const friendly = (msg) => String(msg || 'Something went wrong.').replace(/^[A-Z][A-Z0-9_]{2,40}:\s*/, '');

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
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const statusClass = (s) => (['working', 'blocked', 'done', 'idle'].includes(s) ? s : 'unknown');
  const statusText = (s) => (s === 'blocked' ? 'Needs an answer' : s === 'working' ? 'Working' : s === 'done' ? 'Done' : s === 'idle' ? 'Idle' : '');
  const kindLabel = (k) => KIND_LABEL.get(k) || k || 'agent';
  function shortPath(p) {
    if (!p) return '';
    const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(p);
    return m ? '~' + (m[1] || '') : p;
  }

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
      setStatus(friendly(r.message), true);
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

  // ---------- agent list ----------
  function renderList() {
    listEl.replaceChildren();
    const byWs = new Map();
    for (const p of agentPanes) {
      if (!byWs.has(p.workspace_id)) byWs.set(p.workspace_id, []);
      byWs.get(p.workspace_id).push(p);
    }
    const shown = (snapshot.workspaces || []).filter((w) => byWs.has(w.workspace_id));
    if (!shown.length) {
      const empty = el('div', 'empty');
      empty.appendChild(el('p', 'empty-title', 'No agents in this session'));
      empty.appendChild(el('p', 'empty-body', 'Start one with New agent.'));
      listEl.appendChild(empty);
      return;
    }
    for (const ws of shown) {
      const section = el('section', 'ws');
      const head = el('div', 'ws-head');
      const name = el('span', 'ws-name', ws.label || ws.workspace_id);
      name.title = `${ws.label || ''} (${ws.workspace_id})`;
      head.appendChild(name);
      if (ws.worktree && ws.worktree.linked) {
        const chip = el('span', 'chip');
        chip.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-4 2.2-6.4 4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
        chip.appendChild(document.createTextNode('worktree'));
        chip.title = `Git worktree: ${shortPath(ws.worktree.path)}`;
        head.appendChild(chip);
      }
      const more = el('button', 'ws-more');
      more.type = 'button';
      more.setAttribute('aria-label', `Workspace actions for ${ws.label || ws.workspace_id}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.title = 'Workspace actions';
      more.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>';
      more.addEventListener('click', (e) => { e.stopPropagation(); openMenu(ws, more); });
      head.appendChild(more);
      section.appendChild(head);

      for (const p of byWs.get(ws.workspace_id)) {
        const row = el('button', 'row' + (selected && selected.pane_id === p.pane_id ? ' selected' : '') + (p.status === 'blocked' ? ' is-blocked' : ''));
        row.type = 'button';
        row.dataset.pane = p.pane_id;
        const dot = el('span', `dot ${statusClass(p.status)}`);
        const main = el('span', 'row-main');
        const title = el('span', 'row-title');
        title.appendChild(el('span', 'row-name', p.agent_name || kindLabel(p.agent)));
        if (p.agent_name) title.appendChild(el('span', 'row-kind', kindLabel(p.agent)));
        const meta = el('span', 'row-meta', p.title && p.title !== p.agent ? p.title : shortPath(p.cwd));
        meta.title = p.cwd || '';
        main.append(title, meta);
        row.append(dot, main);
        const st = statusText(p.status);
        if (st) row.appendChild(el('span', `badge ${statusClass(p.status)}`, st));
        row.addEventListener('click', () => selectPane(p));
        section.appendChild(row);
      }
      listEl.appendChild(section);
    }
  }

  function knownFolders() {
    const set = new Set(Array.isArray(prefs.recentCwds) ? prefs.recentCwds : []);
    for (const p of snapshot.panes || []) if (p.cwd && !isRemote()) set.add(shortPath(p.cwd));
    return [...set].slice(0, 20);
  }

  async function refreshOverview(spin = true) {
    if (overviewBusy) return;
    overviewBusy = true;
    if (spin) refreshBtn.classList.add('spinning');
    const r = await request('overview', target());
    overviewBusy = false;
    refreshBtn.classList.remove('spinning');
    if (!r.ok) {
      setStatus(friendly(r.message), true);
      return;
    }
    snapshot = r.result;
    agentPanes = (snapshot.panes || []).filter((p) => p.agent);
    const withAgents = new Set(agentPanes.map((p) => p.workspace_id));
    const hidden = (snapshot.workspaces || []).filter((w) => !withAgents.has(w.workspace_id)).length;
    const counts = agentPanes.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {});
    const parts = [`${agentPanes.length} agent${agentPanes.length === 1 ? '' : 's'}`];
    if (counts.blocked) parts.push(`${counts.blocked} need${counts.blocked === 1 ? 's' : ''} an answer`);
    if (counts.working) parts.push(`${counts.working} working`);
    if (counts.done) parts.push(`${counts.done} done`);
    let text = parts.join(' · ');
    if (hidden) text += ` · ${hidden} workspace${hidden === 1 ? '' : 's'} without agents hidden`;
    setStatus(text, false);
    statusEl.title = `Updated ${new Date().toLocaleTimeString()}`;
    if (selected) {
      const fresh = agentPanes.find((p) => p.pane_id === selected.pane_id);
      if (fresh) {
        selected = fresh;
        renderHead();
      } else {
        clearSelection();
        setStatus('The selected agent is no longer running.', false);
      }
    }
    renderList();
  }

  // ---------- conversation ----------
  function wsOf(p) {
    return (snapshot.workspaces || []).find((w) => w.workspace_id === p.workspace_id);
  }

  function renderHead() {
    if (!selected) return;
    const blocked = selected.status === 'blocked';
    headDot.className = `dot ${statusClass(selected.status)}`;
    headTitle.textContent = selected.agent_name ? `${selected.agent_name} · ${kindLabel(selected.agent)}` : kindLabel(selected.agent);
    const ws = wsOf(selected);
    headMeta.textContent = [machineName(), sessionSel.value || 'default', ws ? ws.label || ws.workspace_id : selected.workspace_id, shortPath(selected.cwd)]
      .filter(Boolean)
      .join(' · ');
    headMeta.title = selected.cwd || '';
    headStatus.textContent = statusText(selected.status);
    headStatus.className = `badge ${statusClass(selected.status)}`;
    blockedBanner.hidden = !blocked;
    conversation.classList.toggle('is-blocked', blocked);
    input.placeholder = blocked ? 'Type an answer (sent as keystrokes + Enter)' : `Message ${selected.agent_name || kindLabel(selected.agent)}`;
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
    const text = r.ok ? (r.result.output || '').replace(/\s+$/, '') : friendly(r.message);
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

  function showView(which) {
    placeholder.hidden = which !== 'placeholder';
    conversation.hidden = which !== 'conversation';
    launchView.hidden = which !== 'launch';
    newBtn.classList.toggle('active', which === 'launch');
  }

  function selectPane(p) {
    if (launching) return;
    selected = p;
    lastOutput = '';
    output.textContent = 'Loading…';
    note('');
    showView('conversation');
    for (const row of listEl.querySelectorAll('.row')) row.classList.toggle('selected', row.dataset.pane === p.pane_id);
    renderHead();
    prefs[`pane:${machineSel.value}:${sessionSel.value}`] = p.pane_id;
    savePrefs();
    readSelected();
    scheduleRead();
    updateSend();
    input.focus();
  }

  function clearSelection() {
    selected = null;
    lastOutput = '';
    clearInterval(readTimer);
    for (const row of listEl.querySelectorAll('.row.selected')) row.classList.remove('selected');
    if (!launchView.hidden) return;
    showView('placeholder');
  }

  function scheduleRead() {
    clearInterval(readTimer);
    readTimer = setInterval(() => { if (!document.hidden) readSelected(); }, isRemote() ? 3000 : 1500);
  }
  function scheduleOverview() {
    clearInterval(overviewTimer);
    overviewTimer = setInterval(() => { if (!document.hidden) refreshOverview(false); }, isRemote() ? 20000 : 6000);
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
    // A blocked agent rejects prompts; answer its question UI with keystrokes instead.
    const r = selected.status === 'blocked'
      ? await request('keys', { ...target(), target: selected.pane_id, text, keys: ['enter'] })
      : await request('agents/prompt', { ...target(), target: selected.pane_id, text, wait: false });
    sending = false;
    if (r.ok) {
      input.value = '';
      autosize();
      note('Sent');
      setTimeout(() => { if (sendNote.textContent === 'Sent') note(''); }, 2000);
      setTimeout(readSelected, 400);
      setTimeout(() => refreshOverview(false), 1200);
    } else {
      note(friendly(r.message) || 'Could not send.', true);
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
      note(friendly(r.message) || 'Could not send key.', true);
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(200, input.scrollHeight) + 'px';
  }

  // ---------- new agent ----------
  function fillKinds() {
    fKind.replaceChildren(...AGENT_KINDS.map(([k, label]) => option(k, label)));
    if (prefs.lastKind && KIND_LABEL.has(prefs.lastKind)) fKind.value = prefs.lastKind;
  }

  function openLaunch() {
    if (launching) { showView('launch'); return; }
    closeMenu();
    launchWhere.textContent = `On ${machineName()}, session “${sessionSel.value || 'default'}”.`;
    fCwdList.replaceChildren(...knownFolders().map((f) => option(f, f)));
    if (!fCwd.value) fCwd.value = prefs[`lastCwd:${machineSel.value}`] || '';
    setLaunchError('');
    clearInterval(readTimer);
    showView('launch');
    (fCwd.value ? fKind : fCwd).focus();
  }

  function closeLaunch() {
    if (launching) return;
    if (selected) {
      showView('conversation');
      scheduleRead();
    } else {
      showView('placeholder');
    }
  }

  function setLaunchError(text) {
    launchError.textContent = text || '';
    launchError.hidden = !text;
  }

  function setLaunchBusy(busy) {
    launching = busy;
    for (const c of launchForm.querySelectorAll('input, select')) c.disabled = busy;
    launchSubmit.disabled = busy;
    launchCancel.disabled = busy;
    launchProgress.hidden = !busy;
    machineSel.disabled = busy;
    sessionSel.disabled = busy;
  }

  async function submitLaunch(e) {
    e.preventDefault();
    if (launching) return;
    setLaunchError('');
    const kind = fKind.value;
    const cwd = fCwd.value.trim();
    const name = fName.value.trim();
    const worktree = fWt.checked;
    const branch = fBranch.value.trim();
    const base = fBase.value.trim();
    if (!cwd) { setLaunchError('Choose a folder.'); fCwd.focus(); return; }
    if (!(cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/'))) { setLaunchError('The folder must be an absolute path or start with ~/.'); fCwd.focus(); return; }
    if (name && !AGENT_NAME_RE.test(name)) { setLaunchError('The name must start with a lowercase letter and use only lowercase letters, digits, - or _ (up to 32).'); fName.focus(); return; }
    if (worktree) {
      if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) { setLaunchError('Enter a valid new branch name, e.g. feat/my-change.'); fBranch.focus(); return; }
      if (base && (!BRANCH_RE.test(base) || base.includes('..'))) { setLaunchError('The base branch name is not valid.'); fBase.focus(); return; }
    }

    const params = { ...target(), action: worktree ? 'worktree_create' : 'create', cwd, agent_kind: kind, timeout_ms: 60000 };
    if (name) { params.agent_name = name; params.label = name; }
    if (worktree) {
      params.branch = branch;
      if (base) params.base = base;
      if (!name) params.label = branch;
    }

    prefs.lastKind = kind;
    prefs[`lastCwd:${machineSel.value}`] = cwd;
    if (!isRemote()) prefs.recentCwds = [cwd, ...(prefs.recentCwds || []).filter((c) => c !== cwd)].slice(0, 8);
    savePrefs();

    setLaunchBusy(true);
    const started = Date.now();
    const what = worktree ? `Creating branch ${branch} and its worktree` : 'Creating the workspace';
    const tick = () => {
      const s = Math.round((Date.now() - started) / 1000);
      const stage = s < 3 ? `${what}…` : `Starting ${kindLabel(kind)}…`;
      launchProgressText.textContent = `${stage} ${s}s${s >= 10 ? ' · startup can take up to a minute' : ''}`;
    };
    tick();
    const ticker = setInterval(tick, 1000);
    const r = await request('workspaces/launch', params, 240000);
    clearInterval(ticker);
    setLaunchBusy(false);

    if (!r.ok) {
      setLaunchError(friendly(r.message));
      refreshOverview(false);
      return;
    }
    const res = r.result || {};
    fName.value = '';
    fBranch.value = '';
    fBase.value = '';
    await refreshOverview(false);
    const pane = agentPanes.find((p) => p.pane_id === res.pane_id);
    if (pane) selectPane(pane);
    else closeLaunch();
    const blocked = res.agent && res.agent.status === 'blocked';
    if (blocked) note(`${kindLabel(kind)} started and needs an answer before it can work.`, false);
    else note(`${kindLabel(kind)} is ready.`);
    if (res.note && !blocked) setStatus(res.note, false);
  }

  // ---------- workspace menu ----------
  function openMenu(ws, anchor) {
    if (menuWs && menuWs.workspace_id === ws.workspace_id && !menu.hidden) { closeMenu(); return; }
    menuWs = ws;
    if (menuReturnFocus) menuReturnFocus.setAttribute('aria-expanded', 'false');
    menuReturnFocus = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    const linked = !!(ws.worktree && ws.worktree.linked);
    menu.querySelector('[data-act="remove"]').hidden = !linked;
    menu.hidden = false;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = Math.min(a.right - m.width, window.innerWidth - m.width - 8);
    let top = a.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = a.top - m.height - 4;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    const first = menu.querySelector('button:not([hidden])');
    if (first) first.focus();
  }
  function closeMenu(restoreFocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (menuReturnFocus) menuReturnFocus.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menuReturnFocus) menuReturnFocus.focus();
  }

  async function menuAction(act) {
    const ws = menuWs;
    closeMenu();
    if (!ws) return;
    const wsName = ws.label || ws.workspace_id;
    const base = { ...target() };
    if (act === 'rename') {
      openDialog({
        title: 'Rename workspace',
        body: '',
        input: ws.label || '',
        ok: 'Rename',
        run: async (value) => {
          const label = value.trim();
          if (!label) return 'Enter a name.';
          if (label.startsWith('-')) return 'The name cannot start with "-".';
          const r = await request('workspaces/rename', { ...base, workspace_id: ws.workspace_id, label });
          return r.ok ? null : friendly(r.message);
        },
      });
    } else if (act === 'focus') {
      const r = await request('focus', { ...base, kind: 'workspace', id: ws.workspace_id });
      setStatus(r.ok ? `Switched herdr to “${wsName}”.` : friendly(r.message), !r.ok);
    } else if (act === 'close') {
      const linked = ws.worktree && ws.worktree.linked;
      openDialog({
        title: `Close “${wsName}”?`,
        body: `Every agent and process in this workspace will be stopped.${linked ? ' The worktree folder and its branch stay on disk; use Remove worktree to delete the folder.' : ''}`,
        ok: 'Close workspace',
        danger: true,
        run: async () => {
          const r = await request('close', { ...base, kind: 'workspace', id: ws.workspace_id });
          return r.ok ? null : friendly(r.message);
        },
      });
    } else if (act === 'remove') {
      openDialog({
        title: `Remove the worktree of “${wsName}”?`,
        body: `The workspace is closed, its agents are stopped and the checkout folder ${shortPath(ws.worktree && ws.worktree.path)} is deleted. The git branch is kept. herdr refuses if there are uncommitted changes.`,
        ok: 'Remove worktree',
        danger: true,
        run: async () => {
          const r = await request('close', { ...base, kind: 'worktree', id: ws.workspace_id });
          return r.ok ? null : friendly(r.message);
        },
      });
    }
  }

  // ---------- in-page dialog ----------
  let dialogRun = null;
  let dialogReturnFocus = null;
  function openDialog({ title, body, input: value, ok, danger, run }) {
    dialogReturnFocus = document.activeElement;
    dialogTitle.textContent = title;
    dialogBody.textContent = body || '';
    dialogBody.hidden = !body;
    dialogInput.hidden = value === undefined;
    dialogInput.value = value || '';
    dialogInput.disabled = false;
    dialogOk.textContent = ok;
    dialogOk.classList.toggle('danger', !!danger);
    dialogOk.classList.toggle('primary', !danger);
    dialogOk.disabled = false;
    dialogCancel.disabled = false;
    dialogError.hidden = true;
    dialogRun = run;
    dialog.hidden = false;
    if (value !== undefined) { dialogInput.focus(); dialogInput.select(); } else { dialogCancel.focus(); }
  }
  function closeDialog() {
    if (dialogOk.disabled && dialogRun) return; // busy
    dialog.hidden = true;
    dialogRun = null;
    if (dialogReturnFocus && document.contains(dialogReturnFocus)) dialogReturnFocus.focus();
  }
  async function submitDialog(e) {
    e.preventDefault();
    if (!dialogRun || dialogOk.disabled) return;
    dialogOk.disabled = true;
    dialogCancel.disabled = true;
    dialogInput.disabled = true;
    dialogError.hidden = true;
    const label = dialogOk.textContent;
    dialogOk.textContent = 'Working…';
    const err = await dialogRun(dialogInput.value);
    dialogOk.textContent = label;
    dialogOk.disabled = false;
    dialogCancel.disabled = false;
    dialogInput.disabled = false;
    if (err) {
      dialogError.textContent = err;
      dialogError.hidden = false;
      return;
    }
    dialogRun = null;
    dialog.hidden = true;
    await refreshOverview(false);
    if (dialogReturnFocus && document.contains(dialogReturnFocus)) dialogReturnFocus.focus();
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

  newBtn.addEventListener('click', openLaunch);
  launchCancel.addEventListener('click', closeLaunch);
  launchForm.addEventListener('submit', submitLaunch);
  fWt.addEventListener('change', () => {
    wtFields.hidden = !fWt.checked;
    if (fWt.checked) fBranch.focus();
  });
  fName.addEventListener('input', () => {
    const v = fName.value.toLowerCase().replace(/\s+/g, '-');
    if (v !== fName.value) fName.value = v;
  });

  for (const b of menu.querySelectorAll('button[data-act]')) b.addEventListener('click', () => menuAction(b.dataset.act));
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button:not([hidden])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') closeMenu();
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  window.addEventListener('resize', () => closeMenu());
  listEl.addEventListener('scroll', () => closeMenu());

  dialogForm.addEventListener('submit', submitDialog);
  dialogCancel.addEventListener('click', closeDialog);
  dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) closeDialog(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!dialog.hidden) { e.preventDefault(); closeDialog(); }
    else if (!menu.hidden) { e.preventDefault(); closeMenu(true); }
    else if (!launchView.hidden && !launching) { e.preventDefault(); closeLaunch(); }
  });

  machineSel.addEventListener('change', async () => {
    prefs.machine = machineSel.value;
    savePrefs();
    clearSelection();
    if (!launchView.hidden) closeLaunch();
    await loadSessions();
    await refreshOverview();
    scheduleOverview();
    restoreSelection();
  });
  sessionSel.addEventListener('change', async () => {
    prefs[`session:${machineSel.value}`] = sessionSel.value;
    savePrefs();
    clearSelection();
    if (!launchView.hidden) closeLaunch();
    await refreshOverview();
    restoreSelection();
  });
  refreshBtn.addEventListener('click', () => { refreshOverview(); readSelected(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshOverview(false); readSelected(); }
  });

  for (const scroller of document.querySelectorAll('.scroll')) {
    let t = null;
    scroller.addEventListener('scroll', () => {
      scroller.classList.add('is-scrolling');
      clearTimeout(t);
      t = setTimeout(() => scroller.classList.remove('is-scrolling'), 2000);
    });
  }

  function restoreSelection() {
    const id = prefs[`pane:${machineSel.value}:${sessionSel.value}`];
    const p = id && agentPanes.find((x) => x.pane_id === id);
    if (p) selectPane(p);
  }

  (async () => {
    fillKinds();
    setStatus('Connecting to herdr…');
    await loadMachines();
    await loadSessions();
    await refreshOverview();
    scheduleOverview();
    restoreSelection();
  })();
})();
