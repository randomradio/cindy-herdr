// Cindy-style transcript view for herdr agents. No raw transcript HTML enters the DOM.
// Loaded before view.js; page code calls window.HerdrChat.render(event).
(function () {
  'use strict';
  function text(tag, value, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = value || '';
    return el;
  }
  function inline(container, value) {
    const parts = String(value).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g);
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`')) container.appendChild(text('code', part.slice(1, -1)));
      else if (part.startsWith('**') && part.endsWith('**')) container.appendChild(text('strong', part.slice(2, -2)));
      else if (/^\[[^\]]+\]\(https?:\/\/[^)\s]+\)$/.test(part)) {
        const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
        const link = text('a', m[1]);
        link.href = m[2];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        container.appendChild(link);
      } else container.appendChild(document.createTextNode(part));
    }
  }
  function markdown(container, raw) {
    const lines = String(raw || '').split('\n');
    let code = null;
    let paragraph = [];
    function flush() {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      paragraph.forEach((line, i) => { if (i) p.appendChild(document.createElement('br')); inline(p, line); });
      container.appendChild(p);
      paragraph = [];
    }
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        flush();
        if (code) { container.appendChild(code); code = null; }
        else { code = document.createElement('pre'); code.appendChild(document.createElement('code')); }
      } else if (code) code.firstChild.textContent += line + '\n';
      else if (!line.trim()) flush();
      else if (/^#{1,4}\s/.test(line)) {
        flush(); const m = /^(#{1,4})\s+/.exec(line);
        const h = document.createElement('h' + Math.min(m[1].length + 1, 5));
        inline(h, line.slice(m[0].length)); container.appendChild(h);
      } else if (/^\s*[-*]\s+/.test(line)) {
        flush(); const p = document.createElement('p');
        p.appendChild(document.createTextNode('• ')); inline(p, line.replace(/^\s*[-*]\s+/, ''));
        container.appendChild(p);
      } else paragraph.push(line);
    }
    flush(); if (code) container.appendChild(code);
  }
  function render(event) {
    if (!event || !event.type || !event.text || !event.text.trim()) return null;
    if (event.type === 'oversized') {
      const wrap = document.createElement('article');
      wrap.className = 'chat-message assistant';
      const content = document.createElement('div');
      content.className = 'chat-message-body';
      content.appendChild(text('p', event.text, 'chat-oversized'));
      wrap.appendChild(content);
      return wrap;
    }
    if (event.type === 'text') {
      const wrap = document.createElement('article');
      wrap.className = 'chat-message ' + (event.role === 'user' ? 'user' : 'assistant');
      const content = document.createElement('div');
      content.className = 'chat-message-body';
      markdown(content, event.text);
      wrap.appendChild(content);
      return wrap;
    }
    const details = document.createElement('details');
    details.className = event.type === 'thinking' ? 'chat-thinking' : 'chat-tool';
    const summary = text('summary', event.type === 'thinking' ? '✦ Thinking' : event.type === 'result' ? 'Tool result' : event.name || 'Tool call');
    details.appendChild(summary);
    const body = text('pre', event.text);
    details.appendChild(body);
    return details;
  }
  window.HerdrChat = { render };
})();
