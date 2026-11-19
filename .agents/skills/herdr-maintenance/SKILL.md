---
name: herdr-maintenance
description: Review and iterate this herdr Cindy plugin from repository changes, upstream agent compatibility changes or user-reported bugs. Use for a maintenance pass on this repo, including transcript and native terminal regressions. No scheduled execution is configured by this Skill.
---

# Maintenance pass

Start from the user's requested scope and the current working tree. Preserve uncommitted work. Read [the workflow](../../../docs/maintenance-workflow.md) in the repository for the evidence and release checklist.

Track one concrete issue through reproduction, implementation and verification. A review finding alone is not proof: try to falsify it and distinguish observed defects from performance hypotheses. Prefer synthetic transcript fixtures and mocked browser tests before live herdr interactions.

For performance work, measure bytes read, message completeness, cache writes and request counts, not only wall-clock anecdotes. Test cold open, saved view, unchanged polling, older history and session replacement. Treat machine, herdr session, pane and agent transcript identity as separate parts of the target.

Native slash commands belong to the selected agent. Avoid a static cross-agent command catalog or pretending terminal menus are transcript messages. Preserve the native command UI, do not press Enter to choose a command unless the user chooses it, and do not erase terminal drafts automatically.

For a live smoke test, use only explicitly approved disposable workspaces in the local `agents` session. Record the exact created IDs and clean up only those resources. Never control the user's focused pane or auto-answer trust/approval prompts. Existing sessions may be inspected read-only within the task's authorized scope.

Finish a pass with a concrete diff, test results and remaining uncertainties. Do not loop endlessly: one scoped fix and one independent review pass, then address validated findings and report. If external access fails or a required identity cannot be established, stop that dependent path with a clear next step.

No scheduler is configured. The user selected workflow/Skill design first. Create recurring tasks only when subsequently requested with a cadence. Commit, publish, install or send external comments only within the user's current authorization. The official plugin PR remains on hold until a maintainer replies on makecindy/cindy-official-plugins#153; a reply permits revisiting the PR decision, not automatic merge or publication.
