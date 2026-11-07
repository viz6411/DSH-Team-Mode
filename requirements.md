# ТЗ: режим «Команда» для DeepSeek Harness (dsh-team-mode)

Статус: проект ТЗ, revision 0.4 (2026-11-07).
Решения заказчика: **постоянная команда на workspace — обязательное требование v1** (собственный team registry + Host-board поверх agent-team, §3.2); профили lazy (§11.2); npm-аккаунта нет — установка из git-репозитория, публикация отложена (§11.3).
Целевой харнес: DeepSeek Harness (далее DSH), версия API `@deepseek-ai/*` 0.2.x (проверено на dsh 0.2.1-rc.2, cordis-plugin-loader ~1.0.6, cordis ~4.0.5).
Формат поставки: Cordis bundle из git-репозитория (источник истины); публикация в npm — отложенный этап (аккаунта нет; см. §11.3).

---

## 1. Постановка задачи

### 1.1 Что хотим получить

Новый режим работы DSH — **Team Mode**: постоянная команда долгоживущих агентов с закреплёнными ролями, работающая по декларированному workflow. В отличие от стандартного режима (субагенты призываются под разовую задачу и умирают вместе с результатом), здесь:

- **Manager** — единственный «лицо к пользователю» по умолчанию. Собирает требования, декомпозирует задачи, раздаёт их работягам, ведёт workflow, эскалирует вопросы пользователю, ведёт приёмку и отчётность.
- **Работяги** (Developer, Tester, Reviewer, Designer, Researcher — расширяемо) — долгоживущие агенты-профили: одна сессия на роль на workspace, живёт между задачами и между перезапусками процесса.
- Пользователь **в любой момент видит** ход работы каждого агента (полные сессии: размышления, tool-calls, результаты) и может **напрямую** задать вопрос/дать команду любому агенту, не прерывая workflow.
- Прямое обращение к агенту **не является частью workflow**: это побочный канал обслуживания, не влияющий на статусы задач (если только сам ответ агенту не меняет их по правилам workflow).

### 1.2 Ключевая ценность

Автономная разработка командой агентов с минимальным вмешательством человека — но с гарантированной точкой вмешательства в любой момент. Именно этого нет в нативном OpenCode (агенты stateless, прямого канала к «сотруднику» нет) и критически ограничено в ванильном DSH (субагенты одноразовые; agent-team экспериментален и не даёт ролевых профилей, workflow-гейтов и удобного прямого канала).

### 1.3 Нецели v1 (осознанно)

- Многопроцессная/многомашинная команда (всё в одном Host-процессе, один workspace).
- Worktree-изоляция агентов (общий workspace; конфликты правок — координацией через write scopes и правила workflow).
- Вложенные команды (у работяг нет своих команд).
- Мутация workflow из UI.
- Автоматический pull/merge PR между агентами.

---

## 2. Анализ платформы DSH: на чём строим

Проверено по исходникам установленного dsh 0.2.1-rc.2 (профиль `web` активен, роли уже объявлены как agent presets).

| Возможность режима | Механизм DSH | Статус |
|---|---|---|
| Роли как настраиваемые композиции (tools+persona+ограничения) | `@deepseek-ai/dsh-agent-preset` + `dsh-agent-preset-registry` (`mountPreset`, PresetMount, `agent-preset/selected` log-only событие) | нативно; в профиле web presets `manager/developer/tester/reviewer/designer` уже есть |
| Личность роли («agent.md») | `@deepseek-ai/dsh-persona` (scope-only row: prefix/suffix/complete) внутри preset + `dsh-agent-instructions` (AGENTS.md-цепочки) | нативно; текущая конвенция `role-*` скилов — совместима |
| Долгоживущая сессия-профиль на workspace | continuable subagent: `dsh-subagent-spawn-in-process` provider + `SubagentActivationSpec.childId` (зарезервированный SessionId), durable session persistence, cold resume по descriptor'у (`subagent/descriptor`, persona/toolFilter reapplied on cold resume) | нативно; ключевой фундамент |
| Постановка задач агентом | `dsh-experimental-agent-team`: Lead==Manager (TeamId==SessionId), CAS task DAG, inbox-сообщения со steer/cold-resume, wait/interrupt — **только как runtime-механика внутри диалога**; реестр команды и задачи режима живут в Host-реестре workspace (§3.2) | experimental API — см. риски §7 |
| Прямой канал пользователь→агент | существующий addressed-subagent путь: `SubagentPromptRequest {parentSessionId, childSessionId, delivery: 'queue'|'steer'}` через Session Controller; UI-навигация в панель субагентов уже работает | нативно |
| Видимость сессий агентов в UI | subagent catalog/projection (`dsh-subagent` projection) + `dsh-experimental-client-ui-agent-team` (roster+task board в шапке conversation) | частично нативно; нужна своя панель профилей (§5.6) |
| Kanban-карточки как задачи | `@alpacachen/dsh-kanban` (установлен, v1.8.0), 16 `kanban_*` инструментов, per-workspace изоляция | внешний плагин; интеграция опциональной строкой |
| Память | MCP `mcp__mnemosyne__*` через mcp-client bundle | конфигурация профиля; режим задаёт политики скиллами/персонами |
| Mode-переключатель в UI (режим чата) | паттерн `dsh-plan-mode` + `dsh-client-ui-plan`: prompt section с waterfall override + клиентский mode control | воспроизводимый паттерн, не готовый «mode API» — см. риск R2 |
| Канал «вопрос агенту→пользователю» | `dsh-tool-ask-user` / `dsh-user-questions` | есть в стандартной композиции; для не-Manager'а требует решения (§5.8) |

**Вывод: план реализуем, но ядро режима — собственный слой.** Профили, задачи и доставка сообщений команды живут в team-core поверх нативных механизмов DSH (subagent lifecycle + Host-журнал); нативный agent-team остаётся вспомогательной runtime-механикой внутри диалога (или отпадает вовсе — решает spike R1/M1). Основные куски кода: team registry + journal + stage-machine (Host), re-adopt профилей (Host), role-catalog loader, team-tools, Client-панель команды, bundle/preset сборки.

---

## 3. Архитектура решения

### 3.1 Пакеты (monorepo-репозиторий)

```
dsh-team-mode/                      # git repo = источник истины
  packages/team-core/               # @yourorg/dsh-team-core   — Host service: registry профилей, role catalog, workflow engine
  packages/team-tools/              # @yourorg/dsh-team-tools — модельные инструменты Manager'а и работяг
  packages/team-ui/                 # @yourorg/dsh-team-ui    — Client: панель команды (роль-профили, статусы, переход в сессию)
  bundles/team-mode-profile/        # cordis.patch.yml: включает core+tools+ui+agent-team+kanban/mnemosyne опции
  presets/<role>/cordis.yml         # дефолтные presets ролей (manager/developer/tester/reviewer/designer/researcher)
  roles/<role>.md                   # встроенные agent.md-роли (fallback каталога)
  skills/role-<name>/               # role-skill'ы (совместимые с текущими)
  test/, docs/, scripts/
```

Публикация и установка (v1 — без npm, аккаунта у заказчика нет): репозиторий клонируется, `install_bundle` ставится с пути к бандлу. Чтобы агент поставил режим **одной командой**, репозиторий содержит: `INSTALL.md` с exact-командами (git clone → plugin_manager install_bundle с абсолютным путём к `bundles/team-mode-profile`), скрипт `scripts/install.mjs` (проверяет dsh version, затем печатает точную инструкцию для plugin_manager — скрипт не лезет в `$DSH_HOME`) и установочный скилл `install-team-mode` для агента. npm-публикация (`@scope/dsh-team-*`, установка по имени пакета) — отдельный этап после появления npm-аккаунта; имена пакетов в monorepo фиксируются сейчас, чтобы будущая публикация не требовала переименований.

Оговорка про `install_bundle` (важно для M1): менеджер плагинов DSH принимает **npm-спеки или npm-реестры**, а не произвольную локальную директорию. Поэтому установка без npm делается так: клонированный репозиторий публикуется в **локальный offline-реестр** (`verdaccio`/`npm run dev`-подобный static registry, либо `file:`-спеки в bundle-зависимостях), и агент ставит бандл одним вызовом `plugin_manager install_bundle` с этим реестром. Точный механизм проверить spike'ом на старте M1; план B (если file:-спеки не проходят) — локальный static registry на 127.0.0.1, запускаемый скриптом установки. Требование «одна команда агенту» выполняется в обоих вариантах.

### 3.2 Team registry поверх agent-team (постоянная команда на workspace)

**Ключевое архитектурное решение v1 (требование заказчика).** Нативный agent-team хранит roster и task board **внутри лога Lead-сессии** (`team/member`, `team/task` пишутся только в сессию Lead'а; TeamId == sessionId Lead'а). Если строить режим прямо на нём, команда умирала бы вместе с Manager-диалогом — это противоречит главному требованию: работяги постоянны и доступны за пределами любого диалога. Поэтому **реестр команды (профили + задачи) живёт в Host-хранилище team-core, привязанный к workspace**, а нативный agent-team используется только как runtime-механика доставки/ожидания сообщений внутри текущего Manager-диалога.

**Role profile registry (Host, durable, per-workspace).**
Ключ workspace = абсолютный canonical cwd (тот же селектор, что у обычного чата DSH). Запись профиля:

```jsonc
// <dshHome>/storages/team-mode/workspaces/<workspaceKey>/profiles.json
{ "version": 1,
  "profiles": [{
    "role": "developer",            // id роли из каталога ролей
    "sessionId": "<reserved SessionId>", // ПОСТОЯННЫЙ id сессии-профиля; переживает все Manager-диалоги
    "createdAt": "...", "lastUsedAt": "...",
    "status": "active|failed",     // failed — создание не удалось; имя роли занято
    "agentPreset": "developer",    // какой preset смонтирован
    "personaHash": "...",          // hash agent.md на момент создания (обнаружение изменений)
    "lastManagerSessionId": "..."  // diagnostic: последний Lead, через которого роль работала
  }]}
```

- Профиль создаётся **единожды на workspace** при первом реальном делегировании роли (lazy — решение заказчика). Повторные делегирования той же роли идут в **ту же сессию**, независимо от того, какой Manager-диалог активен.
- Сессия профиля — continuable subagent c **зарезервированным childId** (генерируется реестром один раз). Дальнейшие обращения идут в эту сессию (steer/queue), cold resume — бесплатный механизм `dsh-subagent` continuation manager'а.
- Реестр переживает рестарт процесса: при boot Host проецирует профили; «оживление» ленивое — по первому сообщению роли.

**Manager session registry (Host, durable, per-workspace).**
`workspaces/<key>/manager.json`: `{ activeManagerSessionId, history: [...] }`. Team Mode чат = Manager-сессия текущего диалога; новый Team Mode диалог в workspace создаёт нового Manager-агента (новая Lead-сессия), **но состав команды не меняется** — реестр профилей тот же. TeamId нативной team-механики == sessionId активного Manager'а и является *транзитным*: он привязывает runtime-доставку к текущему диалогу, а не команду к диалогу.

**Re-adopt: как постоянные профили подключаются к текущему Lead'у (spine решения).** Нативный `spawnTeammate` создаёт ребёнка заново и не умеет «присоединять» существующую сессию. Team-core реализует re-adopt: при первом обращении Manager'а нового диалога к роли Host:
1. берёт из реестра постоянный `profileSessionId`;
2. оживляет сессию профиля через `ctx.agents.resume(ownerCtx, { resumeSessionId: profileSessionId, parentAgent: текущийManagerAgent })` (публичный API `AgentRegistry.resume` существует; `parentAgent` — runtime-ownership);
3. регистрирует роль в ростере текущего диалога provisioning-путём roster; **план Б** (обязателен как параллельный путь, spike M3): если re-adopt нативным roster невозможен без правок agent-team — Team-core доставляет сообщения напрямую в live-Agent профиля (inbox-steer), а UI-панель строится на собственной projection `teamMode` вместо `agentTeam`.
4. при закрытии Manager-диалога live-профили **не уничтожаются**: Host держит их residency независимо от Lead'а либо корректно draining с сохранением durable-сессии — поведение фиксируется spike'ом M3 и тестируется (A1/A2).

**Прямой доступ пользователя к профилям не зависит от Manager'а вообще**: панель команды открывает сессию роли напрямую (addressed-subagent путь; parentSession профиля = исторический создавший Lead, актуальный адрес даёт Host-реестр). Работа с ролью возможна, даже когда Team Mode чат закрыт.

**Workspace task board (Host, durable, per-workspace).**
`workspaces/<key>/tasks.json` + append-only события `team-mode/task` и `team-mode/stage` **в Host-журнале team-core** (отдельный durable log режима по образцу journal agent-team — не в логе Manager-сессии: задачи переживают закрытие любого диалога и рестарт Host'а). Stage-machine (§5.4) — источник истины о переходах этапов; нативные team-task могут служить зеркалом внутри диалога (для `wait_agent`/readiness), но при конфликте приоритет у Host-board. Это ровно тот «собственный task board», который в revision 0.x числился v2: требование заказчика поднимает его в v1.

Хранение: через `dsh-storage`/json-хранилище профиля (паттерн dsh-kanban: per-workspace файлы на диске) **плюс** log-only Session events для критичных переходов (принцип «durable log, derived state» как в agent-team).

### 3.3 Role catalog (agent.md-роли) — вне workspace

Роли живут в DSH home: `~/.dsh/team-mode/roles/<role>.md` (user-editable; editable через UI-настройку плагина, см. §5.7), плюс встроенный fallback-каталог пакета (`roles/*.md`). Формат файла роли:

```markdown
---
id: developer
name: Developer
description: Production-инженер ...
order: 11
preset:                    # как маппится в agent preset
  model: inherit           # inherit | <provider/model>
  tools: [bash, fs, fs-search, jobs, skill, goal]   # whitelist базового набора
  deny: [spawn_teammate, plugin_manager]
  maxTokens: ...
---
Тело = persona prefix (личность, специализация, правила работы,
требования к инструментам) — полный аналог agent.md OpenCode.
```

- Loader при старте читает каталог, валидирует frontmatter (schemastery), строит/монтирует presets через `dsh-agent-preset-registry` (`mountPreset`). Изменения файла роли подхватываются: для **новых** профилей — сразу; для существующих сессий — personaHash mismatch → предупреждение Manager'у + опция «re-persona» (новая persona применяется при следующем cold resume через descriptor persona, либо профиль помечается к пересозданию по согласованию с пользователем).
- Editing: панель настроек плагина (Client UI page) со списком ролей, редактором markdown + frontmatter-form для tools/model. Сохранение идёт Host-endpoint'ом плагина (не через fs-инструменты агента).

### 3.4 Workflow engine (гибрид: декларативный каркас + LLM Manager)

Декларация в конфиге бандла (`workflow.yaml` секция Config плагина или отдельный файл `<profileDir>/team-mode.workflow.yml`):

```yaml
stages:
  - id: spec        # роль designer
    role: designer
    doneWhen: "артефакт-спецификация сохранён и приложен к задаче"
  - id: build       role: developer   requires: [spec]
  - id: verify      role: tester      requires: [build]
  - id: review      role: reviewer    requires: [verify]
accept:             # финальная приёмка — только Manager+человек
  by: manager
  gate: human       # Manager не двигает Done без подтверждения человека (правило + гейт)
escalation:         # правила эскалации вопросов
  to: human
  via: ask_user_question   # через Manager; работяга пишет Manager'у
limits:
  maxConcurrentWorkers: 3    # очередь задач (среда: локальная модель ~40 ток/с)
  maxMembersPerTeam: 6       # потолок agent-team config
rework:
  onReviewReject: back-to-build   # review reject → новая итерация build с комментариями
```

Каркас соблюдается **программно** (Host-гейты, §5.4), гибкость решений — за Manager'ом (prompt+skill). Модель не может «случайно» нарушить цепочку: инструмент `team_assign` примет только разрешённый переход stage-machine.

---

## 4. Модель взаимодействия

### 4.1 Инструменты Manager'а (team-tools)

Инструменты режима — **собственные team-tools поверх Host-реестра** (§3.2), а не нативные agent-team инструменты: `spawn_teammate` в Team Mode запрещён (работяги — постоянные профили), нативные `send_message/wait/interrupt` доступны только Manager'у и только как runtime-механика текущего диалога (опционально, для готовности через native task mirror). Модельный API режима:

| Инструмент | Семантика |
|---|---|
| `team_delegate` | поставить задачу роли: `{role, brief, acceptanceCriteria, blockedBy?, writeScopes?}` → Host-stage-gate проверяет разрешённость этапа; при отсутствии профиля — lazy spawn постоянного профиля (или re-adopt существующего); создаёт Host-board запись + доставляет brief в сессию профиля (queue). Возвращает taskId+revision. |
| `team_profiles` | список профилей workspace: роль, sessionId, статус (running/inactive/failed), текущая задача, последняя активность. Профили переживают смену Manager-диалога. |
| `team_status` | снимок Host-board: stage по каждой задаче, блокировки, эскалации в ожидании человека. |
| `team_interrupt` | прервать текущий ход работяги (keepInbox; путь interrupt с authority `ancestor`/`user`). |
| `team_ask_user` | сформулировать вопрос человеку (обёртка ask_user_question с контекстом задачи) — канонический путь эскалации. |
| `team_report` | итоговый отчёт пользователю по вехе/приёмке. |
| kanban_* | существующие; Manager ведёт доску как человек-читаемое зеркало задач (см. §6). |

### 4.2 Инструменты работяг

Базовый набор fs/bash/jobs/skill/goal по whitelist роли. Плюс:

- `team_task_get/list/claim/complete` — операции **Host-board** режима (CAS-revision, как в agent-team; роль ведёт свою задачу на workspace-board).
- `team_report_to_manager` — «Итог: …» + доказательства; структурированный формат `[DONE|BLOCKED|QUESTION] {taskId} …`; доставка — inbox в live-сессию активного Manager'а (Host маршрутизирует по реестру, не по имени «lead»).
- `team_ask_manager` — вопрос/эскалация (тот же канал с QUESTION-тегом; Host-слушатель пингует Manager'а о непрочитанном вопросе).

Запрещено работягам: spawn teammates, plugin_manager, перемещение Review→Done, прямые вопросы человеку (v1; см. §5.8).

### 4.3 Прямые обращения пользователя

- В Team Mode чате (Manager) пользователь пишет как обычно — всё идёт Manager'у.
- Через **панель команды** (§5.6): выбрать роль → открыть её сессию (addressed-subagent путь, уже поддержан Web UI) → писать агенту напрямую; delivery `queue` (по умолчанию) или `steer` (прервать шаг и вручить сообщение).
- Прямые сообщения помечаются в истории агента source'ом `team-mode/direct-user`; правила роли (persona/skill) предписывают: прямой вопрос человека не меняет статус задачи; если человек даёт новое указание по задаче — агент обязан известить Manager'а (`team_report_to_manager` QUESTION/UPDATE), Manager решает, как это складывать в workflow.
- Прерывание хода работяги пользователем: кнопка панели → Host вызывает interrupt (Lead-authority `user` variant существует в `SubagentInterruptAuthority {kind:'user', parentSessionId}` — используем напрямую).

---

## 5. Ключевые решения реализации

### 5.1 Team Mode как «mode» чата

Mode = не отдельный процесс, а **композиция сессии + UI-переключатель**:
- Host-row `team-mode-gate` в бандле: на `session/created` (и при выборе preset'а Manager) помечает сессию `origin: team-mode-manager` в meta (log-only событие `team-mode/session-bound`). Сессии профилей наследуют parent = Manager.
- Client-row `ui-team-mode`: переключатель режима в composer (паттерн `dsh-client-ui-plan`) → при создании диалога выбирает preset `manager` и включает Team Mode flag запроса; Host читает flag и биндит workspace-Manager'а.
- В уже открытом обычном чате «convert to team mode» не делаем (v1): Team Mode включается при заведении нового диалога в workspace.

### 5.2 Profiles как continuable subagents (детали)

Используем `ctx.subagents.startActivation({provider:'spawn', childId: reserved, delivery:'caller'})` с заранее зарезервированным SessionId (генерируется реестром **один раз на workspace** и сохраняется навсегда). Дальнейшие обращения — не новые activations: re-adopt/resume постоянного профиля под текущего Lead'а (§3.2) + inbox-steer доставка; для человека — addressed prompt path. Cold resume существующий: descriptor reapplies persona+toolFilter; preset-состав восстанавливается по `agent-preset/selected`.

Риск «Manager-сессия мертва → профили осиротели»: профили имеют runtime parent = Manager при их activation, но durable parentSession указывает на Manager-сессию. При рестарте пользователя открывает Manager-сессию (resume), затем first delegate cold-resumes профили. Если пользователь хочет работать с ролью без Manager'а — панель позволяет открыть сессию профиля напрямую (addressed path валидирует parent/child; Host временно «оживляет» профиль по обращению человека, Manager не обязателен для чтения истории).

### 5.3 Lifecycle и limits

- `maxConcurrentWorkers`: Host-очередь делегирований (FIFO по приоритету задач); лишние делегирования становятся pending в task board, Manager получает подсказку. Снимает нагрузку локальной модели.
- лимиты Host-board режима: `maxProfiles` = число ролей каталога, `maxTasks` 256, лимит размера сообщения по умолчанию; если нативный agent-team остаётся в композиции (runtime-механика диалога) — его config зеркаляет эти лимиты (cap maxMembers=8).
- Task ownership: нативного aut release нет → Host-слушатель: при `subagent/end`/idle роли с in-progress задачей и stopReason≠completed — автоматический reopen задачи + уведомление Manager'у (закрывает известную дыру agent-team «no automatic ownership release»).

### 5.4 Workflow-гейты (программный каркас)

Host-side stage-machine на операциях team-tools режима (`team_delegate`, `team_task_claim/complete`):
- tool-middleware (waterfall на регистрации инструментов team-tools): `claim` роли разрешён только для задачи, чей текущий stage == её роль; `complete` роли проверяет acceptance criteria presence и переводит задачу в следующий stage DAG'ом.
- Переходы пишут append-only событие `team-mode/stage {taskId, fromStage, toStage, actor}` в Host-журнал team-core (источник истины для восстановления после crash; Session projection `teamMode` даёт live view клиенту).
- `accept.gate: human`: stage Done достижим только инструментом Manager'а + подтверждённым ответом человека из team_ask_user (Host хранит pending-approval по задаче).

### 5.5 Kanban-синхронизация (опциональная строка бандла)

Односторонняя проекция: team-task → kanban-карточка (title, note=brief, assignee=role, parent по DAG; статусы Todo/In Progress/Review/Done по stage). Manager получает `kanban_*` как человекочитаемое зеркало. Двусторонняя синхронизация из Kanban UI в v1 — нет (только чтение доски человеком; изменение карточки человеком → уведомление Manager'у об «insanity check» раз в день не делаем). Если dsh-kanban не установлен — строка бандла просто отсутствует, режим работает без него.

### 5.6 Client-панель команды (свой UI)

Slot: кнопка в conversation header Team Mode чата (паттерн `ui-agent-team`) + отдельная страница настроек плагина в Settings («Team Roles»): список ролей с редактором agent.md/frontmatter.
Панель состава: карточки **постоянных профилей workspace** (роль, статус running/inactive/failed, текущая задача+stage, последняя активность) — состав команды не меняется при смене Manager-диалога (§3.2); клик = переход в сессию профиля (addressed-subagent navigation уже поддержан), кнопка interrupt на карточке, кнопка «direct message» (открывает сессию роли; работает и без открытого Team Mode чата). Live-статус из `useSessionStatus` + собственной projection `teamMode` (источник истины — Host-реестр; нативная `agentTeam`-проекция — вспомогательная, если agent-team остаётся в композиции).
Требования theme/locale/icon по стандарту хост-плагина (host-plugin.md checklist).

### 5.7 Настройки плагина (Config JSON Schema)

```yaml
rolesDir: ~/.dsh/team-mode/roles        # user catalog (fallback встроенный)
eagerProfiles: false
maxConcurrentWorkers: 3
workflowFile: <profile config>           # stages/escalation/limits/rework
kanbanSync: true|false
mnemosynePolicies: true                  # добавляет role-skill требования памяти
managerPresetId: manager
```

Все поля — Volatile где возможно (change без remount). UI-редактор ролей пишет в rolesDir Host-endpoint'ом с атомарной записью (`dsh-atomic-write`).

### 5.8 Прямой вопрос человеку от работяги

v1: строго через Manager (эскалация QUESTION → Manager → team_ask_user). Прямые `ask_user_question` у не-Manager'ов запрещены toolFilter'ом preset'а роли — чтобы не плодить конкурирующие каналы и не терять контроль workflow. (В v2 — опция config `directUserQuestions: true` с маршрутизацией вопроса в чат Manager'а как «notification от имени роли».)

### 5.9 Память (Mnemosyne)

Режим не владеет памятью, но задаёт политики: role-skill'ы и persona suffix обязывают recall перед задачей и remember(scope global) после решения/отказа; Manager обязан вести «договоры» через shared_remember. Интеграция — текстовая (skills/persona), не кодовая: работает с любым MCP-подключением mnemosyne из профиля; если mnemosyne нет — политики деградируют до нативной памяти DSH без ошибки.

---

## 6. Совместимость с текущей конвенцией (AGENTS.md, role-* скиллы)

- Существующие presets `manager/developer/tester/reviewer/designer` в профиле web принимаются как дефолтный каталог ролей (role catalog loader умеет читать и «уже объявленные presets»: role file ссылается на существующий preset id вместо генерации).
- Скиллы `role-*` остаются source-of-truth правил; persona роли указывает их (как сейчас). Репозиторий режима содержит обновлённые версии скиллов: workflow-протокол (структурированные Итог/BLOCKED/QUESTION), запрет прямых вопросов человеку, работа с team_task вместо чистого kanban.
- AGENTS.md воркспейса продолжает загружаться у всех агентов (agent-instructions row в каждом preset) — правила команды человека поверх ролевых.

---

## 7. Риски и сложности (честно)

| # | Риск | Оценка | Митигация |
|---|---|---|---|
| R1 | **Re-adopt постоянного профиля под нового Lead'а** — нативный agent-team не поддерживает присоединение существующей сессии к новому TeamId; поведение residency при закрытии Lead'а документировано двусмысленно | **высокий, spine проекта** | spike M3 в первую очередь: (a) `AgentRegistry.resume` c parentAgent нового Manager'а; (b) план Б — собственная inbox-доставка Team-core без нативного roster; (c) крайний случай — полный отказ от agent-team в пользу собственного board+mailbox (уже заложен как Host-board §3.2). Решение spike'а фиксируется в README |
| R2 | **Experimental API mutable** (roster/task/mailbox контракты «can change freely») | средний (после решения R1 ниже) | режим минимально зависит от agent-team (только runtime-механика диалога); версионный замок 0.2.x; CI-matrix на rc-апдейты |
| R3 | **Нет нативного «mode API»**: переключатель режима — UI-паттерн + session meta flag, не first-class сущность | средний | воспроизвести паттерн plan-mode (waterfall prompt section + client mode control); зафиксировать контракт в README; при появлении официального mode API — миграция строкой бандла |
| R4 | **Общий workspace, параллельные правки** (write scopes advisory, bash вне version guard) | средний | workflow stage-machine по сути сериализует «build» одной ролью за итерацию; rework-циклы; Manager не раздаёт пересекающиеся build-задачи одновременно (Host предупреждает); документировать |
| R5 | **Медленная локальная модель + RAM 1.2GiB**: одновременные turns нескольких ролей убивают отзывчивость | высокий для этой среды | maxConcurrentWorkers очередь; дефолт 3; мониторинг SessionActivityKindMap.subagent; рекомендация в README |
| R6 | **Persona drift после правки agent.md** у живых сессий | низкий | personaHash + предупреждение Manager'у + «re-persona at next resume» / пересоздание профиля по согласованию |
| R7 | **Двойной учёт задач** (Host-board vs kanban) | низкий | односторонняя проекция task→kanban; kanban = read-mostly зеркало для человека |
| R8 | **Экспериментальный subagent UI**: addressed-subagent навигация стабильна, но panel-UX субагентов может меняться | низкий | опираться только на публичный control API (SubagentPromptRequest/InterruptReceipt) |
| R9 | **Whole-view broadcasts** agent-team (полный roster/tasks каждому браузеру) | низкий | своя компактная projection `teamMode` — основной UI-канал; native panel не используется как источник истины |
| R10 | **Компакция контекста долгих сессий профилей** потеряет решения | средний | обязательные правила «перед compact — в память» (скиллы), tool-result-pruner в presets, native compaction rows в каждом preset роли |

Открытые вопросы платформы (закрыть spike'ами M1/M3):
- Канонический способ зарезервировать SessionId профиля (генерация id реестром vs API dsh-session) — проверить на testkit.
- Можно ли монтировать preset из Host-плагина динамически без рестарта профиля (`mountPreset` доступность из team-core context) — да по `dsh-agent-preset-registry/mount.d.ts`, но аудит leakedServices обязателен.
- **R1-spike**: живой профиль под закрытым Lead'ом — residency vs drain; как именно Team-core маршрутизирует inbox-сообщения роли при неактивном Manager'е (прямой путь обязан работать: пользователь пишет роль без открытого Manager-чата).

---

## 8. Критерии приёмки (Acceptance Criteria)

### A. Профили и роли
1. Первый Team Mode диалог в workspace создаёт Manager-сессию и регистрирует её как активного Manager'а; повторный Team Mode диалог создаёт нового Manager'а, **но реестр профилей и Host-board остаются прежними** (старый Manager-чат доступен в истории).
2. Делегирование роли, у которой ещё нет профиля в workspace, создаёт профиль (одна сессия); повторные делегирования той же роли идут в **ту же** сессию — **в том числе после смены Manager-диалога и после рестарта Host'а** (проверяется по sessionId; re-adopt §3.2). Профиль недоступен как «одноразовый»: его история непрерывна между диалогами.
3. Рестарт Host-процесса: профили восстанавливаются; история каждой роли полная; cold resume работает без потери persona/tools.
4. Правка `roles/<role>.md` меняет состав следующего созданного профиля (persona+tools); существующий профиль помечен personaHash-mismatch и предупреждает Manager'а.
5. UI-редактор ролей (Settings → Team Roles) создаёт новую роль без рестарта процесса; новая роль появляется у Manager'а в `team_profiles` как делегируемая.

### B. Workflow
6. Цепочка spec→build→verify→review проходит автономно: Manager декомпозирует, раздаёт по stage, каждая передача содержит brief и acceptance criteria (проверка структуры tool-аргументов).
7. Попытка роли claim'нуть задачу чужого stage отклоняется гейтом с объясняющей ошибкой.
8. Reviewer reject → задача возвращается в build с комментариями ревьюера; счётчик итераций виден в `team_status`.
9. Stage Done не достигается без подтверждения человека через team_ask_user (проверяется негативным тестом: Manager tool-call без approval → отказ).
10. Crash Host'а посреди workflow → после рестарта stage-machine восстановлена из событий, ни одна задача не потеряла stage/owner; задачи roles с прерванным ходом автоматически reopened и Manager уведомлён.

### C. Прямое взаимодействие
11. Из панели команды пользователь открывает сессию Developer и пишет вопрос **во время** его рабочего шага (delivery steer) — сообщение принято в ближайшем step boundary, текущий шаг корректно прерван; статус задачи не изменился.
12. delivery queue: сообщение доставляется после текущего хода без прерывания.
13. Прямое указание человека агенту → агент отвечает в своей сессии и шлёт Manager'у QUESTION/UPDATE-репорт (проверяется по inbox Manager'а).
14. Пользователь прерывает ход роли кнопкой панели; inbox-сообщения роли сохранены; ownership задачи не сброшен автоматически (кроме правила 10 для не-completed stopReason).

### D. Ограничения среды
15. При maxConcurrentWorkers=3 четвёртое делегирование становится pending и Manager получает явную подсказку о очереди; live-оборотов ≤3 (проверка SessionActivityKindMap).
16. Работяга не может вызвать spawn teammates / plugin_manager / ask_user_question (toolFilter негативные тесты).

### E. Поставка
17. `plugin_manager install_bundle` с абсолютным путём к бандлу клонированного репозитория (по инструкции INSTALL.md) ставит режим в чистый профиль web-типа одной командой; после установки доступны: Team Mode переключатель, панель команды, presets ролей, role editor.
18. Опциональные строки (kanbanSync, mnemosyne) отключаемы конфигом без поломки ядра.
19. `pnpm test` в репозитории зелёный; интеграционные тесты на dsh-agent-loop-testkit (см. §9).

---

## 9. Стратегия тестирования

- **Unit**: role catalog loader (frontmatter-валидация, fallback), stage-machine reducer (чистые функции переходов), реестр профилей (CAS/atomic write, crash-safety — kill -9 mid-write recovery).
- **Integration (dsh-agent-loop-testkit)**: fake LLM scripted tool-calls → полный сценарий A6–A9; негативные гейты A7/A9/A16; resume-сценарии A3/A10 (persist→restart→resume через session-persistence-jsonl).
- **Contract**: smoke против реальных rc-версий agent-team при каждом bump зависимости.
- **E2E (manual, Web)**: чек-лист A1–A5, A11–A15 в браузере GUI; сценарий «медленная модель» с maxConcurrentWorkers=2 на VM среды.
- **Load**: 4 роли × 3 задачи на локальной модели — фиксация времени очереди и RAM (<1.2GiB).

## 10. Декомпозиция для разработки (маппинг в kanban)

M1 Skeleton bundle (patch + core storage + Manager registry) **+ R1 spike: re-adopt постоянного профиля под нового Lead'а и residency при закрытом Lead'е** → M2 Role catalog+presets (+editor API) → M3 Profiles lifecycle (reserved childId, lazy spawn, re-adopt/resume, reconciler, Host-board) → M4 team-tools (delegate/status/interrupt/ask_user) + workflow engine + гейты → M5 Client panel + mode switch → M6 Kanban projection + Mnemosyne skills → M7 Test harness + docs + INSTALL.md/установочный скилл. Отложенная веха M8: npm-публикация (после появления аккаунта). Каждая веха — отдельная kanban-карточка с parent=Milestone и acceptance-подпунктами выше.

## 11. Решения и открытые вопросы

Принятые решения заказчика:
1. **Постоянная команда на workspace — обязательное требование v1**: реестр профилей + Host-board живут в workspace-хранилище и переживают смену Manager-диалога и рестарт Host'а (§3.2). Нативный agent-team — только runtime-механика внутри диалога, не источник истины о команде.
2. Профили **lazy**: роль заводится при первом реальном делегировании. (Eager оставлен как настройка `eagerProfiles`; стоимость eager — 5–6 коротких прогонов модели при старте диалога и boot-time reconciler по всем профилям, фоновых расходов у простаивающей сессии нет.)
3. Публикация в npm: **отложена — аккаунта нет.** v1 ставится из git-репозитория через `install_bundle` (локальный реестр/file-спеки, §3.1). Имена пакетов зафиксированы; публикация — отдельная задача после появления аккаунта.
4. Manager: новый Team Mode диалог = новый Manager-агент, **команда та же** (следствие решения 1).

Открытый вопрос (закрыть spike'ом M1):
5. Канал прямого вопроса человеку от роли в v1: строго через Manager (рекомендую, §5.8) — подтверждение не требуется до M4.
