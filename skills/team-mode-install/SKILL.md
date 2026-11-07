---
name: team-mode-install
description: Install or update the Team Mode plugin (@viz/dsh-team-mode) into the current DSH profile, then verify that the Host core, the role presets and the Team panel are actually live. Use when the user asks to install Team Mode, reinstall it, or check why the Team panel does not appear.
---

# Installing Team Mode into a DSH profile

Team Mode ships as one Cordis bundle: Host core + role presets (mounted from `agent.md` role files) +
the Team panel in the Web UI. Installation is a profile change, so the human owns the decision to run
it; state what will change before running it.

## One command from the human to an agent

> «Установи Team Mode из `<путь к репозиторию или git-адрес>` в текущий профиль и проверь, что он
> работает.»

Steps the agent then performs:

1. **Get the code.** If a git URL was given: `git clone <url> <workspace>/dsh-team-mode` (or
   `git pull` if it already exists). If a directory was given, use it as-is.
2. **Check the bundle before installing:** `npm run check:manifest` in that directory (verifies the
   patch rows, exports, packaged role files and the Client-half format) and `npm test` (the stage
   machine and storage gates). Both must pass.
3. **Install:** `plugin_manager` with `action: install_bundle`, `target: <absolute directory>` — a
   local directory is linked, so later edits to the checkout are picked up on the next reload. Expect
   `application: "applied"` and `warnings: []`. If the result says `already-installed`, run
   `remove_bundle` for `@viz/dsh-team-mode` first, then `install_bundle` again.
4. **Verify the Host half** (no approval needed):
   - `cordis_inspect_query` → provider `Config`, method `listConfigs`, `input: {name:"@viz/dsh-team-mode"}`
     → an entry `include:team-mode`.
   - `listConfigs` with `input: {name:"@deepseek-ai/dsh-agent-preset"}` → `preset-team-manager`,
     `preset-team-developer`, `preset-team-designer`, `preset-team-tester`, `preset-team-reviewer`,
     `preset-team-researcher`.
5. **Check the child cap the profile allows.** Role profiles are continuable subagent children of the
   Manager session, so `@deepseek-ai/dsh-subagent`'s `maxActiveSubagents` in the profile patch decides
   how many roles can exist at once. If it is `1`, the second delegation fails with
   `subagent limit reached (active child limit: 1)` and the workflow stops after the first stage — tell
   the human to raise it to at least `teamMode.maxConcurrentWorkers` (the profile patch is theirs).
5. **Verify the Client half.** The bundle row for `client.js` is *not* a patch row — the Web client
   loads it from `package.json` → `dsh.client`. A page reload is required: profile-installed client
   bundles are not hot-reloaded.
   - `cordis_inspect_query` → provider `Slots`, method `listSubTree`, `input: {root:"sidebar.panellist"}`
     → an occupant with `id: "team-mode"`.
   - `{root:"main"}` → an occupant with `key: "team-mode"`.
   - If neither appears, the browser still runs the old page: ask the human to reload
     (Ctrl+Shift+R) and re-check. Do not claim it is installed from the install log alone.
6. **Verify the mode works.** Start a chat with the `team-manager` preset, ask for one small task and
   check `$DSH_HOME/team-mode/workspaces/<workspaceId>.json`: `managerSessionId`, one profile per
   role with its own `sessionId` and `presetId`, and the task with its stage and revision.

## Rollback and blast radius

- `plugin_manager` with `action: set_bundle`, `target: @viz/dsh-team-mode`, `enabled: false`
  removes the bundle from the composition immediately — use it first when a reload shows a broken
  page, then investigate.
- State lives in `$DSH_HOME/team-mode/` (workspace boards, role overrides, `panel-signals.log`).
  Disabling the bundle does not delete it; removing the bundle keeps it.
- A Client half must never call `locale.addLanguage`: a language belongs to the shared catalog, and
  adding one breaks other plugins' locale registration. It also must not be mounted as a Host patch
  row (`window is not defined` fails the whole bundle).

## Prove a stage hand-off

After a delegation, verify the next stage really started in the next role's session:

```
POST /api/team-mode {"action":"probeHandOff","workspaceId":"<id>","taskId":"<task id>","senderSessionId":"<completing role session>"}
```

It answers with `ok`, `created` (a new profile or a reused one), the refusal reason if the platform
would not start the profile, `handOffNote` when the fallback parent was used, the task view and every
profile with its `parentSessionId` and live activity. A hand-off refused because the completing role is
still resident is retried by the Host once that role's turn ends — check the board again a minute later
before calling it a failure.
