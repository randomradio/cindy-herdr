# herdr for Cindy

A [Cindy](https://github.com/makecindy/cindy) plugin that lets Cindy see and drive
[herdr](https://herdr.dev) — the terminal / session / coding-agent multiplexer —
on this computer and on SSH machines saved in herdr.

## What it does

- **herdr page in Cindy's sidebar.** Pick a machine and session and see every
  coding agent with live status (working / needs an answer / done / idle);
  plain shells and workspaces without an agent are hidden. Click an agent to
  open a Cindy-style chat from the agent's saved transcript when herdr reports
  its exact session identity. Claude Code, Codex, Pi, OpenAI Block (OMP) and
  Cursor Agent transcripts are supported locally and on saved SSH machines
  with Node installed. When Codex or OMP lacks a reported session id, the
  worker matches only a unique session by its live process, launch time and
  working directory. Cursor uses its reported session id. Missing history
  stays in Chat with an explanation, Retry and Open Terminal actions; failed
  lookups never switch views. Chat reads bounded transcript pages and appends
  only new messages. The page saves the last machine, session, agent list and
  recent chat locally, so reopening shows that view immediately, then checks
  the live transcript. Saved chat is read-only until that identity is verified.
  Use Chat / Terminal to type, paste or answer approval prompts in the
  ANSI-colored xterm mirror.
- **New agent.** Choose an agent type, a folder and an optional name, and
  optionally work on a new git branch (a worktree under
  `~/.worktrees/<repo>/<branch>`, with an optional base). The page creates the
  workspace and starts the agent, showing progress while it starts.
- **Workspace menu.** Rename a workspace, show it in herdr, close it, or remove
  its git worktree (the branch is kept). Close and remove ask first.
- **Agent tools.** Cindy can list machines and sessions, snapshot a session, read
  output, prompt an agent and wait for it, send text and keys, run commands,
  split panes, start agents, manage workspaces (`herdr_workspace`: create, new
  tab, new or existing worktree, rename, list worktrees, optionally starting an
  agent), switch focus, and close panes/tabs/workspaces or remove worktrees.
  Closing always asks for confirmation in a Cindy dialog.
- **Remote machines.** Any machine saved with `herdr machine add` is reachable;
  commands run over `ssh -o BatchMode=yes` (passwordless SSH required) and reuse
  one connection per machine.

## Requirements

- herdr 0.9+ installed on each machine (`/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin` or `~/.cargo/bin`, or on `PATH`).
- For remote machines: passwordless SSH from this computer to the saved herdr
  machine target.
- Cindy 0.1.97 or later.

## How it works

```
ghost.json       manifest: tools, sidebar page (mainView), Node worker, confirm
main.js          sandboxed brain: routes tool calls and page requests to the worker
node/worker.cjs  Node worker: runs a fixed allowlist of herdr subcommands
view.html/.css/.js  the sidebar page
chat-view.js/chat-style.css  transcript presentation
vendor/xterm/   xterm.js 6.0.0 (MIT), including its license
```

Safety boundaries:

- The worker never spawns a local shell; herdr is run with `execFile` and an
  argument array. Remote commands are single-quoted for the remote shell.
  Chat prompts require the live transcript identity to match the conversation
  shown on the page before the agent receives them.
- Only a fixed set of herdr subcommands is exposed. Machine, session, pane,
  agent and key names are validated before use; paths must be absolute or
  start with `~/`, and missing local folders are rejected (herdr would
  otherwise silently fall back to the home folder).
- Only `local` and machines already saved in herdr can be targeted.
- Close and worktree-remove actions require a confirmation (a Cindy dialog for
  Agent calls, an in-page dialog on the herdr page) and fail closed. The page
  never force-removes a worktree with uncommitted changes.
- Inherited `HERDR_*` environment is not used to pick a target; sessions are
  always named explicitly.
- Chat resolves transcripts through herdr's session identity, or a unique
  Codex/OMP process/start-time/cwd match when its integration did not report an id.
  It never reads an arbitrary path from the page. For saved SSH machines,
  a bundled read-only helper runs over the existing SSH connection without
  installing files remotely. Agents without a unique match can use Terminal.
  Chat reads transcript pages on complete JSONL boundaries (up to 512 KiB per
  record; longer records show a marker) and keeps at most 240 message nodes in
  the page. The cache is byte-bounded and keeps the recent tail independently
  of older-history browsing.
- Terminal mirrors the pane's **visible** herdr screen and sends xterm's
  keystrokes with `pane send-text`. herdr does not currently expose an output
  stream, so Cindy polls snapshots; cursor position and graphical terminal
  features are not mirrored.

## Install from source

In Cindy, ask: *"install the plugin from `<path to this folder>`"* (Cindy Forge
packs and installs it), or zip the folder contents into a `.cindy` archive and
import it from Cindy's Plugins page.

## License

Apache-2.0
