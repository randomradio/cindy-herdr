# herdr for Cindy

A [Cindy](https://github.com/makecindy/cindy) plugin that lets Cindy see and drive
[herdr](https://herdr.dev) — the terminal / session / coding-agent multiplexer —
on this computer and on SSH machines saved in herdr.

## What it does

- **herdr page in Cindy's sidebar.** Pick a machine and session, see every
  workspace, pane and agent with live status (working / blocked / done / idle),
  click one to follow its terminal output, type a message to prompt the agent
  (or run a command in a plain shell), and answer approval prompts with quick
  keys (Enter, Esc, Ctrl+C, arrows, Tab).
- **Agent tools.** Cindy can list machines and sessions, snapshot a session, read
  output, prompt an agent and wait for it, send keys, run commands, split panes,
  start agents, create workspaces/tabs, switch focus, and close panes/tabs/
  workspaces. Closing always asks for confirmation in a Cindy dialog.
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
```

Safety boundaries:

- The worker never spawns a local shell; herdr is run with `execFile` and an
  argument array. Remote commands are single-quoted for the remote shell.
- Only a fixed set of herdr subcommands is exposed. Machine, session, pane,
  agent and key names are validated before use; paths must be absolute.
- Only `local` and machines already saved in herdr can be targeted.
- Inherited `HERDR_*` environment is not used to pick a target; sessions are
  always named explicitly.
- Close actions require a Cindy confirmation dialog and fail closed.

## Install from source

In Cindy, ask: *"install the plugin from `<path to this folder>`"* (Cindy Forge
packs and installs it), or zip the folder contents into a `.cindy` archive and
import it from Cindy's Plugins page.

## License

Apache-2.0
