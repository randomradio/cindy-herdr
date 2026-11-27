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
        if (!this.session && input.value.startsWith('/')) this.open(input.value);
        else if (this.session) this.edit();
      });
      input.addEventListener('compositionstart', () => {
        const s = this.session;
        if (!s) return;
        s.composing = true;
        s.revision++;
        clearTimeout(s.timer);
      });
      input.addEventListener('compositionend', () => {
        if (this.session) {
          this.session.composing = false;
          if (this.session.completion) {
            const { before, after } = this.session.completion;
            this.complete(this.session, before, after);
            this.session.completion = null;
          }
          this.edit();
        } else if (input.value.startsWith('/')) this.open(input.value);
      });
      input.addEventListener('keydown', e => this.keydown(e));
      document.addEventListener('keydown', event => {
        if (!this.active || event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      });
      dismiss.addEventListener('click', () => this.cancel());
      fullTerminal.addEventListener('click', () => { this.reset(true); terminal(); });
      // Keep typing in the textarea even when an option is clicked.
      list.addEventListener('mousedown', e => e.preventDefault());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(this.session?.timer);
        else if (this.session) this.schedule(this.session, 0);
      });
    }
    get active() { return !!this.session; }
    get locked() { return !!this.session?.locked; }
    get inputLocked() { return this.locked && !this.session.failed; }
    reset(restoreDraft = false) {
      if (restoreDraft && this.session?.savedDraft) this.input.value = this.session.savedDraft;
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
      const initialDraft = this.input.value === '/' ? '' : this.input.value;
      const savedDraft = this.input.value.startsWith('/') ? '' : this.input.value;
      const s = { target, savedDraft, initialDraft, native: '', actions: [{ operation: 'open', text: prefix.trimEnd(), revision: 0 }], busy: false, opening: true, locked: false, revision: 0, timer: null };
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
      if (!s || (s.locked && !s.failed) || s.composing) return;
      // Browser text editing (selection replacement, paste, IME) stays local
      // until the next coalesced update. Never turn pasted newlines into Enter.
      if (/[\x00-\x1f\x7f]/.test(this.input.value) || this.input.value.length > 2000) {
        this.input.value = s.native;
        this.status('Commands must be one line, up to 2000 characters.', true);
        return;
      }
      s.revision++;
      clearTimeout(s.timer);
      if (s.failed) return;
      s.timer = setTimeout(() => this.pump(s), 65);
    }
    keydown(e) {
      const s = this.session;
      if (!s || e.isComposing || s.composing) return;
      const keys = { ArrowUp: 'up', ArrowDown: 'down', Tab: e.shiftKey ? 'shift+tab' : 'tab', Enter: 'enter' };
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.cancel(); return; }
      if (s.failed && ['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      if (!keys[e.key]) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (s.locked) return;
      if (keys[e.key] !== 'enter' && s.empty && !this.needsEdit(s)) return;
      // Attach the unsent draft to the key itself. A separate edit request
      // could arrive after Tab and corrupt the completed command.
      s.actions.push({ operation: 'key', key: keys[e.key], draft: this.input.value, revision: s.revision });
      s.locked = keys[e.key] === 'enter'; this.change();
      this.pump(s);
    }
    complete(s, before, after) {
      const segments = text => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment);
      const rebase = draft => {
        if (draft.startsWith(before)) return after + draft.slice(before.length);
        if (before.startsWith(draft)) return segments(after).slice(0, -segments(before.slice(draft.length)).length).join('');
        return draft;
      };
      const draft = rebase(this.input.value);
      if (this.input.value !== draft) this.input.value = draft;
      for (const action of s.actions) {
        if (typeof action.draft === 'string') action.draft = rebase(action.draft);
        if (action.operation === 'edit') action.text = rebase(action.text);
      }
    }
    flushEdit(s) {
      if (this.needsEdit(s)) s.actions.push({ operation: 'edit', text: this.input.value.trimEnd(), revision: s.revision });
    }
    needsEdit(s) { return this.input.value.trimEnd() !== s.native.trimEnd(); }
    // Drop queued edits/keys once a mutation's outcome is uncertain. Reads
    // may resume; replaying keystrokes could type or submit twice.
    failClosed(s, message) {
      s.actions = [];
      clearTimeout(s.timer);
      s.failed = true;
      s.locked = true;
      this.status(message, true);
      this.list.replaceChildren();
      this.input.removeAttribute('aria-activedescendant');
      this.input.setAttribute('aria-expanded', 'false');
      this.preview.textContent = 'Keep editing your draft here. Command delivery is paused; open Terminal to check the agent.';
      this.preview.hidden = false;
      this.change();
    }
    cancel() {
      const s = this.session;
      if (!s) return;
      if (s.locked || s.opening) {
        const draft = s.failed || s.revision > 0 ? this.input.value : s.initialDraft;
        this.reset();
        this.input.value = draft;
        this.status('Command menu closed. Drafts were kept.');
        this.input.focus();
        return;
      }
      this.flushEdit(s);
      s.actions.push({ operation: 'cancel' });
      s.locked = true; this.change(); this.pump(s);
    }
    schedule(s, ms = 1000) {
      clearTimeout(s.timer);
      if (this.live(s) && !s.failed && !s.composing && !document.hidden) s.timer = setTimeout(() => this.pump(s), ms);
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
          if (!this.live(s) || s.locked) return;
          if (this.needsEdit(s)) { this.status('Updating command suggestions…'); this.pump(s); return; }
          s.actions.push({ operation: 'select', label: item.label, revision: s.revision });
          this.pump(s);
        });
        this.list.appendChild(option);
        if (i === result.selected) {
          this.input.setAttribute('aria-activedescendant', option.id);
          option.scrollIntoView({ block: 'nearest' });
        }
      }
      this.preview.hidden = !!options.length;
      s.empty = result.recognized && !options.length;
      this.preview.textContent = result.recognized
        ? (result.input && /\s/.test(result.input) ? 'Continue typing arguments, or press Enter to confirm.' : 'No matching command suggestions. Edit the command or open Terminal.')
        : 'This agent is showing a dialog. Open full terminal to continue.';
      this.list.hidden = !options.length;
    }
    async pump(s) {
      if (!this.live(s) || s.busy || s.failed || s.composing || document.hidden) return;
      clearTimeout(s.timer);
      s.busy = true;
      try {
        let action = s.submitting || s.pendingEdit || s.pendingCompletion ? { operation: 'read', revision: s.pendingEdit?.revision ?? s.pendingCompletion?.revision ?? s.revision } : s.actions.shift();
        if (!action) action = this.needsEdit(s) ? { operation: 'edit', text: this.input.value.trimEnd() } : { operation: 'read' };
        if (action.operation !== 'open' && action.operation !== 'read') action.expectedText = s.native;
        if (action.operation === 'key' && action.key === 'enter') s.submitting = true;
        const before = action.draft ?? s.native;
        const { revision = s.revision, ...operation } = action;
        if (operation.operation === 'key' && operation.key !== 'enter') operation.draft = operation.draft.trimEnd();
        let r;
        try {
          r = await this.request('chat/commands', { ...s.target.params, ...operation }, 20000);
        } catch (err) {
          if (this.live(s)) this.failClosed(s, 'Command request failed. Open full terminal to check the agent.');
          return;
        }
        if (!this.live(s)) return;
        if (!r.ok || r.result?.ok !== true) {
          // No blind mutation retry: bytes may already have reached the agent.
          this.failClosed(s, r.message || r.result?.message || 'Command request failed. Open Terminal to check the agent.');
          return;
        }
        const result = r.result;
        const expectedInput = s.pendingEdit?.text ?? (['open', 'edit'].includes(action.operation) && !result.resumed ? action.text : action.operation === 'read' && !result.recognized && !s.submitting && !s.pendingCompletion ? s.native : null);
        if (expectedInput !== null && result.input?.trimEnd() !== expectedInput.trimEnd()) {
          s.pendingEdit ??= { text: expectedInput, revision, started: Date.now() };
          if (Date.now() - s.pendingEdit.started >= 2000) {
            this.failClosed(s, 'The native editor has not confirmed this edit. Open Terminal to check the draft.');
            return;
          }
          this.list.replaceChildren();
          this.input.removeAttribute('aria-activedescendant');
          this.input.setAttribute('aria-expanded', 'false');
          this.preview.textContent = 'Updating command suggestions…';
          this.preview.hidden = false;
          this.schedule(s, 100);
          return;
        }
        const edited = action.operation === 'edit' || !!s.pendingEdit;
        s.pendingEdit = null;
        if (result.selectionChanged) this.status('Command suggestions changed. Choose an available option.');
        if (action.operation === 'open' || s.opening) s.opening = false;
        if (action.operation === 'open' && result.resumed) {
          s.resumed = true;
          if (s.revision > 0 && this.input.value !== result.input) {
            this.failClosed(s, 'The terminal already has a command. Your new draft was kept. Open Terminal to continue.');
            return;
          }
          this.status('Resumed the command already in the agent terminal.');
          if (!s.composing) this.input.value = result.input;
        }
        if (s.submitting) {
          if (result.input === '' && !(result.options || []).length) {
            this.reset(); this.input.value = s.savedDraft; this.status('Command sent.'); return;
          }
          if (!result.recognized || action.operation === 'read') {
            this.reset(true); this.status('Continue the command in Terminal.'); this.terminal(); return;
          }
          s.locked = true;
          this.change(); this.render(s, result); this.schedule(s, 100);
          return;
        }
        if (!result.recognized && ['key', 'select'].includes(action.operation)) {
          this.reset(true); this.status('Continue the command in Terminal.'); this.terminal(); return;
        }
        if (action.operation === 'cancel') {
          const draft = s.savedDraft || (typeof result.input === 'string' ? result.input : this.input.value);
          this.reset(); this.input.value = draft; this.input.focus(); return;
        }
        if (edited && result.input === '' && this.input.value === '' && !s.actions.length && revision === s.revision) {
          this.reset(); this.status(''); return;
        }
        const completes = action.operation === 'select' || (action.operation === 'key' && ['tab', 'shift+tab'].includes(action.key));
        if (completes && !result.selectionChanged && result.input?.trimEnd() === before.trimEnd() && result.input.length <= before.length) {
          s.pendingCompletion = { before, revision, started: Date.now() };
        }
        const completion = s.pendingCompletion;
        if (completion && (typeof result.input !== 'string' || (result.input.trimEnd() === completion.before.trimEnd() && result.input.length <= completion.before.length))) {
          if (Date.now() - completion.started < 2000) {
            this.schedule(s, 100);
            return;
          }
          if (!result.recognized) {
            this.failClosed(s, 'The command completion could not be read. Your draft is kept here.');
            return;
          }
        }
        s.pendingCompletion = null;
        if (typeof result.input === 'string') {
          const completionBefore = completion?.before ?? before;
          if ((['key', 'select'].includes(action.operation) || completion) && (result.input.trimEnd() !== completionBefore.trimEnd() || ((completes || completion) && result.input.length > completionBefore.length))) {
            if (s.composing) s.completion = { before: completionBefore, after: result.input };
            else this.complete(s, completionBefore, result.input);
          }
          if (action.operation === 'read' && !edited && !completion && result.input.trimEnd() !== s.native.trimEnd() && this.input.value.trimEnd() !== result.input.trimEnd()) {
            this.failClosed(s, 'The agent draft changed in Terminal. Your draft is kept here.');
            return;
          }
          s.native = result.input;
        } else if (['open', 'edit'].includes(action.operation)) {
          s.native = action.text;
        }
        s.locked = !result.recognized || s.actions.some(pending => pending.operation === 'cancel' || pending.key === 'enter');
        this.change(); this.render(s, result);
        if (!s.locked) this.input.focus();
        if (s.actions.length || (!s.locked && this.needsEdit(s))) this.schedule(s, 0);
        else if (!s.locked) this.schedule(s);
      } catch (err) {
        if (this.live(s)) this.failClosed(s, 'Command request failed. Open full terminal to check the agent.');
      } finally { s.busy = false; }
    }
  }
  window.HerdrSlashController = SlashController;
})();
