/**
 * @viz/dsh-team-mode — Web UI client half.
 *
 * Registers the Team page: a sidebar entry plus a keyed `main` panel that shows the persistent
 * team of the selected workspace (Manager session, role profiles with their live activity, the
 * task board with the human acceptance gate) and edits the role agent.md files.
 */
window.__ModuleLoader__.load({
  id: '@viz/dsh-team-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-team-mode'

    const DICTS = {
      en: {
        workspaceLabel: 'Workspace',
        loading: 'Loading team…',
        refresh: 'Refresh',
        manager: 'Manager',
        openManager: 'Open manager chat',
        newManagerChat: 'New manager chat',
        noManager: 'No Manager session yet. Start one and the team binds to it.',
        managerInactive: 'inactive',
        managerRunning: 'running',
        profiles: 'Role profiles',
        profilesHint: 'Sessions of these roles persist across chats and restarts.',
        activity: 'Activity',
        open: 'Open',
        interrupt: 'Interrupt',
        tasks: 'Task board',
        tasksHint: 'Stages advance automatically; acceptance is a human action here.',
        task: 'Task',
        status: 'Status',
        revision: 'Rev',
        verdict: 'Verdict',
        awaiting_approval: 'awaiting approval',
        accepted: 'accepted',
        active: 'active',
        queued: 'queued',
        blocked: 'blocked',
        cancelled: 'cancelled',
        approve: 'Approve',
        reject: 'Send back',
        cancelTask: 'Cancel',
        approvalNote: 'Note for the team (optional)',
        roles: 'Roles (agent.md)',
        rolesHint: 'Role files live outside the workspace and define each agent profile.',
        editRole: 'Edit role',
        roleName: 'Name',
        roleDescription: 'Description',
        roleBody: 'Role specification (agent.md)',
        saveRole: 'Save role',
        deleteRole: 'Delete override',
        newRole: 'New role id',
        created: 'Saved.',
        actionFailed: 'Action failed: ',
        loadFailed: 'Could not load the team: ',
        concurrency: 'Busy roles',
        personaDrift: 'role file changed',
        panelTitle: 'Team',
      },
      zh: {
        workspaceLabel: '工作区',
        loading: '正在加载团队…',
        refresh: '刷新',
        manager: '管理者',
        openManager: '打开管理者会话',
        newManagerChat: '新建管理者会话',
        noManager: '还没有管理者会话。新建一个即可绑定团队。',
        managerInactive: '未运行',
        managerRunning: '运行中',
        profiles: '角色档案',
        profilesHint: '这些角色的会话跨会话与重启持续存在。',
        activity: '状态',
        open: '打开',
        interrupt: '中断',
        tasks: '任务看板',
        tasksHint: '阶段自动推进；验收需要在这里由人确认。',
        task: '任务',
        status: '状态',
        revision: '版本',
        verdict: '结论',
        awaiting_approval: '待验收',
        accepted: '已验收',
        active: '进行中',
        queued: '排队',
        blocked: '受阻',
        cancelled: '已取消',
        approve: '验收',
        reject: '退回',
        cancelTask: '取消',
        approvalNote: '给团队的说明（可选）',
        roles: '角色（agent.md）',
        rolesHint: '角色文件位于工作区之外，定义每个智能体档案。',
        editRole: '编辑角色',
        roleName: '名称',
        roleDescription: '说明',
        roleBody: '角色规范（agent.md）',
        saveRole: '保存角色',
        deleteRole: '删除覆盖',
        newRole: '新角色 id',
        created: '已保存。',
        actionFailed: '操作失败：',
        loadFailed: '无法加载团队：',
        concurrency: '忙碌角色',
        personaDrift: '角色文件已变更',
        panelTitle: '团队',
      },
      ru: {
        workspaceLabel: 'Воркспейс',
        loading: 'Загружаю команду…',
        refresh: 'Обновить',
        manager: 'Менеджер',
        openManager: 'Открыть чат менеджера',
        newManagerChat: 'Новый чат менеджера',
        noManager: 'Сессии менеджера ещё нет. Начните новую — команда привяжется к ней.',
        managerInactive: 'не активен',
        managerRunning: 'работает',
        profiles: 'Роли команды',
        profilesHint: 'Сессии этих ролей сохраняются между чатами и после перезапуска.',
        activity: 'Состояние',
        open: 'Открыть',
        interrupt: 'Прервать',
        tasks: 'Доска задач',
        tasksHint: 'Стадии продвигаются автоматически; приёмку подтверждает человек здесь.',
        task: 'Задача',
        status: 'Статус',
        revision: 'Рев.',
        verdict: 'Вердикт',
        awaiting_approval: 'ждёт приёмки',
        accepted: 'принято',
        active: 'в работе',
        queued: 'в очереди',
        blocked: 'заблокировано',
        cancelled: 'отменено',
        approve: 'Принять',
        reject: 'Вернуть',
        cancelTask: 'Отменить',
        approvalNote: 'Комментарий команде (необязательно)',
        roles: 'Роли (agent.md)',
        rolesHint: 'Файлы ролей лежат вне воркспейса и определяют каждый профиль агента.',
        editRole: 'Редактировать роль',
        roleName: 'Имя',
        roleDescription: 'Описание',
        roleBody: 'Спецификация роли (agent.md)',
        saveRole: 'Сохранить роль',
        deleteRole: 'Удалить переопределение',
        newRole: 'id новой роли',
        created: 'Сохранено.',
        actionFailed: 'Действие не удалось: ',
        loadFailed: 'Не загрузилось состояние команды: ',
        concurrency: 'Занятых ролей',
        personaDrift: 'файл роли изменён',
        panelTitle: 'Команда',
      },
    }

    const STYLES = `
.team-root { color: var(--dsw-alias-label-primary, inherit); font: var(--dsw-font-xs-13, inherit); padding: 12px 14px 24px; max-width: 1100px; height: 100%; overflow: auto; overscroll-behavior: contain; }
.team-root textarea { max-height: 46vh; }
.team-root details { margin: 0 0 18px; }
.team-root details > summary { cursor: pointer; font-weight: 600; }
.team-main-shell { display: block; min-height: 100%; }
.team-root *, .team-root *::before, .team-root *::after { box-sizing: border-box; }
.team-section { margin: 0 0 18px; border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28)); border-radius: 10px; padding: 10px 12px; }
.team-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 14px; }
.team-title { font-weight: 700; font-size: 1.05em; margin: 0 8px 0 0; }
.team-muted { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.85)); font-size: .92em; }
.team-error { color: var(--dsw-alias-state-error-primary, #c0392b); margin: 6px 0; }
.team-ok { color: var(--dsw-alias-state-business-primary, #1a7f37); margin: 6px 0; }
.team-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid rgba(128,128,128,.16); }
.team-row:first-child { border-top: 0; }
.team-role { min-width: 110px; font-weight: 600; }
.team-tag { border-radius: 999px; padding: 1px 8px; border: 1px solid rgba(128,128,128,.32); font-size: .88em; }
.team-tag.is-running { color: var(--dsw-alias-state-business-primary, #1a7f37); }
.team-tag.is-await { color: var(--dsw-alias-state-warn-primary, #b8860b); }
.team-tag.is-drift { color: var(--dsw-alias-state-warn-primary, #b8860b); }
.team-btn { border: 1px solid rgba(128,128,128,.35); border-radius: 7px; padding: 3px 9px; background: transparent; color: inherit; cursor: pointer; }
.team-btn:disabled { opacity: .5; cursor: default; }
.team-input, .team-select, .team-text { border: 1px solid rgba(128,128,128,.35); border-radius: 7px; padding: 4px 7px; background: transparent; color: inherit; font: inherit; }
.team-text { width: 100%; min-height: 260px; resize: vertical; white-space: pre; }
.team-tasks { width: 100%; border-collapse: collapse; }
.team-tasks th, .team-tasks td { text-align: left; padding: 5px 7px; border-bottom: 1px solid rgba(128,128,128,.16); vertical-align: top; }
.team-tasks th { font-size: .88em; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.85)); font-weight: 600; }
.team-note { width: 220px; }
`

    function TeamIcon({ size } = {}) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: edge, height: edge, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 },
        h('circle', { cx: 12, cy: 7, r: 3 }),
        h('circle', { cx: 5, cy: 17, r: 2.4 }),
        h('circle', { cx: 19, cy: 17, r: 2.4 }),
        h('path', { d: 'M12 10v3M12 13l-5 3M12 13l5 3' }),
      )
    }

    async function api(action, payload) {
      const response = await fetch('/api/team-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload || {}) }),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `HTTP ${response.status}`)
      }
      return data
    }

    // Set by apply(): a render failure is reported to the Host, where the diagnostic file is the
    // only place a browser-side failure can be read.
    let panelFailure = () => undefined
    let localeMounted = false

    function PanelGuard(props) {
      try {
        return h(TeamPage, props)
      } catch (cause) {
        panelFailure(`render: ${cause?.stack ?? cause}`)
        return h('div', { className: 'team-root' }, h('p', { className: 'team-error', role: 'alert' }, `Team Mode: ${String(cause?.message ?? cause)}`))
      }
    }

    function TeamPage({ t, uiWorkspace }) {
      const [workspaces, setWorkspaces] = React.useState([])
      const [workspaceId, setWorkspaceId] = React.useState('')
      const [snapshot, setSnapshot] = React.useState(null)
      const [roles, setRoles] = React.useState([])
      const [role, setRole] = React.useState(null)
      const [newRoleId, setNewRoleId] = React.useState('')
      const [notes, setNotes] = React.useState({})
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const workspace = workspaces.find((item) => item.workspaceId === workspaceId) ?? workspaces[0] ?? null

      const load = React.useCallback(
        async (silent) => {
          try {
            if (!workspaces.length) {
              const listed = await api('workspaces')
              const items = Array.isArray(listed.workspaces) ? listed.workspaces : []
              setWorkspaces(items)
              setWorkspaceId((current) => current || (items[0] ? items[0].workspaceId : ''))
              if (!items.length) {
                setSnapshot(null)
                return
              }
            }
            if (!workspace) return
            const next = await api('snapshot', { workspaceId: workspace.workspaceId, path: workspace.path })
            setSnapshot(next)
            const roleList = await api('roles')
            setRoles(Array.isArray(roleList.roles) ? roleList.roles : [])
            if (!silent) setError('')
          } catch (cause) {
            if (!silent) setError(t('loadFailed') + message(cause))
          }
        },
        [workspace, workspaces.length, t],
      )

      React.useEffect(() => {
        let alive = true
        setSnapshot(null)
        void load(false)
        const timer = setInterval(() => {
          if (alive) void load(true)
        }, 6000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const run = async (operation) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await operation()
          await load(true)
        } catch (cause) {
          setError(t('actionFailed') + message(cause))
          await load(true)
        } finally {
          setBusy(false)
        }
      }

      if (!workspaces.length) {
        return h('div', { className: 'team-root' }, h('p', { className: 'team-muted' }, t('noManager')))
      }

      return h(
        'div',
        { className: 'team-root' },
        h(
          'div',
          { className: 'team-head' },
          h('h2', { className: 'team-title' }, t('panelTitle')),
          workspaces.length > 1
            ? h(
                'label',
                null,
                `${t('workspaceLabel')} `,
                h(
                  'select',
                  { className: 'team-select', value: workspaceId, onChange: (event) => setWorkspaceId(event.target.value) },
                  workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title || item.path)),
                ),
              )
            : null,
          h('button', { className: 'team-btn', type: 'button', disabled: busy, onClick: () => load(false) }, t('refresh')),
        ),
        error ? h('p', { className: 'team-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'team-ok', role: 'status' }, notice) : null,
        snapshot
          ? h(
              React.Fragment,
              null,
              managerCard({ snapshot, t, uiWorkspace, run, busy }),
              profilesCard({ snapshot, t, uiWorkspace, run, busy }),
              boardCard({ snapshot, t, run, busy, notes, setNotes }),
              rolesCard({ roles, role, setRole, t, run, busy, newRoleId, setNewRoleId, setNotice }),
            )
          : h('p', { className: 'team-muted' }, t('loading')),
      )
    }

    function message(cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }

    function managerCard({ snapshot, t, uiWorkspace, run, busy }) {
      const running = snapshot.managerActivity === 'running' || snapshot.managerActivity === 'active'
      return h(
        'section',
        { className: 'team-section' },
        h(
          'div',
          { className: 'team-row' },
          h('strong', null, t('manager')),
          snapshot.managerSessionId
            ? h('span', { className: `team-tag${running ? ' is-running' : ''}` }, running ? t('managerRunning') : t('managerInactive'))
            : null,
          snapshot.managerSessionId
            ? h('button', { className: 'team-btn', type: 'button', disabled: busy, onClick: () => run(() => Promise.resolve(uiWorkspace && uiWorkspace.openSession(snapshot.managerSessionId))) }, t('openManager'))
            : null,
          workspaceTarget(snapshot)
            ? h(
                'button',
                {
                  className: 'team-btn',
                  type: 'button',
                  disabled: busy,
                  onClick: () => run(() => Promise.resolve(uiWorkspace && uiWorkspace.startSession(workspaceTarget(snapshot), { agentPreset: 'team-manager' }))),
                },
                t('newManagerChat'),
              )
            : null,
        ),
        snapshot.managerSessionId
          ? null
          : h('p', { className: 'team-muted' }, t('noManager')),
        h('p', { className: 'team-muted' }, `${t('concurrency')}: ${snapshot.activeWorkers} / ${snapshot.limits.maxConcurrentWorkers}`),
      )
    }

    function workspaceTarget(snapshot) {
      return snapshot.workspaceId && snapshot.workspaceId !== 'default' ? snapshot.workspaceId : snapshot.workspaceId || undefined
    }

    function profilesCard({ snapshot, t, uiWorkspace, run, busy }) {
      const profiles = snapshot.profiles || []
      return h(
        'section',
        { className: 'team-section' },
        h('h3', null, t('profiles')),
        h('p', { className: 'team-muted' }, t('profilesHint')),
        profiles.length === 0 ? h('p', { className: 'team-muted' }, '—') : null,
        profiles.map((profile) =>
          h(
            'div',
            { className: 'team-row', key: profile.role },
            h('span', { className: 'team-role' }, profile.role),
            h('span', { className: `team-tag${profile.activity === 'running' ? ' is-running' : ''}` }, profile.activity),
            profile.presetId ? h('span', { className: 'team-tag' }, profile.presetId) : null,
            profile.personaDrift ? h('span', { className: 'team-tag is-drift' }, t('personaDrift')) : null,
            h('button', { className: 'team-btn', type: 'button', disabled: busy, onClick: () => run(() => Promise.resolve(uiWorkspace && uiWorkspace.openSession(profile.sessionId))) }, t('open')),
            h(
              'button',
              {
                className: 'team-btn',
                type: 'button',
                disabled: busy,
                onClick: () => run(() => api('interrupt', { workspaceId: snapshot.workspaceId, path: snapshot.workspacePath, role: profile.role })),
              },
              t('interrupt'),
            ),
          ),
        ),
      )
    }

    function boardCard({ snapshot, t, run, busy, notes, setNotes }) {
      const tasks = snapshot.tasks || []
      const stages = (snapshot.workflow && snapshot.workflow.stages ? snapshot.workflow.stages : []).map((stage) => `${stage.id}→${stage.role}`).join(' · ')
      return h(
        'section',
        { className: 'team-section' },
        h('h3', null, t('tasks')),
        h('p', { className: 'team-muted' }, `${stages} · ${t('tasksHint')}`),
        tasks.length === 0 ? h('p', { className: 'team-muted' }, '—') : null,
        tasks.length
          ? h(
              'table',
              { className: 'team-tasks' },
              h('thead', null, h('tr', null, [t('task'), t('stage'), t('owner'), t('status'), t('revision'), t('verdict')].map((label) => h('th', { key: label }, label)))),
              h(
                'tbody',
                null,
                tasks.map((task) =>
                  h(
                    'tr',
                    { key: task.id },
                    h('td', null, h('div', null, task.id), h('div', { className: 'team-muted' }, task.subject)),
                    h('td', null, task.stage || '—'),
                    h('td', null, task.ownerRole || '—'),
                    h('td', null, h('span', { className: `team-tag${task.status === 'awaiting_approval' ? ' is-await' : ''}` }, t(task.status) || task.status)),
                    h('td', null, String(task.revision)),
                    h(
                      'td',
                      null,
                      task.status === 'awaiting_approval'
                        ? h(
                            React.Fragment,
                            null,
                            h('input', {
                              className: 'team-input team-note',
                              placeholder: t('approvalNote'),
                              value: notes[task.id] || '',
                              onChange: (event) => setNotes({ ...notes, [task.id]: event.target.value }),
                            }),
                            h(
                              'button',
                              {
                                className: 'team-btn',
                                type: 'button',
                                disabled: busy,
                                onClick: () =>
                                  run(() =>
                                    api('approve', {
                                      workspaceId: snapshot.workspaceId,
                                      path: snapshot.workspacePath,
                                      taskId: task.id,
                                      note: notes[task.id] || '',
                                    }),
                                  ),
                              },
                              t('approve'),
                            ),
                            h(
                              'button',
                              {
                                className: 'team-btn',
                                type: 'button',
                                disabled: busy,
                                onClick: () =>
                                  run(() =>
                                    api('rejectApproval', {
                                      workspaceId: snapshot.workspaceId,
                                      path: snapshot.workspacePath,
                                      taskId: task.id,
                                      note: notes[task.id] || '',
                                    }),
                                  ),
                              },
                              t('reject'),
                            ),
                          )
                        : task.verdict
                          ? h('span', { className: 'team-tag' }, task.verdict)
                          : null,
                    ),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function rolesCard({ roles, role, setRole, t, run, busy, newRoleId, setNewRoleId, setNotice }) {
      const open = async (roleId) => {
        try {
          const result = await api('readRole', { roleId })
          setRole({ id: roleId, meta: result.role.meta || {}, body: result.role.body || '', source: result.role.source })
        } catch (cause) {
          throw cause
        }
      }
      return h(
        'section',
        { className: 'team-section' },
        h('h3', null, t('roles')),
        h('p', { className: 'team-muted' }, t('rolesHint')),
        h(
          'div',
          { className: 'team-row' },
          (roles || []).map((item) =>
            h('button', { key: item.id, className: 'team-btn', type: 'button', disabled: busy, onClick: () => open(item.id).catch((cause) => setRole({ id: item.id, error: message(cause) })) }, item.id),
          ),
          h('input', { className: 'team-input', placeholder: t('newRole'), value: newRoleId, onChange: (event) => setNewRoleId(event.target.value) }),
          h(
            'button',
            {
              className: 'team-btn',
              type: 'button',
              disabled: busy || !/^[a-z][a-z0-9-]{0,40}$/.test(newRoleId),
              onClick: () =>
                run(async () => {
                  const saved = await api('saveRole', { roleId: newRoleId, meta: { name: newRoleId, description: '' }, body: `# ${newRoleId}\n\nRole behaviour to be written here.\n` })
                  if (saved.ok) {
                    setNotice(t('created'))
                    await open(newRoleId)
                    setNewRoleId('')
                  }
                }),
            },
            t('newRole'),
          ),
        ),
        role
          ? h(
              'div',
              null,
              role.error ? h('p', { className: 'team-error' }, role.error) : null,
              h('h4', null, `${t('editRole')}: ${role.id}${role.source ? ` (${role.source})` : ''}`),
              h(
                'div',
                { className: 'team-row' },
                h('label', null, `${t('roleName')} `, h('input', { className: 'team-input', value: role.meta.name || '', onChange: (event) => setRole({ ...role, meta: { ...role.meta, name: event.target.value } }) })),
                h('label', null, `${t('roleDescription')} `, h('input', { className: 'team-input', value: role.meta.description || '', onChange: (event) => setRole({ ...role, meta: { ...role.meta, description: event.target.value } }) })),
              ),
              h('textarea', {
                className: 'team-text',
                'aria-label': t('roleBody'),
                value: role.body,
                onChange: (event) => setRole({ ...role, body: event.target.value }),
              }),
              h(
                'div',
                { className: 'team-row' },
                h(
                  'button',
                  {
                    className: 'team-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: () =>
                      run(async () => {
                        const saved = await api('saveRole', { roleId: role.id, meta: role.meta, body: role.body })
                        if (saved.ok) {
                          setNotice(t('created'))
                          setRole({ ...role, source: 'user' })
                        }
                      }),
                  },
                  t('saveRole'),
                ),
                role.source === 'user'
                  ? h(
                      'button',
                      {
                        className: 'team-btn',
                        type: 'button',
                        disabled: busy,
                        onClick: () =>
                          run(async () => {
                            await api('deleteRole', { roleId: role.id })
                            const result = await api('readRole', { roleId: role.id })
                            setRole({ id: role.id, meta: result.role.meta || {}, body: result.role.body || '', source: result.role.source })
                          }),
                      },
                      t('deleteRole'),
                    )
                  : null,
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        // Keep the Host informed of what the browser half actually did: without browser control the
        // Host log is the only place a Client failure can be seen.
        const report = (action, detail) => {
          try {
            void fetch('/api/team-mode', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, ...(detail || {}) }),
            }).catch(() => undefined)
          } catch {
            /* the report is best effort only */
          }
        }
        report('ping', { detail: 'apply' })
        panelFailure = (message) => report('clientError', { message })

        let translate = (key) => DICTS.en[key] ?? key
        try {
          // Only the built-in locales get a dictionary, and no language is added to the shared
          // catalog: adding a language changes what every other plugin's locale registration must
          // cover, which is a cross-plugin side effect a panel plugin must not cause.
          // The half can be mounted twice in one page (bundled group plus its own row), so a second
          // registration is skipped instead of reported as a duplicate failure.
          if (!localeMounted) {
            ctx.locale.register(NS, { en: DICTS.en, zh: DICTS.zh })
            localeMounted = true
          }
        } catch (cause) {
          // The bundle is evaluated twice per page (once inside a combined group, once through its
          // own row), and each copy mounts its own plugin instance with its own module state. The
          // second copy therefore collides with the first on (namespace, locale): that is expected,
          // not a failure, and the dictionaries are already registered.
          const text = String(cause?.message ?? cause)
          if (text.includes('already has locale')) {
            console.info('dsh-team-mode: locale dictionaries already registered by the other mount of this bundle')
          } else {
            console.warn('dsh-team-mode: locale dictionary registration failed', cause)
            report('clientError', { message: `locale register: ${text}` })
          }
        }
        try {
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') translate = (key) => bound(key) || DICTS.en[key] || key
        } catch (cause) {
          console.warn('dsh-team-mode: locale bind failed', cause)
          report('clientError', { message: `locale bind: ${cause?.message ?? cause}` })
        }
        const t = translate

        try {
          ctx.effect(() => {
            const tag = document.createElement('style')
            tag.setAttribute('data-dsh-team-mode-style', '')
            tag.textContent = STYLES
            document.head.appendChild(tag)
            return () => tag.remove()
          }, 'team-mode.styles')
        } catch (cause) {
          console.warn('dsh-team-mode: style effect was not installed', cause)
          report('clientError', { message: `styles: ${cause?.message ?? cause}` })
        }

        const disposers = []
        try {
          // The `main` and `sidebar.panellist` cells belong to the layout domain: they are reached
          // through the layout inject surface, the same way the shipped panel rows do.
          const disposePanels = ctx.inject(['layout'], (surface) => {
            const slots = surface.slots ?? ctx.slots
            const disposeMain = slots.inject('main', () =>
              slots.register(
                { name: 'main', key: 'team-mode', locale: NS, inject: () => ({ renderPanel: () => h(PanelGuard, { t, uiWorkspace: ctx.uiWorkspace }) }) },
                (state) => h('div', { className: 'team-main-shell' }, state.renderPanel ? state.renderPanel() : null),
              ),
            )
            const disposeIcon = slots.inject('sidebar.panellist', () =>
              slots.register({ name: 'sidebar.panellist', id: 'team-mode', order: 16, label: () => t('panelTitle'), locale: NS }, (props) => h(TeamIcon, props)),
            )
            report('ping', { detail: 'slots registered' })
            return () => {
              disposeIcon()
              disposeMain()
            }
          })
          disposers.push(disposePanels)
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* one disposer failing must not skip the rest */
              }
            }
          }
        } catch (cause) {
          console.error('dsh-team-mode: slot registration failed', cause)
          report('clientError', { message: `slots: ${cause?.stack ?? cause}` })
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* already failing */
            }
          }
          return () => undefined
        }
      },
    }
  },
})
