# Install

## One command, to an agent of the target Harness

Say this to any agent in that Harness (it needs plugin management permission):

```
Install the plugin bundle https://github.com/CHANGE_ME/dsh-team-mode
into the current profile with plugin_manager (action: install_bundle),
then report the application result and the new patch rows.
```

The agent calls `plugin_manager` with `action: install_bundle` and the git URL as `target`
(a local directory path or a tarball works the same way). Reload the Harness page afterwards: the
**Team** entry appears in the sidebar.

## Manual install

```bash
git clone https://github.com/CHANGE_ME/dsh-team-mode
# then, in the target Harness, install the directory:
#   plugin_manager → install_bundle → target: /absolute/path/to/dsh-team-mode
```

From npm, once published:

```bash
# plugin_manager → install_bundle → target: @viz/dsh-team-mode
```

## Requirements

- DSH **0.2.1-rc.2** with the **web** profile (the bundle declares `dsh.compatibility`).
- Nothing to install by hand: packages shipped with DSH (`cordis`, subagent, persona, …) resolve
  from the DSH installation and are declared only as dev dependencies.
- No account, no network services, no extra daemons. State lives under `$DSH_HOME/team-mode/`.

## Profile settings Team Mode depends on

Role profiles are continuable subagent children of the Manager session, so the profile's
`@deepseek-ai/dsh-subagent` config caps how many role sessions can exist at once:

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxActiveSubagents: 6
```

With `maxActiveSubagents: 1` (a common default) only one role profile can be created: the second
delegation fails with `subagent limit reached (active child limit: 1)`, and the workflow stops after
the first stage. Set it to at least the number of roles the team runs side by side, matching
`teamMode.maxConcurrentWorkers`. This row belongs to the profile patch, so the human applies it.

## Verify after install

```
# approval-free inspect (or ask the agent to do it):
Config.listConfigs({ name: "@viz/dsh-team-mode" })        # → entry "team-mode"
Config.listConfigs({ name: "@deepseek-ai/dsh-agent-preset" }) # → preset-team-* rows
```

Then reload the page and check the sidebar **Team** entry, the preset picker
(**Team Manager**, **Team Developer**, …), and open a Team chat.

## Enable / disable

```
plugin_manager → list_plugins          # find the bundle and its rows
plugin_manager → set_bundle target=@viz/dsh-team-mode enabled=false
plugin_manager → remove_bundle target=@viz/dsh-team-mode
```

Disabling removes the Team rows from the composition; workspace state and role `agent.md` files
stay on disk under `$DSH_HOME/team-mode/`.

## Update

Reinstall the bundle (local checkout: `remove_bundle` then `install_bundle` again; a linked
checkout also re-reads its patch on the next composition). Role files and workspace state are not
touched by an update.

## Applying Host code updates (read this before testing a fix)

Host code changes go live with `remove_bundle` + `install_bundle` (a `set_bundle` toggle does **not**
reload Host code). If either call answers:

```json
{ "application": "restart-required", "restartReason": "unmanaged-plugin" }
```

the running process keeps the previous revision: live role sessions hold the plugin's fibers, and the
Host will not tear them down. The repository and the installed package are correct — the live process is
stale. A DSH restart (a human action) loads the new revision, or closing the role sessions first. Until
then, a fix that is committed and installed is *not* what the running workspace executes: check
`panel.diagnose` and `$DSH_HOME/team-mode/panel-signals.log` for signals the new code is expected to
write, and if they are absent, the old revision is still running.

Role prompts (`$DSH_HOME/team-mode/roles/<role>.md`, `roles/<role>.md`, and the `role.js` prompt
suffix) are read when a role composition mounts. A session that already has the preset keeps its mounted
revision; a **new** role session picks up the new text.
