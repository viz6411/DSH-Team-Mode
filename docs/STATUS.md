# STATUS: what is implemented and how it was verified

Against the acceptance criteria in [requirements.md](../requirements.md) (§8). Verified means there is
reproducible evidence below; unit means the reducer/storage gate is covered by `npm test`; open means
it is not proven yet.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | First Team chat binds a Manager; a new chat re-binds and keeps the profiles | unit + live (probe) | `bindManager` + `managerHistory` in [lib/board.js](../lib/board.js); live: `probeDelegate` bound session `session-4512…` as Manager of workspace `020a8f23…` and the existing designer profile was kept |
| A2 | Delegation creates a profile once; repeats reuse the same session | **live** | `probeRole` created child `tm-09de62a1-09ae-4003-8fd2-a0076cd73088` with `agentPreset: team-designer`, `mode: continuable`, `provider: spawn`; second delegation reused it (`queued`/reuse path) |
| A3 | Profiles survive a Host restart, cold resume keeps persona and tools | open | Design is persistence-based (`$DSH_HOME/team-mode/workspaces/*.json` + durable child sessions); needs a restart test |
| A4 | Editing `roles/<role>.md` changes the next created profile; existing profile is flagged | unit | `RoleCatalog` hash + `personaDrift` in `touchProfile` |
| A5 | Role editor creates a role without a restart | live (Host half) | `saveRole` → `$DSH_HOME/team-mode/roles/tester.md`, list reported `source: user`, `deleteRole` restored the packaged default, `Bad_Role` rejected |
| A6 | spec→build→verify→review runs autonomously with brief and acceptance per hand-off | live (partial) | two tasks created by `probeDelegate` were claimed by the role (`revision` 1→2) and advanced `spec → build` (`completedStages: ["spec"]`, verdict `pass`); the chain stops at `build` today only because of the profile's `maxActiveSubagents: 1`, see below |
| A7 | A role cannot claim a task of another stage | unit | claim gate test in [test/core.test.mjs](../test/core.test.mjs) |
| A8 | Reviewer reject returns the task to `reworkStage` with the note, iteration visible | unit | rework reducer test |
| A9 | A stage is never Done without a human approval | unit + code review | `await_approval` gate; no agent tool can accept — only `panel.approve` |
| A10 | After a crash, tasks with an interrupted role are reopened and the Manager is told | implemented this round | `reconcileInterrupted` writes one report + `task/reopened` event per revision, run when a Manager binds |
| A11-A14 | Direct user dialogue with a role session, steer during a step, queue delivery, panel interrupt | live (partly) | **verified in a real chat**: the user wrote directly to the role session and the role answered there; the role escalated to the Manager chat with `team_report` (kind=note, kind=blocked) and those messages arrived in the Manager session. Panel interrupt needs a UI click-through |
| A15 | The fourth delegation queues and the Manager is told | unit | concurrency test; `delegate` returns `queued` + `queueReason` |
| A16 | A worker cannot call delegation or plugin-management tools | live | Tool list recorded in the created role session (`request/header`): `team_tasks`, `team_task_claim`, `team_task_complete`, `team_report` present; `subagent`, `spawn_teammate`, `plugin_manager`, `ask_user_question` absent |
| A17 | One install puts the mode into a clean profile | live | `install_bundle` → `application: applied`, `warnings: []`; `diagnose` reports all six `team-*` presets selectable (`broken: null`) and the Team panel slots |
| A18 | Optional rows are disable-able without breaking the core | unit + live | `kanbanSync: false` default, projection skipped when the Kanban plugin is absent for the agent |
| A19 | Tests green | live | `npm test` 14/14, `npm run check:manifest` (manifest + tool/panel wiring + YAML dialect guards) |

## How the live evidence was produced

The Host core exposes a `diagnose` / `probeRole` / `probeDelegate` panel surface under
`POST /api/team-mode`, used by the installer path in [../skills/team-mode-install/SKILL.md](../skills/team-mode-install/SKILL.md):

- `diagnose` → the picker roster with `broken` markers, the mount state of every preset row
  (`fiber: ACTIVE/FAILED`), live agents and workspace files. A preset with `broken` is *not* offered
  in the mode picker, which is why checking the roster is the first installation step.
- `probeRole` → creates or reuses one role profile under a live session, the same call path a
  delegation uses.
- `probeDelegate` → runs a real `tools.delegate` with a live session bound as the Manager.

## Environment requirement found in this profile

Role profiles are continuable subagent children of the Manager session, so the profile's
`@deepseek-ai/dsh-subagent` `maxActiveSubagents` caps the team size. This profile has `1`, so after the
designer profile existed, the second delegation failed with `subagent limit reached (active child
limit: 1)` and the chain could not create the developer profile. The Host now reports that with a hint
naming the setting; raising the value is a profile change and belongs to the human (see
[../INSTALL.md](../INSTALL.md)).

## Fixed in this round (live-verified)

- `ToolOutputError: value is not lossless JSON` on `team_task_complete` / `team_report`: the board
  mutation had already happened, but the Harness rejected a result containing `undefined`-valued keys,
  so the role saw a useless error and reported itself blocked. All nine team tools now return through
  `lib/json.js` (`toolResult`), and the role confirmed live that the error is gone.
- Hand-offs now keep the Manager session as the single parent of every role profile, which is what the
  platform's direct-parent messaging rule requires.

## Open items

- A3 restart test, A11-A14 UI click-through, A6 full chain through `verify` and `review` with a human
  approval, and Kanban status-column projection (only card creation and transition comments are
  projected today).
- `CHANGE_ME` in the repository URL until the GitHub address is known.
