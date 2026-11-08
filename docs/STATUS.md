# STATUS: what is implemented and how it was verified

Against the acceptance criteria in [requirements.md](../requirements.md) (§8). Verified means there is
reproducible evidence below; unit means the reducer/storage gate is covered by `npm test`; open means
it is not proven yet.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | First Team chat binds a Manager; a new chat re-binds and keeps the profiles | unit + live (probe) | `bindManager` + `managerHistory` in [lib/board.js](../lib/board.js); live: `probeDelegate` bound session `session-4512…` as Manager of workspace `020a8f23…` and the existing designer profile was kept |
| A2 | Delegation creates a profile once; repeats reuse the same session | **live** | `probeRole` created child `tm-09de62a1-09ae-4003-8fd2-a0076cd73088` with `agentPreset: team-designer`, `mode: continuable`, `provider: spawn`; second delegation reused it (`queued`/reuse path) |
| A3 | Profiles survive a Host restart, cold resume keeps persona and tools | live | two Host restarts (2026-11-07 16:45Z and 23:10Z) were followed by delegations that **reused** the same role sessions — designer `tm-09de62a1…` and developer `tm-e17cd53f…` ran stages after the restarts and reported their own tools working; the sessions are on disk under `.dsh/sessions/--home-viz-work--/<id>/session.v4.jsonl.zstd` with `agentPreset: team-<role>`, `parentSession` = the Manager session and `delegationDepth: 1` (histories 264/134/132/112 events), and the workspace board JSON keeps the profiles |
| A4 | Editing `roles/<role>.md` changes the next created profile; existing profile is flagged | unit + **live** | measured with a workspace override at `$DSH_HOME/team-mode/roles/designer.md`: `probeRole` reused profile `tm-09de62a1…` (11 ms, no new session) and reported `personaDrift: true` for designer while developer/tester/reviewer stayed `false`; deleting the override returned the flag to `false`, so it is a live comparison against the stored persona hash, not a one-time marker |
| A5 | Role editor creates a role without a restart | live (Host half) | `saveRole` → `$DSH_HOME/team-mode/roles/tester.md`, list reported `source: user`, `deleteRole` restored the packaged default, `Bad_Role` rejected |
| A6 | spec→build→verify→review runs autonomously with brief and acceptance per hand-off | **live (full chain)** | task `t-a67842a6…` ran all four stages in four role sessions: designer `tm-09de62a1…` wrote `team-mode-probe/queue.md`, developer `tm-e17cd53f…` closed `build`, tester `tm-f9b879b4…` proved `verify` (sha256 + file window), reviewer `tm-982f60c1…` verified `review` and refused to accept it itself; the board then set `awaiting_approval`, delivered that to the Manager chat, and `panel.approve` closed the task (`status: accepted`, revision 10) |
| A7 | A role cannot claim a task of another stage | unit | claim gate test in [test/core.test.mjs](../test/core.test.mjs) |
| A8 | Reviewer reject returns the task to `reworkStage` with the note, iteration visible | unit | rework reducer test |
| A9 | A stage is never Done without a human approval | unit + live | the `await_approval` gate has no agent-facing tool — only `panel.approve` closed task `t-a67842a6…` (`status: accepted`, revision 10); the reviewer role explicitly refused to move it to accepted and said so in its report ||
| A10 | After a crash, tasks with an interrupted role are reopened and the Manager is told | live | `panel.reconcile {workspaceId}` answered `ok: true` with `reopened: [5 task ids]` while every role profile reported `activity: inactive`, wrote one `blocked` report per task, and logged `reconcile …: 5 task(s) reopened` in `panel-signals.log`; the same reconciliation runs automatically when a Manager session binds |
| A11-A14 | Direct user dialogue with a role session, steering during a step, queued delivery, panel interrupt | live (panel, snapshot, interrupt call), open (click-through) | Slot tree of the running page contains `sidebar.panellist` occupant `id: team-mode` (order 16) and `main` occupant `key: team-mode`, both active; `panel.snapshot` for workspace `020a8f23…` returns the bound `managerSessionId`, four role profiles with `presetId`/activity, the role catalog and the tasks with their stages, so the panel has real content instead of "No Manager session yet"; `panel.interrupt {role: designer}` answered `{ok: true}`. Opening a role session, steering it mid-step, and pressing the interrupt button in the browser still need a human click-through |
| A15 | The fourth delegation queues and the Manager is told | unit + live | concurrency gate returns `queued` + `queueReason` (unit test); live: one workspace holds four durable role sessions — designer `tm-09de62a1…`, developer `tm-e17cd53f…`, tester `tm-f9b879b4…`, reviewer `tm-982f60c1…` — each a continuable subagent child of the Manager session, reused across tasks and hand-offs; a refused new profile is deferred and retried by the Host |
| A16 | A worker cannot call delegation or plugin-management tools | live | Tool list recorded in the created role session (`request/header`): `team_tasks`, `team_task_claim`, `team_task_complete`, `team_report` present; `subagent`, `spawn_teammate`, `plugin_manager`, `ask_user_question` absent |
| A17 | One install puts the mode into a clean profile | live | `install_bundle` → `application: applied`, `warnings: []`; `diagnose` reports all six `team-*` presets selectable (`broken: null`) and the Team panel slots |
| A18 | Optional rows are disable-able without breaking the core | unit + live | `kanbanSync` defaults to `false` in code and the bundle patch turns it on; the projection runs as an agent that can see the Kanban tools and records why it was skipped (`kanban-skipped`, `kanban-refused`, `kanban-mirror-failed`, `kanban-lane-missing`). Measured interference: the Kanban orchestrator (`<workspace>/.dsh-kanban-orch.json`, `sourceColumnIds [c60]`, `entryColumnId c2`, `columnRoles c2/c5/c3`, `dispatchModel deepseek-chat`) pulled a mirrored card into In Progress and started its own developer dialog — mirrored cards now live in a `Team Mode` lane the mirror created (column `c964`), cancel/approve/send-back are written as card comments, and the stage column is named inside the comment ||
| A19 | Tests green | live | `npm test` 19/19, `npm run check:manifest` (manifest + role files), `npm run check:manifest` wiring step: 9 role tools → 11 Host backends, 9 panel actions implemented, `{ data, result }` wrapper pattern rejected |

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

Role profiles are continuable subagent children of the Manager session, and the profile's
`@deepseek-ai/dsh-subagent` `maxActiveSubagents` counts *resident* activations. This profile has `1`:
a sequential chain works (a role releases its slot when its turn ends), but two roles running at the
same time do not fit — that is when a hand-off answers `subagent limit reached (active child limit: 1)`. The Host now reports that with a hint
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
  approval, and Kanban status-column projection (card creation, transition comments, and stage-to-column
  moves are implemented and unit-tested; the live mirror needs the newest installed revision — see
  projected today).
- `CHANGE_ME` in the repository URL until the GitHub address is known.
