'use strict';
// Project the agent's visible terminal menu into browser controls. These are
// observed options, never a static command catalog. Unknown layouts stay raw.
const ANSI = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
const clean = (text) => String(text || '').replace(ANSI, '').replace(/\r/g, '');
const border = (line) => /^[\s╭╮╰╯┌┐└┘├┤│┃─━┬┴┼═+-]*[─━═]{3}/.test(line);
function parseScreen(raw, agent) {
  const source = String(raw || '').split(/\r?\n/).slice(-160);
  const lines = source.map((s) => clean(s).replace(/[│┃]\s*$/, '').replace(/^\s*[│┃] ?/, '').trimEnd());
  // Pi paints its cursor using inverse video. The text before that cell is
  // authoritative and retains a completion's trailing space (screen padding
  // is otherwise indistinguishable from editor whitespace).
  const editorText = (row, fallback) => {
    if (!pi) return fallback;
    const caret = source[row]?.search(/\x1b\[(?:[0-9;]*;)?7m/);
    if (caret === undefined || caret < 0) return fallback;
    const before = clean(source[row].slice(0, caret));
    return before.trimStart().startsWith('/') ? before.trimStart() : fallback;
  };
  const pi = agent === 'pi' || agent === 'omp';
  let input = null, inputRow = -1;
  // Pi's editor is framed by horizontal rules; its completion list is below it.
  if (pi) {
    for (let i = 0; i < lines.length - 2; i++) {
      if (!border(lines[i])) continue;
      let end = i + 1;
      while (end < lines.length && end <= i + 4 && !border(lines[end])) end++;
      if (end >= lines.length || !border(lines[end])) continue;
      const value = lines.slice(i + 1, end).join('\n').trim();
      if (!value || value.startsWith('/')) { input = editorText(i + 1, value); inputRow = i + 1; }
    }
  }
  // Codex / Claude / Cursor prompt rows. Described command rows aren't editors.
  if (inputRow < 0) {
    for (let offset = 0; offset < lines.length; offset++) {
      const row = agent === 'codex' ? lines.length - 1 - offset : offset;
      const match = (agent === 'codex' ? /^› ?(.*)$/ : /^\s*[›❯>] ?(.*)$/).exec(lines[row]);
      if (!match || /\S\s{2,}\S/.test(match[1])) continue;
      const value = match[1].trimEnd();
      if (agent !== 'codex' && value && !value.startsWith('/')) continue;
      const hint = agent === 'codex' && /\x1b\[2m(?:\x1b\[(?:38|48);[0-9;]*m)*([^\x1b]+)/.exec(source[row]);
      input = hint && hint[1].trimEnd() === value ? '' : value;
      inputRow = row;
      break;
    }
  }
  const options = [];
  let selected = -1;
  const marker = /^\s*[→❯›>]\s+/;
  let markedRow = -1;
  // Pi options have bare command names and a selected arrow. They must occur
  // below a recognized editor; without that anchor don't parse transcript text.
  if (pi && inputRow >= 0) {
    markedRow = lines.findIndex((line, i) => i > inputRow && /^\s*→\s+\S/.test(line));
  }
  for (let i = 0; i < lines.length && options.length < 32; i++) {
    if (inputRow < 0 || i === inputRow || i < inputRow) continue;
    const line = lines[i];
    let match;
    if (pi && markedRow >= 0) {
      // Only rows at and below the arrow. Text above it is the editor or transcript, not a command.
      if (i < markedRow || i > markedRow + 8 || border(line)) continue;
      match = /^\s*(?:→\s+)?(\/?[\w:./@+-]+)(?:\s{2,}(.*))?\s*$/.exec(line);
    } else {
      match = /^\s*(?:[→❯›>]\s+)?(\/[\w:.-]+)(?:\s{2,}(.*))?\s*$/.exec(line);
    }
    if (!match) continue;
    const label = match[1];
    if (!label || options.some(o => o.label === label)) continue;
    const highlighted = marker.test(line) || /\x1b\[(?:[0-9;]*;)?7m/.test(source[i]);
    if (highlighted) selected = options.length;
    options.push({ label, description: (match[2] || '').trim().slice(0, 300) });
  }
  return { input, options, selected, recognized: inputRow >= 0, text: lines.slice(-24).join('\n').slice(-8000) };
}
const KEYS = new Set(['up', 'down', 'tab', 'shift+tab', 'enter', 'esc']);
function validate(p) {
  if (!['open', 'edit', 'key', 'select', 'cancel', 'read'].includes(p.operation)) throw new Error('Invalid command menu operation.');
  for (const name of ['text', 'expectedText']) {
    if (p[name] !== undefined && (typeof p[name] !== 'string' || p[name].length > 2000 || /[\x00-\x1f\x7f]/.test(p[name]))) throw new Error('Command input must be a single line of at most 2000 characters.');
  }
  if (p.operation === 'open' && !/^\//.test(p.text || '')) throw new Error('A command must start with /.');
  if (p.operation === 'edit' && (typeof p.text !== 'string' || typeof p.expectedText !== 'string')) throw new Error('Command edit requires the current and new input.');
  if (p.operation === 'key' && !KEYS.has(p.key)) throw new Error('Unsupported command menu key.');
  if (p.operation === 'key' && p.draft !== undefined && (typeof p.draft !== 'string' || /[\x00-\x1f\x7f]/.test(p.draft) || p.draft.length > 2000 || typeof p.expectedText !== 'string')) throw new Error('A command key needs the current and pending input.');
  if (p.operation === 'select' && (typeof p.label !== 'string' || p.label.length > 200 || /\s/.test(p.label))) throw new Error('Invalid command option.');
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const chars = (s) => Array.from(segmenter.segment(s), x => x.segment);
async function applyEdit(p, current, target, run) {
  if (current.input === null || current.input.trimEnd() !== p.expectedText.trimEnd()) throw new Error('The agent input changed. Wait for the menu to refresh or open Terminal.');
  const old = chars(p.expectedText), next = chars(p.text);
  let common = 0;
  while (common < old.length && common < next.length && old[common] === next[common]) common++;
  // Browser owns its caret. The native editor stays at the end of its line.
  for (let left = old.length - common; left > 0; left -= 32) await run(['pane', 'send-keys', target, ...Array(Math.min(left, 32)).fill('backspace')]);
  let suffix = next.slice(common).join('');
  while (suffix.startsWith('-')) { await run(['pane', 'send-keys', target, 'minus']); suffix = suffix.slice(1); }
  if (suffix) await run(['pane', 'send-text', target, suffix]);
}
async function interact(p, agent, run) {
  validate(p);
  const target = p.target;
  const screen = async () => parseScreen(await run(['pane', 'read', target, '--source', 'visible', '--format', 'ansi', '--lines', '120'], true), agent);
  let current = await screen();
  if (p.operation === 'read') return { ok: true, ...current };
  if (p.operation === 'open') {
    if (current.input !== '' && current.input !== p.text) throw new Error('The native editor is not empty or cannot be identified. Open Terminal to review it.');
    if (!current.input) await run(['pane', 'send-text', target, p.text]);
  } else if (p.operation === 'edit') {
    await applyEdit(p, current, target, run);
  } else if (p.operation === 'select') {
    const index = current.options.findIndex(o => o.label === p.label);
    if (index < 0 || current.selected < 0) throw new Error('The menu selection changed. Use the arrow keys to select an option.');
    const delta = index - current.selected;
    if (delta) await run(['pane', 'send-keys', target, ...Array(Math.abs(delta)).fill(delta > 0 ? 'down' : 'up')]);
    // Re-read before Tab. A repaint between the first read and the arrows
    // must not complete a different option.
    current = await screen();
    if (current.options[current.selected]?.label !== p.label) throw new Error('The menu selection changed. Use the arrow keys to select an option.');
    await run(['pane', 'send-keys', target, 'tab']);
  } else if (p.operation === 'key' && typeof p.draft === 'string' && p.draft !== current.input) {
    // Typing and Tab/Enter share one request so the key cannot land on a
    // prefix the browser has already replaced.
    await applyEdit({ text: p.draft, expectedText: p.expectedText }, current, target, run);
    await run(['pane', 'send-keys', target, p.key]);
  } else if (p.operation === 'cancel') {
    if (typeof p.expectedText !== 'string' || current.input === null || current.input.trimEnd() !== p.expectedText.trimEnd()) throw new Error('The agent input changed. Open Terminal to dismiss the dialog.');
    await run(['pane', 'send-keys', target, 'esc']);
    // Remove only the acknowledged command owned by this interaction. Never
    // use Ctrl+U/Ctrl+C or clear a different user's native editor draft.
    // Stop on the first failed batch so a later error cannot claim success
    // while part of the command is still in the native editor.
    let left = chars(p.expectedText).length;
    try {
      while (left > 0) {
        await run(['pane', 'send-keys', target, ...Array(Math.min(left, 32)).fill('backspace')]);
        left -= 32;
      }
    } catch (err) {
      throw new Error('Could not finish dismissing the command. Open Terminal to check the agent editor.');
    }
  } else if (p.operation === 'key') {
    await run(['pane', 'send-keys', target, p.key]);
  } else {
    throw new Error('Invalid command menu operation.');
  }
  // The write can precede the TUI repaint. A bounded settle window avoids an
  // extra SSH request on every Tab; never replays a mutation to refresh output.
  const baseline = current.text;
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 35));
    current = await screen();
    if (current.text !== baseline) break;
  }
  return { ok: true, ...current };
}
module.exports = { parseScreen, validate, interact };
