# Architecture

## The problem with the standard mode

DSH subagents are *task-scoped*: `subagent`/`subagent_fork` create a child that answers and
disappears from the user's working set. Roles are re-described on every call, they carry no
accumulated project knowledge, and nobody owns a workflow.

Team Mode keeps the same substrate (sessions, subagents, presets, tools) and adds four things:

1. **A persistent team per workspace** — one active Manager session, durable role profiles.
2. **A declarative stage machine** with a human acceptance gate the agents cannot bypass.
3. **Editable role identity** (`agent.md` per role, outside the workspace).
4. **A panel** where the user sees and touches every agent session directly.

## Component map

```
@viz/dsh-team-mode (bundle)
├─ cordis.patch.yml                 Host core row + 6 role presets + Client half via dsh.client
├─ index.js        Host core        teamMode service: registry, board, stage machine, profiles,
│                                   session/created Manager binding, POST /api/team-mode
├─ role.js         preset row       persona from agent.md, role tools, ctx.tools.restrict(...)
├─ client.js       Web Client half   slots: main (keyed 'team-mode') + sidebar.panellist icon,
│                                   locale dictionaries (en/zh/ru), panel fetches /api/team-mode
├─ lib/store.js                     per-workspace JSON file, serialized mutations, atomic write
├─ lib/board.js                     tasks (CAS revisions), reports, profile records, journal
├─ lib/workflow.js                  stages, gates: delegate/claim/complete/rework/concurrency
├─ lib/roles.js                     role catalog: user override of packaged roles + CRUD
├─ lib/schema.js                    Standard-Schema-V1 Config (no runtime schema dependency)
└─ roles/*.md                       packaged role specifications
```

State lives in `$DSH_HOME/team-mode/`: `roles/<role>.md` and `workspaces/<workspace>.json`
(Manager binding + history, profiles, tasks, last 500 events). One file per workspace, mutations
serialized through a per-workspace promise queue, written as tmp + rename. A corrupt file is
copied to `<file>.corrupt-<ts>` and rebuilt empty rather than being silently trusted.

## Persistence model (the core decision)

A role profile is a **continuable subagent child of the Manager session with a reserved child
session id**, started through the registered subagent provider:

```js
ctx.subagents.startActivation({
  provider: 'spawn', childId, label: role, delivery: 'caller',
  request: { parent: managerAgent, cwd, agentPreset: `team-${role}`, prompt },
})
```

- **Reuse**: the id is stored in the workspace file. Later deliveries use
  `ctx.subagents.sendMessage(managerAgent, profileSessionId, …)`; the subagent runtime cold-resumes
  the durable session when it is not live, so a role keeps its transcript across chats and restarts.
- **Direction**: Manager → role and role → Manager are both direct parent/child edges, which is
  what the subagent adjacency rules accept. No side channels.
- **Interrupt**: `ctx.subagents.interrupt(childSessionId, { kind: 'ancestor', agent: manager })` when
  the Manager is live, otherwise `{ kind: 'user', parentSessionId }` — the panel's Interrupt button
  works even with no Manager chat open.
- **Identity**: the role's `agent.md` becomes the preset persona (bundled persona package when the
  host resolves it, otherwise direct `ctx.systemPrompt.section(...)` registrations).

The alternative — the experimental agent-team plugin — was rejected deliberately: its roster and
task board live in the Lead session's event log, its ownership is never released automatically, and
`spawnTeammate` cannot attach an existing session. Team Mode owns its board and its registry.

## Manager binding

On `session/created`, a session whose `header.agentPreset` is in `managerPresetIds` becomes the
workspace's active Manager (`header.cwd` → `workspaceRegistry.resolveByPath`); the previous id moves
to `managerHistory`. Role profiles survive the rebinding — that is what makes the team persistent
while the chat is disposable.

## Workflow gates

`lib/workflow.js` is pure and unit-tested. A task is created at the first stage with that stage's
role as owner.

| Gate | Rule |
|---|---|
| delegate | only at the first stage; concurrency gate may leave the task `queued` |
| claim | the task's current stage must belong to the claiming role, and `expectedRevision` must match |
| complete | `pass` → next stage whose `requires` are satisfied; last stage → `awaiting_approval` (humanGate) or `accepted` |
| reject | returns to `workflow.reworkStage`, increments `iterations` |
| concurrency | counts *distinct busy roles* (`maxConcurrentWorkers`); extra tasks queue, and are promoted when a role frees |
| approval | Host-side only: the panel's Approve button (`POST approve`); no agent tool can accept |

`queued → active → awaiting_approval → accepted`, plus `blocked`/`cancelled` for exception handling.

## Panel transport

`ctx.inject(['connection'], …)` registers `POST /api/team-mode` (authenticated with the page
connection, same pattern as `@alpacachen/dsh-kanban`). Actions: `workspaces`, `snapshot`, `roles`,
`readRole`, `saveRole`, `deleteRole`, `interrupt`, `approve`, `rejectApproval`, `cancelTask`. The
Client half reads the same service methods the tools use, so a panel action and an agent action
cannot disagree about state.

Direct user access to a role stays on the platform's own addressed path (`uiWorkspace.openSession`,
the subagent UI in the Manager chat): Team Mode deliberately does not build its own chat surface.

## Extension points chosen for upgrade stability

- Stage machine, board and role parsing are pure modules with unit tests, independent of DSH APIs.
- Only four DSH seams are touched: `ctx.subagents.*`, `ctx.tools.register/restrict`,
  `ctx.systemPrompt` / persona, `ctx.sessionProjections`-free JSON state, and the Client slot
  catalog (`main`, `sidebar.panellist`). Config is validated through a hand-written
  Standard-Schema-V1 object so the bundle needs no runtime dependency on DSH packages.

## Rules learned from the first live install

- The Client half mounts from `package.json` → `dsh.client`. A patch row pointing at `client.js`
  fails the whole bundle on the Host: `ReferenceError: window is not defined`.
- A Client half must not call `locale.addLanguage`. A language belongs to the *shared* catalog, and
  adding one changes what every other plugin's locale registration must cover. In this harness the
  call took down `dsh-group-chat` on the same page boot — one plugin's panel plugin broke another
  plugin's UI. Register dictionaries for the built-in locales only.
- Client bundles are served in concatenated groups. A Client half that throws at mount can take its
  whole group with it, so every step of `apply` (locale, styles, slots) is isolated and failures are
  reported to the Host through `/api/team-mode` (`ping`, `clientError`), which writes
  `$DSH_HOME/team-mode/panel-signals.log`: the Host log is not journald here, so this is the only
  remote diagnostic a panel plugin has.

## Rules learned from the first real install (round 3)

These are the reasons the mode appeared to "not work at all", in the order they were found.

1. **A preset with a `broken` marker is not offered in the mode picker.** The picker filters
   `preset.broken === undefined` (`@deepseek-ai/dsh-client-ui-agent-preset`). So when a user says
   "the new mode is not in the list", the first thing to read is the roster
   (`agentPresets.remoteExportList()` → `{ presets: [{ id, name, isDefault, broken }] }`), not the
   install log. `panel.diagnose` returns exactly this plus `compositionInventory()` rows with their
   mount state.
2. **`tools.restrict()` rejects a name it does not know, and that throws the preset into `broken`.**
   Its contract says "Empty filters, unknown names, scope-local names, and reserved transport names
   fail": it only accepts *globally registered* tools. A deny list naming `subagent`, `spawn_teammate`,
   `ask_user_question` (preset-scope tools, or tools whose plugin is not installed) breaks every preset
   that mounts the row. `role.js` now filters the deny list against `ctx.tools.schemas()` and degrades
   to a warning. Boundaries that a preset controls itself are enforced by the preset YAML not mounting
   the tool.
3. **A bundle patch is parsed as plain YAML.** The cordis `!!js` tag works in a profile patch and is
   rejected in `dsh.bundle.patch` (`unknown tag … yaml.org,2002:js`), and the install then rolls back
   `package.json`, `pnpm-lock.yaml` and `node_modules`. Also, a plugin row can have a *required*
   option: `@deepseek-ai/dsh-tool-fs-search` needs `sampleOverCapGlobResults`, and a missing one marks
   the whole preset broken. `scripts/check-package.mjs` now fails on both patterns.
4. **A tool result must be lossless JSON.** If the returned value carries a key whose value is
   `undefined` (or `NaN`, `Infinity`, a `Date`, a function), the Harness rejects the call with
   `ToolOutputError / INVALID_TOOL_OUTPUT: value is not lossless JSON`, and the agent sees a useless
   message. Every team tool returns through `lib/json.js` `toolResult()`, which strips `undefined`
   keys, maps non-finite numbers to `null`, turns dates into ISO strings and breaks cycles.
5. **A continuable child can only be messaged by its direct parent or its child.** So all role profiles
   are children of the *Manager session* (`handOff` prefers the live Manager as the parent), which is
   what keeps `team_forward`, panel interrupt by parent address and a cold-resumed role working. The
   completing role is only a fallback authority when the Manager is offline.
6. **Diagnostics that actually work on this host.** The Host logger does not reach
   `journalctl --user -u dsh-web`, so `panel-signals.log` under `$DSH_HOME/team-mode/` is the channel
   the Client half writes failures into, and `POST /api/team-mode {"action":"diagnose"}` is readable
   from a shell with the same cookie the browser uses.

7. **`store.mutate` hands back exactly what the callback returned.** A callback that returned
   `{ data, result }` made every tool return the whole workspace object, and that object carries a
   `log` function — which the Harness rejects as `INVALID_TOOL_OUTPUT: value is not lossless JSON`.
   The board mutation had already happened, so the visible symptom was a role agent reporting itself
   blocked after a *successful* stage completion. Callbacks now return the result directly, and
   `scripts/check-tools.mjs` fails on the wrapper pattern.
8. **`maxActiveSubagents` counts resident activations, not durable sessions.** A role profile that
   finished its turn releases its slot, so a chain designer → developer → tester works even when the
   cap is `1`; two roles that are *running at the same time* do not fit. `panel.probeHandOff` reports
   the real reason for a refused hand-off, and `handOff` falls back to the previous role's session as
   parent when the Manager session's capacity is full.
9. **A hand-off that the platform refuses is deferred, not lost.** Because residency counts against the
   child cap, a `team_task_complete` that needs a *new* role profile can be refused while the completing
   role is still running. `tools.complete` then keeps the board on the next stage, tells the role why,
   and the Host repeats the same hand-off from the Manager session once that role's turn ends
   (`scheduleHandOffRetry`, bounded retries, cancelled when the plugin disposes). `panel.probeHandOff`
   is the installer's way to run or repair one hand-off and read the platform's real answer.
