# Team Mode and the Kanban board: who dispatches, who works, one agent at a time

## The two loops that exist on this host

| Loop | What it owns | Where it is configured |
|---|---|---|
| Kanban board engine (`dsh-kanban`, `lib/orchestrator.js`) | the board itself: columns, auto-pull from the source column into the entry column, WIP limit, label/assignee stamping, card comments, the serialized queue the board UI and the engine share, and — when allowed — starting a role session for the column's role | `<workspace>/.dsh-kanban-orch.json`: `enabled`, `sourceColumnIds`, `entryColumnId`, `doneColumnIds`, `wipLimit`, `enforceWip`, `autoPull`, `dispatchEnabled`, `columnRoles`, `tickMs` |
| Team Mode (`@viz/dsh-team-mode`) | the team: durable role profiles with their own `agent.md` and preset, the task board (`~/.dsh/team-mode/workspaces/<workspaceId>.json`), the stage machine, the hand-off that wakes a role, and the Kanban mirror | the `team-mode` config row: `maxConcurrentWorkers`, `maxProfiles`, `maxTasks`, `stages`, `reworkStage`, `humanGate`, `kanbanSync`; role residency capacity is `@deepseek-ai/dsh-subagent → maxActiveSubagents` in the profile patch |

## Where they collided, and what was measured

Mirrored cards used to be moved into the stage columns of the human board. The board engine drives those
columns (`columnRoles: {c2: developer, c5: tester, c3: reviewer}`) and, with `dispatchEnabled: true`, it
**started its own role session** for a mirrored card — on `dispatchModel: deepseek-proxy/deepseek-chat`, a
worker Team Mode neither owns nor tracks. Live evidence: comments `⚙ Оркестратор: за столбец «In Progress»
отвечает роль «developer»` and `⚙ Работа запущена: роль «developer», диалог создан` on mirror cards `k930`
and `k940`. Two dispatchers, two workers for the same card.

An intermediate fix put mirror cards in a private `Team Mode` column. That stopped the collision and was
rejected by the board owner as clutter: the board is one shared place, not two lanes. It is gone — lane
columns `c964` and `c1000` were deleted and every `[TM …]` mirror card was removed from both boards.

## The seam the board engine already offers, and why Team Mode does not take it

Before starting a session, the engine asks a Host service:

```js
wakeDelegate: () => ctx.get('groupChatWake')     // dsh-kanban/index.js:1174
```

and if that service answers `{ accepted: true }` the engine does not dispatch at all; if it answers
`{ accepted: false, retry: true }` the engine defers the card to a later tick, because — in the engine's
own words — "the channel holds the single model request". That is exactly the discipline this host needs.

`groupChatWake` is **owned by the group-chat channel plugin** on this profile, and Team Mode must not
register a Service under another plugin's key: the first attempt to provide it failed the whole entry with
`ReferenceError: Cannot access 'recordPanelSignal' before initialization` (the failure surfaced through the
catch of the provide call), i.e. claiming that key takes the plugin down.

So the seam is configured, not hijacked:

```json
// <workspace>/.dsh-kanban-orch.json
"dispatchEnabled": false,   // the engine never starts a worker of its own
"enforceWip": true,         // the board holds at most one card in the entry column
"wipLimit": 1               // one card in progress = one agent working
```

Applied on 2026-11-08 to `/home/viz/work/.dsh-kanban-orch.json` (backup: `.dsh-kanban-orch.json.bak-sequential`).
With that, the engine keeps every board rule it has — auto-pull, WIP gate, label and assignee stamping,
its `⚙` comments, the serialized write queue — and Team Mode is the only thing that wakes an agent.

## Why one agent at a time is not a preference but a property of this host

The inference host serves a single request and keeps one cache window. Team Mode role contexts run 80–150k
tokens. Two awake agents mean the next request is a different conversation: cache miss, a minutes-long
prefill, on **every** step. So:

- `maxConcurrentWorkers: 1` (the bundle default and the value in the shipped `cordis.patch.yml`);
- `handOff` refuses to start the next role while another role profile is `running` — it defers the hand-off
  and says so in its answer (`one agent at a time on this host`), and the deferred hand-off is retried;
- the board's `enforceWip`/`wipLimit: 1` keeps the human-visible half of the same rule: only one card sits
  in the entry column;
- `maxActiveSubagents` (profile patch, `@deepseek-ai/dsh-subagent`) counts **resident** role activations, not
  working agents. Profiles stay resident so they keep their persona and history between tasks; with
  `maxConcurrentWorkers: 1` only one of them is ever awake.

Escalation is the only way a task leaves the current agent: a role reports a blocker with `team_report`
(`kind=blocked`), the Manager answers or asks the person, and the work returns to the same or another role
through the stage machine — not through a parallel wake-up.

## What a mirrored card is now

`kanbanSync` projects the Team Mode task board onto the human board through the Kanban plugin's own
channel service — `kanbanBoard` with `read` and the whitelisted `act` (`getCard, addCard, updateCard,
moveCard, addComment`):

- one card per task, titled `[TM <task id>] <subject>`, created in the stage column the board already owns
  (queued/spec → Ready, build → In Progress, verify → Test, review/awaiting approval → Review, accepted →
  Done);
- every transition is a comment `[TM <task id>] claimed|advance|blocked|cancelled|accepted|sent back: …`;
- no board label is created or required: labels are the board owner's vocabulary;
- the Team Mode board stays authoritative: the mirror never decides anything.

Roles also move and comment on cards with their own `kanban_*` tools — that is the point of the shared
board — while the wake of a role stays with Team Mode.
