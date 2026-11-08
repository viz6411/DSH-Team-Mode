# Architecture map: who orchestrates what (measured on this host, 2026-11-08)

Two plugins touch the same board. This is the current division of labour, with the evidence for each line.

## The actors

| Actor | Lives in | What it actually owns |
|---|---|---|
| Board UI + board API | `dsh-kanban` (`lib/client.js`, `/api/kanban`, Service `kanbanBoard`) | the board file `<workspace>/.dsh-kanban.json`: columns, cards, labels, comments, the serialized write queue, `BOARD_READ_ONLY` |
| Board engine ("оркестратор") | `dsh-kanban` (`lib/orchestrator.js`, `/api/kanban-orch`, state `<workspace>/.dsh-kanban-orch-state.json`, config `<workspace>/.dsh-kanban-orch.json`) | auto-pull, WIP limit, assignee/label stamping, its `⚙` comments, card→session `links`, and — only if `dispatchEnabled` — starting a role session |
| Team Mode | `@viz/dsh-team-mode` (Host `index.js`, `lib/board.js`, `lib/workflow.js`, panel `/api/team-mode`, `~/.dsh/team-mode/workspaces/<workspaceId>.json`) | the task board, the stage machine, role profiles (durable sessions with their own `agent.md` and `team-<role>` preset), the wake of a role, the Kanban mirror |
| Platform | `@deepseek-ai/dsh-subagent`, `sessionController`, `agentPresets`, `sessions`, `sessionPersistence`, `workspaceRegistry` | child activations and their capacity (`maxActiveSubagents`), delivery between sessions, session↔workspace mapping |
| Group-chat channel plugin | installed `imGroup*` / team tools (`team_task_*`, `spawn_teammate`, `wait_agent`) | the group chat surface, and the Host Service key `groupChatWake` — **not owned by Team Mode** |

## What the board engine does on a tick (`tickMs: 20000`, started 2 s after storage is ready, `index.js:1586`)

1. Keeps `links` (card → the session that once worked it) and prunes dead ones.
2. **Hard WIP enforcement** (`lib/orchestrator.js:597-605`): `activeCards` = cards sitting in the flow columns
   (entry + downstream, source and Done excluded, `:256`). If `active > wipLimit` and `enforceWip`, the newest
   excess is moved **back to the source column** with a `⚙` comment.
3. **Auto-pull** (`:610-615`): only when `active < wipLimit` it takes `pickNextSource` (ordered by `pullOrder`)
   and moves one card from `sourceColumnIds` into `entryColumnId`.
4. **Column role stamping** (`:481-494`): when a card sits in a column that has a `columnRoles` entry and its
   own `assignee` is empty, the engine writes that role into `assignee`.
5. **Dispatch** (`:550-580`): gated by `dispatchEnabled` and by `inflight` against `wipLimit`. Before starting a
   session it asks the Host Service `groupChatWake` (`index.js:1174`): `accepted` → the engine does not dispatch;
   `retry: true` → the card is left for a later tick; no service or a refusal → it creates its own session with
   `sessionController` on `dispatchModel`. The role prompt it would use is built at `:300-312` ("В работе всегда
   ровно одна карточка … работай только по этой карточке").

### Measured today (`dispatchEnabled: false`, `enforceWip: true`, `wipLimit: 1`)

A test card `k1086` was moved by a person into **In Progress**. On the next tick the engine wrote two comments
and moved the card back:

```
⚙ Оркестратор: за столбец «In Progress» отвечает роль «developer» — карточка назначена на developer.
⚙ Оркестратор: возврат в исходный столбец — в работе не больше 1 (сейчас 2).
```

It stamped the assignee, enforced the WIP limit, and **woke nobody**: no session was created, `inflight` stayed
empty. Auto-pull also stays silent while the flow is occupied — a card sitting in *Test* already fills the single
WIP slot, so nothing new is pulled out of *Ready*.

**Consequence, stated plainly:** with dispatch off, a human-created card in *Ready*/*In Progress* has nobody who
wakes a worker. The engine is discipline, not a foreman. Today the only thing that wakes an agent is Team Mode's
own stage machine — so work moves when it entered the Team Mode board, and a card that only exists on the Kanban
board just waits for a person.

## What Team Mode does

- **Task board** (`lib/board.js`): tasks with `stage` (`spec → build → verify → review`), `ownerRole`, `status`
  (`active / awaiting_approval / accepted / blocked / cancelled`), revisions, `kanbanCardId`.
- **Stage machine** (`lib/workflow.js` + `stages`, `humanGate`, `reworkStage` in the config): `team_task_complete`
  either advances the stage, returns the task to `reworkStage` on a negative verdict, or stops at
  `awaiting_approval` for human acceptance in the Team panel.
- **Wake** (`index.js` `handOff`): wakes the role profile — creating it once (`ctx.subagents.startActivation`
  with `childId` reserved, `agentPreset team-<role>`, `openingPrompt` from that role's `agent.md`) or delivering a
  brief into the existing profile session (`ctx.subagents.sendMessage`). Every profile is a direct child of the
  Manager session, which is what makes `team_forward`, panel interrupt and a new Manager chat reusing profiles work.
- **Strict chain** (`maxConcurrentWorkers: 1`): while another role profile is `running`, `handOff` does not start
  the next one — it answers `deferred: true` and re-attempts after the current turn ends (`scheduleHandOffRetry`,
  40 attempts, 3 s apart).
- **Mirror** (`kanbanSync`): writes `[TM <task id>]` cards and transition comments through the Kanban plugin's own
  `kanbanBoard` Service (`read` + whitelisted `act`), into the stage columns the board already owns. The Team Mode
  board is authoritative; the mirror never decides anything.

## Where the parallelism knobs are

| Knob | Where | Current value |
|---|---|---|
| one role awake at a time | `team-mode` config `maxConcurrentWorkers` (bundle default 1) + the `handOff` gate | 1 |
| deferred wake-up | `scheduleHandOffRetry` in `index.js` | active |
| resident role sessions | profile patch, `@deepseek-ai/dsh-subagent → maxActiveSubagents` | 4 (residency, not parallel work) |
| one card in the flow | `<workspace>/.dsh-kanban-orch.json` → `wipLimit`, `enforceWip` | 1, true |
| board engine may start a worker | same file → `dispatchEnabled` | **false** |
| shared workflow policy (all boards) | `$DSH_HOME/kanban-orch.global.json` (our fork, R2.9) | columns/WIP/auto-pull/stamping live here |
| per-board switch | `<workspace>/.dsh-kanban-orch.json` keeps only `enabled` (R2.9) | `true` on `/home/viz/work` |
| a card may only be assigned to a role that exists | `/api/kanban` validates `assignee` against `agentPresets`, and the card editor offers only those roles | enforced since R2.9 |
| which columns the engine drives | same file → `sourceColumnIds`, `entryColumnId`, `doneColumnIds`, `columnRoles` | c60 → c2, c4 done, roles on c2/c5/c3 |
| how often the engine runs | same file → `tickMs` | 20000 ms |

`AGENTS.md` says "одновременно держи не больше 4 тиммейтов" — that is the platform capacity; Team Mode's rule for
*this host* (one inference slot, one cache window) is stricter: one awake agent.

## The open gap and the designed closure (not implemented yet)

`groupChatWake` is the seam the board engine already offers, but its key belongs to the group-chat channel plugin —
Team Mode cannot claim it (the first attempt crashed the whole entry). The closure that does not touch another
plugin's Service:

**Team Mode board watch.** A Host-side loop (own interval, e.g. `boardWatchMs: 20000`, config `boardWatch: true`)
that on each pass reads the board through `kanbanBoard.read` and, for a card that is

- in the entry column (`In Progress`),
- `assignee` equal to a Team Mode role of this workspace,
- not a `[TM …]` mirror card and not bound to an existing Team Mode task,
- and no role profile currently `running`,

creates the matching Team Mode task (`stage: build`, `ownerRole: <role>`, `kanbanCardId` bound), wakes that role
profile through the normal `deliver` path with the card as brief, and mirrors as usual. It inherits the strict
single-agent gate, so the engine keeps the board discipline and Team Mode remains the only waker.

Until this is built, a board-only card waits for a person or for the Manager to turn it into a Team Mode task.
