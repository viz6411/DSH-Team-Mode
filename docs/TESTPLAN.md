# Test plan

## 1. Automated unit tests (`npm test`)

`test/core.test.mjs`, plain `node:test`, no DSH required — the pure modules carry the workflow
correctness:

| Area | What is proven |
|---|---|
| role files | frontmatter round-trip with scalars, inline lists and block lists |
| stage machine | `spec → build → verify → review` chain ends in `awaiting_approval`, never auto-accept |
| ownership | a developer cannot claim the designer's stage |
| CAS | a stale `expectedRevision` is refused instead of overwriting |
| rework | reviewer `verdict: reject` returns to `workflow.reworkStage`, bumps `iterations`, keeps the task active |
| concurrency | busy *roles* are counted; the extra task queues and is promoted when a role frees |
| human reject | rejecting an approval returns the task to the named stage with its role as owner |
| storage | per-workspace file persists and reloads; a corrupt file is recovered to an empty board |
| role catalog | packaged default, user override, new custom role, invalid id refused, delete falls back to the default |

Run: `npm test` (11 tests, `pass 11 / fail 0` at the time of writing).

## 2. Manifest check (`npm run check:manifest`)

Verifies the bundle shape before installation: patch and client exports, exported locales and icon,
packaged role files present, `client.js` registers a lazy factory with the package id and uses no
ESM imports, and the Host half carries no runtime dependency on DSH packages.

## 3. Live install verification (profile `web`, dsh 0.2.1-rc.2)

1. `plugin_manager install_bundle` with the package directory → expect `application: applied`,
   `warnings: []`.
2. Approval-free inspect:
   - `Config.listConfigs({name:"@viz/dsh-team-mode"})` → entry `team-mode`.
   - `Config.listConfigs({name:"@deepseek-ai/dsh-agent-preset"})` → `preset-team-manager`,
     `preset-team-developer`, `preset-team-designer`, `preset-team-tester`,
     `preset-team-reviewer`, `preset-team-researcher`.
3. `POST /api/team-mode` unauthenticated → expect `401` (route registered, auth enforced).
4. Client slots after a page reload: `Slots.listSubTree({root:"sidebar.panellist"})` contains
   `team-mode`; `{root:"main"}` contains key `team-mode`.

## 4. Manual end-to-end (acceptance criteria A1–A19 of the spec)

Start a chat with **Team Manager**, then:

1. **Persistence across chats**: delegate a task, close the chat, open a new Team chat, check
   `team_profiles` still lists the same role sessions (`activity: inactive` until used).
2. **Persistence across restart**: restart the Host process, open the Team panel — profiles and
   board are still listed; a new delivery cold-resumes the role.
3. **Direct user access**: open a role session from the panel and read its full reasoning; write to
   it directly; then `team_status` shows the workflow unchanged.
4. **Interrupt**: press Interrupt while a role is running — its turn stops, its inbox survives, the
   Manager can re-brief it.
5. **Escalation**: make a role ask (an underspecified brief) → the Manager receives `kind=question`
   and answers the user with `ask_user_question`, then `team_forward`.
6. **Gate enforcement**: no tool of the Manager can mark a task accepted; `awaiting_approval`
   changes only through the panel's Approve / Send back.
7. **Reject path**: send a task back from the panel → it returns to the chosen stage with the note
   in its reports.
8. **Concurrency**: with `maxConcurrentWorkers: 1`, the second delegation stays `queued` and is
   promoted automatically.
9. **Role editing**: edit a role in the panel, create a custom role, delete the override → the
   packaged default applies again; profiles created earlier report *role file changed*.

## 5. Known limits to re-check on every release

- Client half mount depends on the page loading the newly installed Client bundle: verify after a
  page reload, not from the install log alone.
- Preset rows mount lazily with the preset: the role row is proven live only when a Team preset is
  actually selected in a chat.
- `kanbanSync` (default `false`) projects a card on delegation and appends a comment on claim/complete through the Kanban plugin's own tools. Card *status columns* are not moved, and panel-driven transitions (Approve / Send back) are not projected because a panel action has no acting agent. Enabling it requires `@alpacachen/dsh-kanban` in the profile; without it the projection is skipped and Team Mode works unchanged.

## Round 5 additions (measured on this host)

- **Persona drift (A4).** Write `$DSH_HOME/team-mode/roles/<role>.md` as an override, call
  `panel.probeRole` for a role that already has a profile: `personaDrift` must be `true` for that role
  only, and `false` again after the override is deleted. This also proves the user role directory wins
  over the packaged one, and that `probeRole` on an existing profile costs no model turn.
- **Panel content (A11).** `panel.snapshot` must return `managerSessionId`, the role catalog, every
  profile with `presetId` and `activity`, the tasks with `stage`/`status`, and the workflow stages. A
  workspace without a Manager returns `managerSessionId: null`, which is the only case where the panel
  legitimately shows "no Manager yet".
- **Interrupt (A14).** `panel.interrupt {workspaceId, role}` answers `{ok: true}` when the profile exists.
  Interrupting a *running* role is verified by pressing the button in the panel while a role works.
- **Hand-off (A6).** `panel.probeHandOff {workspaceId, taskId, senderSessionId}` reports whether the next
  role profile was created or reused, its `parentSessionId`, and the platform's exact refusal reason if
  it could not start. A refusal because the completing role is still resident is retried by the Host.
