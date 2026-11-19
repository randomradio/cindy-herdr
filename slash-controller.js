// Native agent completions rendered as browser controls. The server owns menu
// contents and keyboard semantics; this controller owns browser focus and drafts.
(function () {
  'use strict';
  class SlashController {
    constructor({ input, menu, list, preview, dismiss, fullTerminal, request, capture, valid, status, change, terminal }) {
      Object.assign(this, { input, menu, list, preview, request, capture, valid, status, change, terminal });
      this.session = null;
      input.addEventListener('input', e => {
        if (e.isComposing) return;
        if (!this.session && input.value === '/') this.open('/');
        else if (this.session) this.edit();
      });
      input.addEventListener('compositionend', () => { if (this.session) this.edit(); });
      input.addEventListener('keydown', e => this.keydown(e));
      dismiss.addEventListener('click', () => this.cancel());
      fullTerminal.addEventListener('click', () => { this.reset(); terminal(); });
      // Keep typing in the textarea even when an option is clicked.
      list.addEventListener('mousedown', e => e.preventDefault());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(this.session?.timer);
        else if (this.session) this.schedule(this.session, 0);
      });
    }
    get active() { return !!this.session; }
    get locked() { return !!this.session?.locked; }
    reset() {
      if (this.session) clearTimeout(this.session.timer);
      this.session = null;
      this.menu.hidden = true;
      this.list.replaceChildren();
      this.input.removeAttribute('aria-activedescendant');
      this.input.setAttribute('aria-expanded', 'false');
      this.change();
    }
    live(s) { return this.session === s && this.valid(s.target); }
    async open(prefix = '/') {
      if (this.active) return;
      const target = this.capture();
      if (!target) return;
      const savedDraft = this.input.value.startsWith('/') ? '' : this.input.value;
      const s = { target, savedDraft, native: '', actions: [{ operation: 'open', text: prefix }], busy: false, locked: true, revision: 0, timer: null };
      this.session = s;
      this.input.value = prefix;
      this.menu.hidden = false;
      this.preview.textContent = 'Loading agent commands…';
      this.preview.hidden = false;
      this.list.replaceChildren();
      this.status('');
      this.change();
      await this.pump(s);
      if (this.live(s)) this.input.focus();
    }
    edit() {
      const s = this.session;
      if (!s || s.locked) return;
      // Browser text editing (selection replacement, paste, IME) stays local
      // until the next coalesced update. Never turn pasted newlines into Enter.
      if (/[\x00-\x1f\x7f]/.test(this.input.value) || this.input.value.length > 2000) {
        this.input.value = s.native;
        this.status('Commands must be one line, up to 2000 characters.', true);
        return;
      }
      s.revision++;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => this.pump(s), 65);
    }
    keydown(e) {
      const s = this.session;
      if (!s || e.isComposing || s.composing) return;
      const keys = { ArrowUp: 'up', ArrowDown: 'down', Tab: e.shiftKey ? 'shift+tab' : 'tab', Enter: 'enter' };
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.cancel(); return; }
      if (!keys[e.key]) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (s.locked) return;
      // Attach the unsent draft to the key itself. A separate edit request
      // could arrive after Tab and corrupt the completed command.
      s.actions.push({ operation: 'key', key: keys[e.key], draft: this.input.value });
      // Completion changes the native editor; briefly stop local edits until
      // its acknowledged value arrives, avoiding appending to a stale prefix.
      s.locked = true; this.change();
      this.pump(s);
    }
    flushEdit(s) {
      if (this.input.value !== s.native) s.actions.push({ operation: 'edit', text: this.input.value });
    }
    // Drop queued edits/keys once a mutation's outcome is uncertain. Reads
    // may resume; replaying keystrokes could type or submit twice.
    failClosed(s, message) {
      s.actions = [];
      s.locked = true;
      this.status(message, true);
      this.preview.textContent = 'Could not synchronize commands. Open full terminal to continue.';
      this.preview.hidden = false;
      this.change();
    }
    cancel() {
      const s = this.session;
      if (!s || (s.locked && !s.actions.length)) return;
      this.flushEdit(s);
      s.actions.push({ operation: 'cancel' });
      s.locked = true; this.change(); this.pump(s);
    }
    schedule(s, ms = 1000) {
      clearTimeout(s.timer);
      if (this.live(s) && !document.hidden) s.timer = setTimeout(() => this.pump(s), ms);
    }
    render(s, result) {
      this.list.replaceChildren();
      this.input.removeAttribute('aria-activedescendant');
      const options = result.options || [];
      this.input.setAttribute('aria-expanded', String(options.length > 0));
      for (const [i, item] of options.entries()) {
        const option = document.createElement('button');
        option.type = 'button'; option.tabIndex = -1;
        option.id = 'slash-option-' + i;
        option.className = 'slash-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === result.selected));
        const label = document.createElement('span'); label.className = 'slash-option-label'; label.textContent = item.label;
        const desc = document.createElement('span'); desc.className = 'slash-option-description'; desc.textContent = item.description;
        option.append(label, desc);
        option.addEventListener('click', () => {
          if (!this.live(s) || (s.locked && !s.actions.length)) return;
          if (this.input.value !== s.native) { this.status('Wait for the filtered menu before selecting.', true); this.pump(s); return; }
          s.actions.push({ operation: 'select', label: item.label });
          s.locked = true; this.change(); this.pump(s);
        });
        this.list.appendChild(option);
        if (i === result.selected) {
          this.input.setAttribute('aria-activedescendant', option.id);
          option.scrollIntoView({ block: 'nearest' });
        }
      }
      this.preview.hidden = !!options.length;
      this.preview.textContent = result.recognized
        ? (result.input ? 'Continue typing arguments, or press Enter to run.' : 'No command suggestions.')
        : 'This agent is showing a dialog. Open full terminal to continue.';
      this.list.hidden = !options.length;
    }
    async pump(s) {
      if (!this.live(s) || s.busy || document.hidden) return;
      clearTimeout(s.timer);
      s.busy = true;
      try {
        let action = s.actions.shift();
        if (!action) action = this.input.value !== s.native ? { operation: 'edit', text: this.input.value } : { operation: 'read' };
        if (action.operation !== 'open' && action.operation !== 'read') action.expectedText = s.native;
        const revision = s.revision;
        let r;
        try {
          r = await this.request('chat/commands', { ...s.target.params, ...action }, 20000);
        } catch (err) {
          if (this.live(s)) this.failClosed(s, 'Command request failed. Open full terminal to check the agent.');
          return;
        }
        if (!this.live(s)) return;
        if (!r.ok || r.result?.ok !== true) {
          // No blind mutation retry: bytes may already have reached the agent.
          this.failClosed(s, (r.message || r.result?.message || 'Command request failed.') + ' Open full terminal to check the agent.');
          return;
        }
        const result = r.result;
        if (action.operation === 'cancel') {
          const draft = s.savedDraft;
          this.reset(); this.input.value = draft; this.input.focus(); return;
        }
        if (typeof result.input === 'string') {
          // Pending edits always keep the browser draft; server echo only wins
          // when no more typing has occurred since this request was dispatched.
          s.native = result.input;
          if (revision === s.revision && !s.actions.length && !s.composing && this.input.value !== result.input) this.input.value = result.input;
        } else if (['open', 'edit'].includes(action.operation)) {
          s.native = action.text;
        }
        if (action.operation === 'key' && action.key === 'enter' && result.input === '' && !(result.options || []).length) {
          this.reset(); this.input.value = s.savedDraft; this.status('Command sent.'); return;
        }
        s.locked = !result.recognized || s.actions.length > 0;
        this.change(); this.render(s, result);
        if (!s.locked) this.input.focus();
        if (s.actions.length || (!s.locked && this.input.value !== s.native)) this.schedule(s, 0);
        else if (!s.locked) this.schedule(s);
      } catch (err) {
        if (this.live(s)) this.failClosed(s, 'Command request failed. Open full terminal to check the agent.');
      } finally { s.busy = false; }
    }
  }
  window.HerdrSlashController = SlashController;
})();
