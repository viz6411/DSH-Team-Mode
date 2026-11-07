# Team Mode for DeepSeek Harness

A **persistent team of long-lived role agents** inside DSH, as a plugin bundle.

Standard DSH subagents are one-off helpers: summoned, they answer, and they are gone. Team Mode
gives a workspace a *staff*: a **Manager** chat you talk to, and role profiles (**Designer,
Developer, Tester, Reviewer, Researcher**) that are durable sessions with their own history,
surviving new chats and Host restarts. A declarative stage workflow moves each task through the
roles; **acceptance is a human action in the Team panel**, never a Manager decision.

```
user ⇄ Manager (chat)
         │  team_delegate / team_forward / team_interrupt
         ▼
   board task: spec → build → verify → review → awaiting_approval → accepted (by you)
         │              │           │            │
     designer       developer     tester      reviewer        researcher (ad-hoc)
   (persistent role sessions: every one openable and interruptable by you)
```

## What you get

| Capability | Where |
|---|---|
| Team panel (sidebar entry + page) | Web UI → **Team** |
| Persistent Manager per workspace | any chat started with the **Team Manager** preset |
| Role presets | **Team Manager / Developer / Tester / Reviewer / Designer / Researcher** in the preset picker |
| Role profiles (long-lived sessions) | Team panel → Role profiles → *Open* (also visible in the Manager chat's subagent list) |
| Task board with stages, revisions, CAS | Team panel → Task board; tools `team_*` for the agents |
| Human acceptance gate | Team panel → **Approve / Send back** on `awaiting_approval` tasks |
| Editable role specs (`agent.md`) | Team panel → Roles; files in `$DSH_HOME/team-mode/roles/<role>.md` |
| Workflow definition | `workflow:` in the bundle's `cordis.patch.yml` (or the row's Config in Settings) |

## Install

**Into any DSH, one command to an agent** (see [INSTALL.md](INSTALL.md) for details):

```
Install the plugin bundle from https://github.com/CHANGE_ME/dsh-team-mode into this Harness profile.
```

Or manually: `plugin_manager` → `install_bundle` with the package directory, a git URL or the npm
package name. Then reload the Harness page: the Team entry appears in the sidebar.

## First run

1. Open **Team** in the sidebar. If no workspace has a Manager yet, press **New manager chat**
   (it starts a chat with the `team-manager` preset).
2. Describe the work to the Manager. It calls `team_status`, decomposes the job and delegates:
   each delegation creates a board task at the first stage and delivers it to that role's session.
3. Open any role from the panel (or from the Manager chat's subagent list) to watch its full
   reasoning, interrupt it, or write to it directly — the workflow is not disturbed; the role
   reports to the Manager with `team_report`.
4. When a task reaches `awaiting_approval`, review the evidence and press **Approve** (or
   **Send back** with a note, which returns the task to a named stage).

## Tools

Manager: `team_status`, `team_profiles`, `team_delegate`, `team_forward`, `team_interrupt`.
Roles: `team_tasks`, `team_task_claim`, `team_task_complete` (with `verdict: pass|reject`),
`team_report` (`kind: question|blocked|note`).

Worker role sessions cannot call `subagent`, `spawn_teammate`, `send_message`, `workflow`,
`plugin_manager` or `ask_user_question`: escalation goes through the Manager, and delegation goes
through the board.

## Configuration (row `team-mode`)

| Field | Default | Meaning |
|---|---|---|
| `managerPresetIds` | `[team-manager]` | presets that identify a Manager session |
| `presetPrefix` | `team-` | role preset ids are `team-<role>` |
| `spawnProvider` | `spawn` | subagent provider used to start role profiles |
| `maxConcurrentWorkers` | `3` | how many distinct role sessions may hold an active task |
| `maxProfiles` | `8` | role profiles per workspace |
| `rolesDir` | `$DSH_HOME/team-mode/roles` | editable role `agent.md` files |
| `workflow.stages` | spec/designer → build/developer → verify/tester → review/reviewer | stage machine |
| `workflow.humanGate` | `true` | the last stage ends in human acceptance |
| `workflow.reworkStage` | `build` | where a `reject` verdict returns the task |
| `kanbanSync` | `false` | reserved: mirror board tasks into `@alpacachen/dsh-kanban` cards |

State per workspace: `$DSH_HOME/team-mode/workspaces/<workspace>.json` (Manager binding, role
profiles with their durable session ids, the task board, an event journal). Atomic writes, corrupt
files are backed up and rebuilt.

## Role files

`roles/<role>.md` (packaged) is overridden by `$DSH_HOME/team-mode/roles/<role>.md` (user). The
panel's Roles editor reads and writes the user copy; deleting it falls back to the packaged
default. A changed role file is reported as *role file changed* on the profile: the new text
applies to profiles created after the change, and recreating a live profile is your decision.

## Limits and honesty

- Role profiles are continuable subagents of the Manager session: while a Manager chat is closed
  the roles sleep and cold-resume on the next delivery. Their transcripts stay readable.
- One Manager per workspace is active at a time; opening a new Team chat rebinds the Manager and
  keeps the role profiles (the previous Manager id stays in the workspace journal).
- The acceptance gate is enforced by the Host: the Manager has no tool that marks a task accepted.
- Local-model friendly by default: 3 busy role sessions, short hand-off briefs.

Built with [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) plugin APIs: Host rows,
agent presets, tool registrations, session events, subagent runtime, and the Client slot system.
Architecture and test plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTPLAN.md](docs/TESTPLAN.md).

License: MIT.
