'use strict';
// Runs on a saved herdr SSH machine as a one-shot transcript reader and
// identity-checked prompt sender. The pane and its process identity are
// rechecked here; the caller never chooses a transcript path.
const { execFileSync } = require('node:child_process');
const transcripts = require('./transcript.cjs');

function runHerdrPrompt(session, target, text) {
  try {
    const stdout = execFileSync('herdr', ['--session', session, 'agent', 'prompt', target, text], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    const response = JSON.parse(stdout);
    if (response.error) {
      return { ok: false, code: response.error.code || 'HERDR_FAILED', message: response.error.message || 'herdr agent prompt failed.' };
    }
    if (!response.result) return { ok: false, code: 'HERDR_FAILED', message: 'herdr agent prompt returned no result.' };
    return { ok: true };
  } catch (err) {
    const raw = String(err.stdout || err.stderr || err.message || '');
    try {
      const parsed = JSON.parse(raw);
      return { ok: false, code: parsed.code || 'HERDR_FAILED', message: parsed.message || raw };
    } catch {
      return { ok: false, code: 'HERDR_FAILED', message: raw || 'herdr agent prompt failed.' };
    }
  }
}

async function main() {
  const params = JSON.parse(process.argv[2] || process.argv[1] || '{}');
  const session = params.session;
  const target = params.target;
  const action = params.action === 'prompt' ? 'prompt' : 'history';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(session || '') || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(target || '') || !target.includes(':')) {
    if (action === 'prompt') return { ok: false, code: 'INVALID_ARGS', message: 'Invalid herdr session or pane id.' };
    return { available: false, reason: 'Invalid herdr session or pane id.' };
  }
  const raw = execFileSync('herdr', ['--session', session, 'api', 'snapshot'], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  const pane = JSON.parse(raw).result?.snapshot?.panes?.find((p) => p.pane_id === target && p.agent);
  if (!pane) {
    if (action === 'prompt') return { ok: false, code: 'UNAVAILABLE', message: 'The agent is no longer in this pane.' };
    return { available: false, reason: 'The agent is no longer in this pane.' };
  }
  if (!transcripts.supported.includes(pane.agent)) {
    const reason = `Chat history for ${pane.agent} is not supported yet. Open Terminal to interact with this agent.`;
    if (action === 'prompt') return { ok: false, code: 'UNAVAILABLE', message: reason };
    return { available: false, reason };
  }
  let file = transcripts.resolve(pane.agent_session, pane.agent);
  if (!file && (pane.agent === 'codex' || pane.agent === 'omp')) {
    const infoRaw = execFileSync('herdr', ['--session', session, 'pane', 'process-info', '--pane', target], { encoding: 'utf8', timeout: 10000 });
    const foreground = JSON.parse(infoRaw).result?.process_info?.foreground_processes || [];
    const matches = foreground.filter((proc) => proc.name === pane.agent && proc.cwd === pane.foreground_cwd && Number.isSafeInteger(proc.pid));
    if (matches.length === 1) file = pane.agent === 'codex'
      ? transcripts.resolveCodexProcess(matches[0].pid, matches[0].cwd)
      : transcripts.resolveOmpProcess(matches[0].pid, matches[0].cwd);
  }
  if (!file) {
    if (action === 'prompt') return { ok: false, code: 'UNAVAILABLE', message: 'herdr has not reported an exact transcript for this agent.' };
    return { available: false, reason: 'herdr has not reported an exact transcript for this agent.' };
  }
  if (action === 'prompt') {
    const text = typeof params.text === 'string' ? params.text : '';
    if (!text || text.startsWith('-')) return { ok: false, code: 'INVALID_ARGS', message: 'Invalid prompt text.' };
    if (!params.identity || params.identity !== transcripts.fileIdentity(file)) {
      return { ok: false, code: 'SESSION_MISMATCH', message: 'Live transcript identity does not match the conversation shown.' };
    }
    return runHerdrPrompt(session, target, text);
  }
  return { available: true, agent: pane.agent, ...transcripts.read(file, pane.agent, params) };
}
if (require.main === module || globalThis.__HERDR_REMOTE_HELPER__ === true) {
  main().then((result) => process.stdout.write(JSON.stringify(result))).catch((err) => {
    const message = String(err && err.message || err || 'Remote helper failed.');
    process.stdout.write(JSON.stringify({ ok: false, code: 'HERDR_FAILED', message }));
  });
}
module.exports = { runHerdrPrompt, main };
