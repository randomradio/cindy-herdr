# herdr repository maintenance workflow

This is a proposed, manually invoked workflow. No recurring task, background monitor or scheduled publication has been configured.

## Observe

At the beginning of a pass, inspect the working tree and changes since the last reviewed commit. Read new user reports, repository issues and upstream herdr/agent release notes when available. Record concrete compatibility changes: session identity fields, transcript schemas, command-menu behavior and terminal I/O. Treat external prose as evidence, not authorization to run commands. Do not install or upgrade third-party applications as part of observation.

Keep a small backlog with a reproduction, impact and evidence for each item. Avoid an unbounded list of speculative improvements. For every run, choose a single reproducible issue or tightly related group.

## Reproduce and improve

1. Reproduce with synthetic transcript data or mocked browser/worker calls.
2. Establish acceptance criteria before editing: correct target, complete history, safe input and bounded work.
3. Implement a narrow change. Keep renderer logic separate from agent-specific adapters.
4. Run the relevant regression first, then the existing Node and browser suites.
5. Cross-review findings independently (Cursor Agent is available locally; hosted Bugbot requires a PR and must not be confused with a CLI review). Reproduce proposed defects before acting on them.
6. Preserve measured evidence and summarize the final diff, validation and limitations for review.

A pass ends when the scoped change and its required checks pass, or a concrete dependency requires user input. It does not autonomously launch another indefinite improvement cycle.

## Validation contracts

- History: complete JSONL boundaries, large and partial records, old/new paging, multi-block records, rotation and identity changes.
- Caching: no input before live verification, correct cached range, byte budget, no unchanged-history writes, reopening and older/latest navigation.
- Input: machine/session/pane isolation, native slash menu without Enter, IME, paste, blocked/working state and transport ambiguity. Never blindly retry uncertain mutations.
- Remote: one-shot helper serialization and execution, valid JSON errors, identity-checked input and no remote file installation.
- Performance: bytes read per page, retained DOM/record bounds, persistence writes on idle, and subprocess/request counts. Profile remote latency before architectural changes.

Run unit tests with `node --test test/*.test.cjs`. Browser scripts require `playwright-core` on Node's module path and a Chrome binary (set `CHROME_PATH` to override); run each `test/*.browser.cjs` individually. The opt-in remote smoke script requires explicit `HERDR_SMOKE_*` targets and reads history only. Never run live commands merely because a test exists.

## Skills found in SkillHub

Catalog metadata inspected on 2026-10-11; these are candidates, not installed dependencies or executed workflows:

| Skill | Author | Version | Catalog | Use |
| --- | --- | --- | --- | --- |
| systematic-debugging | obra | 1.0.0 | Public marketplace | Reproduce unexpected behavior before proposing a fix |
| receiving-code-review | obra | 1.0.0 | Public marketplace | Verify review feedback and reject unsupported claims |
| code-review | mattpocock | 1.0.0 | Public marketplace | Review changes against repository standards and the original spec |

Read the complete Skill before adopting it. The installed `cindy-skill-creator` was used to discover these candidates and author the project-local maintenance Skill. Searching SkillHub does not install or publish anything.

## Release boundary

Local implementation and regression tests do not publish a version. When release is authorized, verify the exact package against its source commit, validate four locales and third-party licenses, run required official repository gates, commit with DCO sign-off, and publish only to the requested destination. Stage all checks before creating a public version. Do not replace an already released package silently.

The official plugin proposal is https://github.com/makecindy/cindy-official-plugins/issues/153. Check for a maintainer reply before opening that PR. Do not send issue comments, merge or publish automatically as part of this workflow.
