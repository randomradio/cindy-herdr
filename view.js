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
  const termWrap = $('term-wrap');
  const termEl = $('term');
  const termNote = $('term-note');
  const blockedBanner = $('blocked');
  const chatPanel = $('chat-panel');
  const terminalPanel = $('terminal-panel');
  const showChat = $('show-chat');
  const showTerminal = $('show-terminal');
  const chatList = $('chat-list');
  const chatEvents = $('chat-events');
  const chatOlder = $('chat-older');
  const chatNewer = $('chat-newer');
  const chatForm = $('chat-form');
  const chatInput = $('chat-input');
  const chatSend = $('chat-send');
  const chatNote = $('chat-note');
  const chatState = $('chat-state');
  const chatStateTitle = $('chat-state-title');
  const chatStateReason = $('chat-state-reason');
  const chatRetry = $('chat-retry');
  const chatOpenTerminal = $('chat-open-terminal');

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
  const CACHE_KEY = 'herdr-view-cache-v2';
  const CACHE_RECORDS = 120;
  const CACHE_CHATS = 12;
  const CACHE_MAX_BYTES = 480 * 1024;
  const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const utf8Bytes = (value) => new TextEncoder().encode(String(value)).length;
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { prefs = {}; }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };
  let viewCache = {};
  try { viewCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { viewCache = {}; }
  viewCache.chats = viewCache.chats && typeof viewCache.chats === 'object' ? viewCache.chats : {};
  let cacheTimer = null;
  let cacheDirty = false;
  let cacheSerialized = '';
  function overviewFingerprint(data) {
    return JSON.stringify({
      panes: (data.panes || []).map((p) => [p.pane_id, p.agent, p.status, p.workspace_id, p.cwd, p.agent_name, p.title]),
      workspaces: (data.workspaces || []).map((w) => [w.workspace_id, w.label, w.worktree?.linked, w.worktree?.path]),
    });
  }
  function trimViewCacheBytes() {
    const measure = () => utf8Bytes(JSON.stringify(viewCache));
    while (measure() > CACHE_MAX_BYTES) {
      const chatKeys = Object.keys(viewCache.chats || {}).sort((a, b) => viewCache.chats[a].at - viewCache.chats[b].at);
      const overviewKeys = Object.keys(viewCache.overviews || {}).sort((a, b) => viewCache.overviews[a].at - viewCache.overviews[b].at);
      if (chatKeys.length) delete viewCache.chats[chatKeys[0]];
      else if (overviewKeys.length) delete viewCache.overviews[overviewKeys[0]];
      else break;
    }
  }
  function persistViewCache() {
    trimViewCacheBytes();
    const payload = JSON.stringify(viewCache);
    if (payload === cacheSerialized) {
      cacheDirty = false;
      return true;
    }
    localStorage.setItem(CACHE_KEY, payload);
    cacheSerialized = payload;
    cacheDirty = false;
    return true;
  }
  function writeViewCache() {
    cacheDirty = true;
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      if (!cacheDirty) return;
      try {
        if (!persistViewCache()) return;
      } catch {
        const chatKeys = Object.keys(viewCache.chats || {}).sort((a, b) => viewCache.chats[a].at - viewCache.chats[b].at);
        if (chatKeys.length) delete viewCache.chats[chatKeys[0]];
        else {
          const overviewKeys = Object.keys(viewCache.overviews || {}).sort((a, b) => viewCache.overviews[a].at - viewCache.overviews[b].at);
          if (overviewKeys.length) delete viewCache.overviews[overviewKeys[0]];
        }
        try { persistViewCache(); } catch {}
      }
    }, 250);
  }

  let snapshot = { workspaces: [], panes: [] };
  let agentPanes = [];
  let selected = null; // agent pane object
  let overviewBusy = false;
  let overviewTimer = null;
  let launching = false;
  let menuWs = null;
  let menuReturnFocus = null;
  let contextGen = 0;
  function panelContext() {
    return `${machineSel.value || 'local'}\u0000${sessionSel.value || ''}\u0000${contextGen}`;
  }

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
  function renderMachines(machines) {
    machineSel.replaceChildren();
    for (const m of machines) {
      if (m.enabled === false) continue;
      machineSel.appendChild(option(m.label, m.label === 'local' ? 'This computer' : m.label));
    }
    if (prefs.machine && [...machineSel.options].some((o) => o.value === prefs.machine)) machineSel.value = prefs.machine;
  }
  function renderSessions(machine, sessions) {
    sessionSel.replaceChildren();
    for (const s of sessions) sessionSel.appendChild(option(s.name, s.running ? s.name : `${s.name} (stopped)`));
    const key = `session:${machine}`;
    if (prefs[key] && sessions.some((s) => s.name === prefs[key])) sessionSel.value = prefs[key];
    else {
      const pick = sessions.find((s) => s.running && !s.default) || sessions.find((s) => s.default) || sessions[0];
      if (pick) sessionSel.value = pick.name;
    }
  }
  async function loadMachines() {
    const r = await request('machines/list', {});
    const machines = r.ok ? r.result.machines : [{ label: 'local', enabled: true }];
    renderMachines(machines);
    if (r.ok) { viewCache.machines = machines; writeViewCache(); }
  }

  async function loadSessions() {
    const machine = machineSel.value || 'local';
    const ctx = panelContext();
    const cachedSessions = viewCache.sessions?.[machine];
    if (!cachedSessions) sessionSel.replaceChildren(option('', 'Loading…'));
    const r = await request('sessions/list', { machine });
    if (ctx !== panelContext()) return;
    if (!r.ok) {
      if (!cachedSessions) {
        sessionSel.replaceChildren(option('', 'Default'));
        setStatus(friendly(r.message), true);
      }
      return;
    }
    const sessions = (r.result.result && r.result.result.sessions) || [];
    renderSessions(machine, sessions);
    const prev = viewCache.sessions?.[machine];
    if (JSON.stringify(prev) !== JSON.stringify(sessions)) {
      viewCache.sessions = { ...(viewCache.sessions || {}), [machine]: sessions };
      writeViewCache();
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

  function overviewKey() {
    return `${machineSel.value || 'local'}\u0000${sessionSel.value || ''}`;
  }
  function applyOverview(data, cachedAt) {
    snapshot = data;
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
    if (cachedAt) text += ' · Showing saved view, refreshing…';
    setStatus(text, false);
    statusEl.title = cachedAt ? `Saved ${new Date(cachedAt).toLocaleString()}` : `Updated ${new Date().toLocaleTimeString()}`;
    renderList();
  }
  function restoreCachedOverview() {
    const cached = viewCache.overviews?.[overviewKey()];
    if (!cached || Date.now() - cached.at > CACHE_MAX_AGE) return false;
    applyOverview(cached.data, cached.at);
    return true;
  }

  async function refreshOverview(spin = true) {
    if (overviewBusy) return;
    overviewBusy = true;
    if (spin) refreshBtn.classList.add('spinning');
    const key = overviewKey();
    const ctx = panelContext();
    const r = await request('overview', target());
    overviewBusy = false;
    refreshBtn.classList.remove('spinning');
    if (key !== overviewKey() || ctx !== panelContext()) return;
    if (!r.ok) {
      setStatus(friendly(r.message), true);
      return;
    }
    applyOverview(r.result);
    const fp = overviewFingerprint(r.result);
    const prev = viewCache.overviews?.[key];
    if (!prev || prev.fp !== fp) {
      viewCache.overviews = { ...(viewCache.overviews || {}), [key]: { at: Date.now(), fp, data: r.result } };
      writeViewCache();
    }
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
  }

  // ---------- chat transcript ----------
  let viewMode = 'terminal';
  let chatTimer = null;
  let chatGeneration = 0;
  let chatBusy = false;
  let chatReady = false;
  let chatVerified = false;
  let chatSending = false;
  let chatIdentity = null;
  let chatNext = 0;
  let chatPrevious = null;
  let chatRangeStart = null;
  let chatRangeEnd = null;
  let chatOlderAvailable = false;
  let chatPollBackoff = 1000;
  let chatBrowsingAway = false;
  let chatLiveEnd = 0;
  let chatTailRecords = [];
  let chatIds = new Set();
  let chatCacheEvents = [];
  const MAX_CHAT_NODES = 240;
  function eventsToRecords(events) {
    const byByte = new Map();
    for (const event of events) {
      if (!Number.isFinite(event.byte)) continue;
      if (!byByte.has(event.byte)) byByte.set(event.byte, { byte: event.byte, endByte: event.endByte || event.byte, events: [] });
      const rec = byByte.get(event.byte);
      if (Number.isFinite(event.endByte)) rec.endByte = event.endByte;
      rec.events.push(event);
    }
    return [...byByte.values()].sort((a, b) => a.byte - b.byte);
  }
  function mergeTailRecords(records) {
    const map = new Map(chatTailRecords.map((r) => [r.byte, r]));
    for (const rec of records) map.set(rec.byte, rec);
    let merged = [...map.values()].sort((a, b) => a.byte - b.byte);
    while (merged.length > CACHE_RECORDS) merged = merged.slice(-CACHE_RECORDS);
    return merged;
  }
  function trimViewportRecords(records) {
    let list = records.slice();
    while (list.length > CACHE_RECORDS) list = list.slice(0, CACHE_RECORDS);
    return list;
  }
  function flattenRecords(records) {
    return records.flatMap((r) => r.events);
  }
  function updateChatNavButtons() {
    chatOlder.hidden = !chatOlderAvailable;
    chatNewer.hidden = !chatBrowsingAway && !(chatLiveEnd > (chatRangeEnd ?? chatLiveEnd));
  }
  function chatKey(pane = selected) {
    return pane ? `${machineSel.value || 'local'}\u0000${sessionSel.value || ''}\u0000${pane.pane_id}` : '';
  }
  function syncViewportRangeFromRecords(records) {
    if (!records.length) return;
    chatRangeStart = records[0].byte;
    chatPrevious = records[0].byte;
    chatRangeEnd = records[records.length - 1].endByte;
    chatOlderAvailable = records[0].byte > 0;
  }
  function saveChatCache() {
    if (!selected || !chatIdentity || !chatTailRecords.length) return;
    const entry = {
      cacheVersion: 2,
      identity: chatIdentity,
      tailEnd: chatLiveEnd,
      tailRecords: chatTailRecords.slice(-CACHE_RECORDS),
      hasOlder: chatTailRecords[0]?.byte > 0,
    };
    const prev = viewCache.chats[chatKey()];
    if (prev && prev.cacheVersion === 2 && prev.identity === entry.identity && prev.tailEnd === entry.tailEnd
      && JSON.stringify(prev.tailRecords) === JSON.stringify(entry.tailRecords)) return;
    entry.at = Date.now();
    viewCache.chats[chatKey()] = entry;
    const keys = Object.keys(viewCache.chats).sort((a, b) => viewCache.chats[b].at - viewCache.chats[a].at);
    for (const key of keys.slice(CACHE_CHATS)) delete viewCache.chats[key];
    writeViewCache();
  }
  function restoreChatCache(p) {
    const cached = viewCache.chats[chatKey(p)];
    if (!cached || cached.cacheVersion !== 2 || Date.now() - cached.at > CACHE_MAX_AGE || !cached.identity) return false;
    if (!Array.isArray(cached.tailRecords) || !cached.tailRecords.length) return false;
    if (!cached.tailRecords.every((r) => Number.isFinite(r.byte) && Number.isFinite(r.endByte) && Array.isArray(r.events))) return false;
    chatIdentity = cached.identity;
    chatTailRecords = cached.tailRecords.slice(-CACHE_RECORDS);
    chatLiveEnd = cached.tailEnd ?? chatTailRecords[chatTailRecords.length - 1].endByte;
    chatNext = chatLiveEnd;
    chatBrowsingAway = false;
    syncViewportRangeFromRecords(chatTailRecords);
    chatVerified = false;
    chatCacheEvents = flattenRecords(chatTailRecords);
    insertChat(chatCacheEvents, false, false);
    chatList.scrollTop = chatList.scrollHeight;
    updateChatNavButtons();
    chatReady = false;
    chatState.hidden = true;
    updateChatComposer();
    chatStatus('Showing saved conversation, checking for new messages…');
    return true;
  }
  function jumpToLatestChat() {
    if (!chatTailRecords.length) return;
    chatBrowsingAway = false;
    chatEvents.replaceChildren();
    chatIds = new Set();
    chatCacheEvents = flattenRecords(chatTailRecords);
    insertChat(chatCacheEvents, false, false);
    syncViewportRangeFromRecords(chatTailRecords);
    chatNext = chatLiveEnd;
    chatList.scrollTop = chatList.scrollHeight;
    updateChatNavButtons();
    scheduleChat(0);
  }
  function chatStatus(message, error = false) {
    chatNote.textContent = message || '';
    chatNote.classList.toggle('error', error);
  }
  function updateChatComposer() {
    const blocked = selected?.status === 'blocked';
    chatInput.disabled = !chatReady || !chatVerified || blocked || chatSending;
    chatSend.disabled = chatInput.disabled;
    chatInput.placeholder = blocked ? 'Answer this question in Terminal' : !chatReady
      ? 'Conversation history is not connected yet'
      : 'Message the agent · Enter to send, Shift+Enter for a new line';
  }
  function historyState(title, reason) {
    chatReady = false;
    chatState.hidden = false;
    chatStateTitle.textContent = title;
    chatStateReason.textContent = reason;
    updateChatComposer();
  }
  function switchMode(mode) {
    viewMode = mode;
    chatPanel.hidden = mode !== 'chat';
    terminalPanel.hidden = mode !== 'terminal';
    showChat.setAttribute('aria-pressed', String(mode === 'chat'));
    showTerminal.setAttribute('aria-pressed', String(mode === 'terminal'));
    if (mode === 'terminal') {
      clearTimeout(chatTimer);
      if (selected && termPane !== selected.pane_id) startMirror(selected);
      else schedulePoll(0);
      if (term) term.focus();
    } else {
      clearTimeout(pollTimer);
      if (selected) scheduleChat(0);
      chatInput.focus();
    }
  }
  function stopChat() {
    chatGeneration++;
    clearTimeout(chatTimer);
    chatIdentity = null;
    chatReady = false;
    chatVerified = false;
    chatState.hidden = true;
    updateChatComposer();
    chatNext = 0;
    chatPrevious = null;
    chatRangeStart = null;
    chatRangeEnd = null;
    chatOlderAvailable = false;
    chatPollBackoff = 1000;
    chatBrowsingAway = false;
    chatLiveEnd = 0;
    chatTailRecords = [];
    chatIds = new Set();
    chatCacheEvents = [];
    chatEvents.replaceChildren();
    chatOlder.hidden = true;
    chatNewer.hidden = true;
  }
  function startChat(p) {
    stopChat();
    if (!restoreChatCache(p)) {
      chatStatus('Loading conversation…');
      historyState('Loading conversation…', 'Looking for the session reported by herdr.');
    }
    if (viewMode === 'chat') scheduleChat(0);
  }
  function insertChat(events, older = false, remember = true) {
    const stick = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
    const oldHeight = chatList.scrollHeight;
    const fragment = document.createDocumentFragment();
    const added = [];
    for (const event of events) {
      if (chatIds.has(event.id)) continue;
      const node = window.HerdrChat.render(event);
      if (!node) continue;
      node.dataset.eventId = event.id;
      chatIds.add(event.id);
      fragment.appendChild(node);
      added.push(event);
    }
    if (remember && added.length) {
      const incoming = eventsToRecords(added);
      if (older) {
        let merged = [...incoming, ...eventsToRecords(chatCacheEvents)];
        const byByte = new Map();
        for (const rec of merged) byByte.set(rec.byte, rec);
        merged = trimViewportRecords([...byByte.values()].sort((a, b) => a.byte - b.byte));
        chatCacheEvents = flattenRecords(merged);
        syncViewportRangeFromRecords(merged);
      } else {
        chatCacheEvents = [...chatCacheEvents, ...added];
      }
    }
    if (older) {
      chatEvents.prepend(fragment);
      chatList.scrollTop += chatList.scrollHeight - oldHeight;
    } else {
      chatEvents.appendChild(fragment);
      if (stick) chatList.scrollTop = chatList.scrollHeight;
    }
    while (chatEvents.childElementCount > MAX_CHAT_NODES) {
      const victim = older ? chatEvents.lastElementChild : chatEvents.firstElementChild;
      chatIds.delete(victim.dataset.eventId);
      victim.remove();
    }
  }
  function scheduleChat(delay) {
    clearTimeout(chatTimer);
    if (!selected || document.hidden || conversation.hidden || viewMode !== 'chat') return;
    chatTimer = setTimeout(pollChat, delay === undefined ? (selected.status === 'working' ? 1000 : 4000) : delay);
  }
  async function pollChat(before) {
    if (chatBusy || !selected || viewMode !== 'chat' || conversation.hidden || document.hidden) return;
    chatBusy = true;
    const generation = chatGeneration;
    const pane = selected.pane_id;
    const ctx = panelContext();
    const rangeStart = chatRangeStart ?? chatPrevious ?? 0;
    const r = await request('chat/history', {
      ...target(), target: pane, identity: chatIdentity || undefined,
      ...(before ? { before: rangeStart } : chatIdentity ? { after: chatLiveEnd || chatNext } : {}),
    }, 20000);
    chatBusy = false;
    if (generation !== chatGeneration || !selected || selected.pane_id !== pane || ctx !== panelContext()) {
      scheduleChat(0);
      return;
    }
    if (!r.ok) {
      chatPollBackoff = Math.min((chatPollBackoff || 1000) * 2, 30000);
      if (chatVerified) {
        chatStatus(friendly(r.message) + ' Retrying…', true);
        scheduleChat(chatPollBackoff);
        return;
      }
      historyState('Could not load conversation', friendly(r.message) + ' Retry or open Terminal.');
      chatStatus('');
      scheduleChat(chatPollBackoff);
      return;
    }
    chatPollBackoff = 1000;
    const data = r.result;
    if (!data.available) {
      // A missing transcript is a content state, never a reason to override the chosen view.
      // Stop automatic polling here; Retry explicitly checks for a newly reported session.
      delete viewCache.chats[chatKey()];
      writeViewCache();
      stopChat();
      historyState('Chat history is unavailable', (data.reason || 'No matching transcript.') + ' Retry when the transcript is available, or open Terminal.');
      chatStatus('');
      return;
    }
    if (chatIdentity && (chatIdentity !== data.identity || data.reset)) {
      delete viewCache.chats[chatKey()];
      writeViewCache();
      stopChat();
      chatStatus('Agent session changed; loading new conversation…');
      scheduleChat(0);
      return;
    }
    chatIdentity = data.identity;
    chatVerified = true;
    chatReady = true;
    chatState.hidden = true;
    updateChatComposer();
    const chatNextBefore = chatNext;
    const pageRecords = eventsToRecords(data.events || []);
    if (before) {
      chatBrowsingAway = true;
      chatRangeStart = data.rangeStart ?? data.previous;
      chatPrevious = chatRangeStart;
      chatOlderAvailable = data.has_older;
      insertChat(data.events || [], true);
    } else {
      chatLiveEnd = data.rangeEnd ?? data.next;
      chatTailRecords = mergeTailRecords(pageRecords);
      chatNext = chatLiveEnd;
      if (!chatBrowsingAway) {
        chatRangeEnd = chatLiveEnd;
        if (chatRangeStart === null) {
          chatRangeStart = chatTailRecords[0]?.byte ?? data.rangeStart ?? data.previous ?? 0;
          chatPrevious = chatRangeStart;
          chatOlderAvailable = data.has_older;
        }
        insertChat(data.events || [], false);
      }
    }
    saveChatCache();
    updateChatNavButtons();
    chatStatus(selected.status === 'blocked' ? 'Needs an answer. Open Terminal to respond.' : chatEvents.childElementCount ? '' : 'This conversation has no messages yet.');
    if (data.has_newer && !before && data.next > (chatNextBefore || 0)) scheduleChat(100);
    else scheduleChat();
  }
  showChat.addEventListener('click', () => switchMode('chat'));
  showTerminal.addEventListener('click', () => switchMode('terminal'));
  chatOpenTerminal.addEventListener('click', () => switchMode('terminal'));
  chatRetry.addEventListener('click', () => {
    chatStateTitle.textContent = 'Loading conversation…';
    scheduleChat(0);
  });
  chatOlder.addEventListener('click', () => { if (chatOlderAvailable) pollChat(true); });
  chatNewer.addEventListener('click', () => jumpToLatestChat());
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatForm.requestSubmit(); }
  });
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected || !chatReady || !chatVerified || !chatIdentity || selected.status === 'blocked' || chatSending) return;
    const value = chatInput.value.trim();
    if (!value) return;
    chatSending = true;
    updateChatComposer();
    chatStatus('Sending…');
    const generation = chatGeneration;
    const pane = selected.pane_id;
    const r = await request('chat/prompt', { ...target(), target: pane, identity: chatIdentity, text: value });
    chatSending = false;
    updateChatComposer();
    if (generation !== chatGeneration || !selected || selected.pane_id !== pane) return;
    if (!r.ok || r.result?.ok === false) { chatStatus(friendly(r.message || r.result?.message), true); return; }
    chatInput.value = '';
    chatStatus('Sent. Waiting for the agent…');
    scheduleChat(100);
  });

  // ---------- live terminal (xterm mirror of the herdr pane) ----------
  // herdr has no output stream, so the page polls the pane's visible screen (with colors)
  // and repaints xterm when it changes; xterm's keystrokes are written raw to the pane.
  function wsOf(p) {
    return (snapshot.workspaces || []).find((w) => w.workspace_id === p.workspace_id);
  }

  let term = null;
  let termPane = null; // pane id currently mirrored
  let termHash = '';
  let termCols = 0;
  let termRows = 0;
  let pollTimer = null;
  let polling = false;
  let pollGen = 0;
  let inputBuf = '';
  let inputBusy = false;
  let inputPane = null;
  let fastUntil = 0;
  let termError = false;

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  const isDark = () => {
    const scheme = (getComputedStyle(document.documentElement).colorScheme || '').trim();
    return scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  };
  // Standard ANSI palettes for terminal content; background/foreground follow Cindy's theme.
  const PALETTE_DARK = { black: '#2e3436', red: '#ef5350', green: '#66bb6a', yellow: '#e0b341', blue: '#5c9cf5', magenta: '#c678dd', cyan: '#4fc1c9', white: '#d0d0cc', brightBlack: '#7a7a76', brightRed: '#ff7b72', brightGreen: '#8ddf8f', brightYellow: '#f2d16b', brightBlue: '#82b1ff', brightMagenta: '#e09cf0', brightCyan: '#7fdbe2', brightWhite: '#f5f5f2' };
  const PALETTE_LIGHT = { black: '#1a1a1a', red: '#c62828', green: '#2e7d32', yellow: '#946200', blue: '#1f5fbf', magenta: '#8e3fa8', cyan: '#00777f', white: '#8a8a85', brightBlack: '#5c5c58', brightRed: '#e53935', brightGreen: '#43a047', brightYellow: '#b07800', brightBlue: '#3b7be0', brightMagenta: '#a94fc4', brightCyan: '#0097a0', brightWhite: '#3a3a38' };
  function termTheme() {
    return {
      ...(isDark() ? PALETTE_DARK : PALETTE_LIGHT),
      background: cssVar('--surface', isDark() ? '#232322' : '#fbfbfa'),
      foreground: cssVar('--text-primary', isDark() ? '#ececea' : '#1a1a1a'),
      cursor: 'rgba(0,0,0,0)',
      cursorAccent: 'rgba(0,0,0,0)',
      selectionBackground: cssVar('--accent-soft', 'rgba(127,127,127,0.3)'),
    };
  }
  let lastThemeKey = '';
  function applyTermTheme() {
    if (!term) return;
    const t = termTheme();
    const key = JSON.stringify(t);
    if (key === lastThemeKey) return;
    lastThemeKey = key;
    term.options.theme = t;
  }

  function ensureTerm() {
    if (term) return term;
    if (typeof Terminal !== 'function') {
      setTermNote('The terminal component failed to load.', true);
      return null;
    }
    term = new Terminal({
      cols: 120,
      rows: 40,
      scrollback: 0,
      convertEol: false,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      allowProposedApi: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      theme: termTheme(),
    });
    term.open(termEl);
    // Agents enable bracketed paste in their real terminal; mirror that so pastes stay one prompt.
    term.write('\x1b[?2004h\x1b[?25l');
    term.onData((data) => sendInput(data));
    term.onBinary((data) => sendInput(data));
    term.textarea && term.textarea.setAttribute('aria-label', 'Agent terminal input');
    return term;
  }

  // Font size that fits the pane's columns into the available width (9-14px).
  let charRatio = 0;
  function fitFont() {
    if (!term || !termCols) return;
    if (!charRatio) {
      const c = document.createElement('canvas').getContext('2d');
      c.font = `100px ${term.options.fontFamily}`;
      charRatio = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    }
    const width = termWrap.clientWidth - 24;
    const size = Math.max(9, Math.min(14, Math.floor((width / termCols / charRatio) * 2) / 2));
    if (term.options.fontSize !== size) term.options.fontSize = size;
  }

  function paint(screen) {
    const t = ensureTerm();
    if (!t) return;
    const pane = selected || {};
    const cols = Math.max(screen.cols || 0, pane.cols || 0, 20);
    const rows = Math.max(pane.rows || 0, screen.rows || 0, 5);
    if (cols !== termCols || rows !== termRows) {
      termCols = cols;
      termRows = rows;
      t.resize(cols, rows);
      fitFont();
    }
    // Use absolute row positions: a line exactly as wide as the pane must not wrap the next row.
    const lines = String(screen.text || '').split('\r\n').slice(0, rows);
    let out = '\x1b[0m\x1b[2J';
    for (let i = 0; i < lines.length; i++) out += `\x1b[${i + 1};1H` + lines[i] + '\x1b[0m';
    out += '\x1b[?25l';
    const stick = termWrap.scrollHeight - termWrap.scrollTop - termWrap.clientHeight < 24;
    t.write(out, () => { if (stick) termWrap.scrollTop = termWrap.scrollHeight; });
  }

  function setTermNote(text, isError) {
    termNote.textContent = text || '';
    termNote.classList.toggle('error', !!isError);
  }

  async function pollScreen() {
    clearTimeout(pollTimer);
    if (!selected || conversation.hidden || terminalPanel.hidden || polling) return;
    polling = true;
    const gen = pollGen;
    const pane = selected.pane_id;
    const ctx = panelContext();
    const r = await request('term/screen', { ...target(), target: pane, since: termHash || undefined }, 15000);
    polling = false;
    if (gen !== pollGen || !selected || selected.pane_id !== pane || ctx !== panelContext()) {
      if (selected) schedulePoll(0);
      return;
    }
    if (r.ok) {
      if (termError) { termError = false; setTermNote(''); }
      if (!r.result.unchanged) {
        termHash = r.result.hash;
        paint(r.result);
      }
    } else {
      termError = true;
      setTermNote(friendly(r.message), true);
    }
    schedulePoll(r.ok ? undefined : 2000);
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!selected || conversation.hidden || terminalPanel.hidden || document.hidden) return;
    const fast = Date.now() < fastUntil;
    const base = isRemote() ? (fast ? 250 : 900) : (fast ? 60 : 250);
    pollTimer = setTimeout(pollScreen, delay === undefined ? base : delay);
  }

  // Coalesce keystrokes so typing stays in order with one request in flight.
  function sendInput(data) {
    if (!selected || !data) return;
    if (inputPane !== selected.pane_id) {
      inputBuf = '';
      inputPane = selected.pane_id;
    }
    inputBuf += data;
    fastUntil = Date.now() + 2500;
    flushInput();
  }
  async function flushInput() {
    if (inputBusy || !inputBuf || !selected) return;
    inputBusy = true;
    const data = inputBuf;
    inputBuf = '';
    const pane = inputPane;
    const ctx = panelContext();
    const r = await request('term/input', { ...target(), target: pane, data }, 15000);
    inputBusy = false;
    if (pane !== (selected && selected.pane_id) || ctx !== panelContext()) {
      if (inputBuf) flushInput();
      return;
    }
    if (!r.ok) setTermNote(`Input not delivered: ${friendly(r.message)}`, true);
    else if (termError) setTermNote('');
    if (!polling) schedulePoll(20);
    if (inputBuf) flushInput();
    if (/[\r\x03\x1b]/.test(data)) setTimeout(() => refreshOverview(false), 1200);
  }

  function startMirror(p) {
    pollGen += 1;
    polling = false;
    termPane = p.pane_id;
    termHash = '';
    inputBuf = '';
    inputPane = p.pane_id;
    termCols = 0;
    termRows = 0;
    const t = ensureTerm();
    if (t) {
      t.reset();
      t.write('\x1b[?2004h\x1b[?25l\x1b[2mConnecting to the pane…\x1b[0m');
      applyTermTheme();
    }
    setTermNote('');
    pollScreen();
  }
  function stopMirror() {
    pollGen += 1;
    clearTimeout(pollTimer);
    termPane = null;
    inputBuf = '';
    inputPane = null;
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
    updateChatComposer();
    if (blocked && viewMode === 'chat' && chatReady) chatStatus('Needs an answer. Open Terminal to respond.');
    conversation.classList.toggle('is-blocked', blocked);
  }

  function showView(which) {
    placeholder.hidden = which !== 'placeholder';
    conversation.hidden = which !== 'conversation';
    launchView.hidden = which !== 'launch';
    newBtn.classList.toggle('active', which === 'launch');
    if (which === 'conversation' && viewMode === 'terminal') requestAnimationFrame(fitFont);
  }

  function selectPane(p) {
    if (launching) return;
    const same = selected && selected.pane_id === p.pane_id && (
      (viewMode === 'chat' && chatIdentity) || (viewMode === 'terminal' && termPane === p.pane_id)
    );
    selected = p;
    showView('conversation');
    for (const row of listEl.querySelectorAll('.row')) row.classList.toggle('selected', row.dataset.pane === p.pane_id);
    renderHead();
    prefs[`pane:${machineSel.value}:${sessionSel.value}`] = p.pane_id;
    savePrefs();
    if (!same) {
      stopMirror();
      startChat(p);
    }
    if (viewMode === 'terminal') {
      if (termPane !== p.pane_id) startMirror(p);
      else schedulePoll(0);
      if (term) term.focus();
    }
  }

  function clearSelection() {
    selected = null;
    stopMirror();
    stopChat();
    for (const row of listEl.querySelectorAll('.row.selected')) row.classList.remove('selected');
    if (!launchView.hidden) return;
    showView('placeholder');
  }

  function scheduleOverview() {
    clearInterval(overviewTimer);
    overviewTimer = setInterval(() => { if (!document.hidden) refreshOverview(false); }, isRemote() ? 15000 : 4000);
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
    clearTimeout(pollTimer);
    clearTimeout(chatTimer);
    showView('launch');
    (fCwd.value ? fKind : fCwd).focus();
  }

  function closeLaunch() {
    if (launching) return;
    if (selected) {
      showView('conversation');
      if (viewMode === 'chat') scheduleChat(0);
      else schedulePoll(0);
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
    if (blocked) setTermNote(`${kindLabel(kind)} started and needs an answer in the terminal before it can work.`, false);
    else setTermNote(`${kindLabel(kind)} is ready.`);
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
  // Keep the terminal fitted to the page and in step with Cindy's light/dark theme.
  new ResizeObserver(() => fitFont()).observe(termWrap);
  new MutationObserver(applyTermTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  new MutationObserver(applyTermTheme).observe(document.head, { childList: true, subtree: true, characterData: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTermTheme);
  termWrap.addEventListener('mousedown', (e) => { if (term && e.target === termWrap) { e.preventDefault(); term.focus(); } });

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
    contextGen++;
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
    contextGen++;
    prefs[`session:${machineSel.value}`] = sessionSel.value;
    savePrefs();
    clearSelection();
    if (!launchView.hidden) closeLaunch();
    await refreshOverview();
    restoreSelection();
  });
  refreshBtn.addEventListener('click', () => { refreshOverview(); termHash = ''; schedulePoll(0); scheduleChat(0); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshOverview(false); schedulePoll(0); scheduleChat(0); }
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
    if (p && (!selected || selected.pane_id !== p.pane_id)) selectPane(p);
  }

  (async () => {
    fillKinds();
    switchMode('chat');
    // Paint the last herdr view from local storage first; the network refresh follows.
    const savedMachines = Array.isArray(viewCache.machines) ? viewCache.machines : null;
    const savedMachine = prefs.machine || 'local';
    const savedSessions = viewCache.sessions?.[savedMachine];
    let paintedFromCache = false;
    if (savedMachines && Array.isArray(savedSessions)) {
      renderMachines(savedMachines);
      renderSessions(machineSel.value || 'local', savedSessions);
      paintedFromCache = restoreCachedOverview();
      if (paintedFromCache) restoreSelection();
    }
    if (!paintedFromCache) setStatus('Connecting to herdr…');
    const cachedMachine = machineSel.value;
    const cachedSession = sessionSel.value;
    await loadMachines();
    await loadSessions();
    if (machineSel.value !== cachedMachine || sessionSel.value !== cachedSession) {
      clearSelection();
      restoreCachedOverview();
    }
    await refreshOverview(!paintedFromCache);
    scheduleOverview();
    restoreSelection();
  })();
})();
