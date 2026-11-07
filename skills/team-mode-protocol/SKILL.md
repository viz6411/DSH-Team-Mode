---
name: team-mode-protocol
description: Protocol for the Team Mode workspace: persistent Manager + role profiles, Host task board with stages, structured Итог / QUESTION / BLOCKED reports, and the human acceptance gate. Load before working as a Team Mode role (manager, designer, developer, tester, reviewer, researcher).
---

# Team Mode protocol

Team Mode is a persistent team, not a one-off delegation. The Manager session and every role profile
are long-lived sessions of one workspace: they survive a new chat and a Host restart. Work happens on
the Host task board, and the Kanban board is only its human-readable mirror.

## Roles and their tools

| Role | Tools it has | What it may not do |
|---|---|---|
| Manager | `team_status`, `team_profiles`, `team_delegate`, `team_interrupt`, `team_forward`, `ask_user_question` | do the work itself; accept a task (acceptance is a human action in the panel) |
| Designer / Developer / Tester / Reviewer / Researcher | `team_tasks`, `team_task_claim`, `team_task_complete`, `team_report` | ask the human directly (`ask_user_question` is denied); touch another role's stage |

## The loop

1. Manager reads `team_status` (board, stages, active workers) and `team_profiles` (which role
   sessions already exist).
2. Unclear requirement → `ask_user_question` **by the Manager only**, then `team_forward` the answer
   to the role.
3. `team_delegate` creates the task at its first stage and hands it to the stage's role profile. A
   role busy with another task queues the new task instead of opening a second worker.
4. Role: `team_tasks` → `team_task_claim(taskId, expectedRevision)` → work →
   `team_task_complete(taskId, expectedRevision, {report, evidence, verdict})`.
5. On `verdict reject` the task returns to `workflow.reworkStage` with the note attached; the
   iteration counter grows.
6. After the last stage the task becomes `awaiting_approval`. **Only the Team panel can approve it or
   send it back.** No agent tool can do that.

## Report vocabulary

Every hand-off is one structured block, never a narrative:

- `Итог:` what is now true.
- `Доказательство:` commands run, their output, file paths and line numbers.
- `Осталось:` what is not done, with the reason.
- `QUESTION:` a decision only the human can make → `team_report(kind=question)`.
- `BLOCKED:` work cannot continue → `team_report(kind=blocked)` with what is missing.

Chat messages between roles stay one line: role, task id, criterion.

## Claim rules

- A claim is only accepted for the role that owns the current stage, with the current
  `expectedRevision`. A stale revision is refused: re-read `team_tasks` and claim again, do not
  overwrite.
- `team_report` for a task you do not own is stored on the board as a note; it does not move it.
- Interrupting a role (`team_interrupt`) stops its turn but keeps its inbox: after an interrupt the
  role still receives what was queued for it.

## Memory

The team memory (Mnemosyne) is shared. Recall before a task, record the decision after it, always
with `scope: "global"`. Secrets, tokens and `.env` contents never enter memory or chat.

## Evidence windows

Evidence a role records must cover the **whole lifetime of the task**, not just the minutes around its
own work: name the window you checked and what changed inside it. A window that stops when your stage
starts hides what other roles edited, and the reviewer has to rebuild that attribution from git history.
