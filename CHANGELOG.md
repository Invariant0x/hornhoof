# Changelog

Newest releases come first. Each release starts with `## [X.N.P] - YYYY-MM-DD`,
one plain summary, and short entries under `### Added`, `### Changed` and
`### Fixed`. Include `### Before you update` only when people need to take action.
The middle number is the turn; the last counts releases between turns.

## [0.18.0] - 2026-11-10

Turn 18 and what it showed. A turn now runs in one of two modes: through the echelons, which only go forward, or turnkey,
given to one member of a turnkey team who does it alone; work outside a turn goes through no echelons. Test runs take
less time: tests wait on a clock the test moves, a run is laid out by how long its files take, and a test machine is
shared fairly. A machine shares its processors between the agents' programs and starts no new one while its memory is
short. A program keeps Hornhoof's tools when it connects between turns, and Antigravity's survey no longer takes a turn's words.

### Before you update

- Migration 0092 adds `teams.turnkey`, false for every team, and migration 0093 adds `turns.mode`, `echelons` for every
  turn there is. Migration 0094 adds `companies.task_numbers_used` and `companies.turn_numbers_used`, filled with the
  highest task and turn number each company has. Nothing else is converted.
- `plan_turn` now needs a mode. The orchestrator's instructions in this version name one; an orchestrator still on older
  instructions is refused until it does.
- Open tasks keep the route they have. Only tasks made after the update follow the new rules.
- Update the nodes as well. The fix for tools lost between turns, the survey setting for Antigravity and the share of a
  machine are in the node: a node of 0.17.2 keeps working, but can still lose its tools after a short turn and is not
  held back when memory is short.

### Added

- A turn has a mode, echelons or turnkey, chosen when it is planned (`plan_turn`, `edit_turn`, and a choice on the tasks
  screen and beside the button that puts work into the next turn). The mode can change only while the turn is planned.
  Turns of different modes are not merged.
- A team can be marked as working turnkey on the department's screen. Its members do a task alone from start to finish,
  call nobody of the department onto it and close it with their report. A turnkey turn needs such a team, and its tasks
  go only to its members.
- Each agent program gets its share of the machine's processors and memory as `VITEST_MAX_WORKERS`, unless the machine
  sets one itself. A turn that would start a new program waits while the machine has less than 2 GiB free and goes out
  by itself once memory is free; the agent's window says why, and Operations sees that such an agent is waiting, not
  stuck. Nothing that already runs is stopped.
- The orchestrator, the head of Operations and the program operator see the program of any employee and act on it,
  with only the values of secrets masked. A recovery hold is lifted with `program_recovery_release`, its case and a
  reason.
- A test run's report says which profile passed and which suites and files it left out, and the line of proof in a
  request for approval prefers a run that ran everything again. The release check is a `full` run.
- The testing policy sets a time budget: 1 second a test, 30 seconds a file and 5 minutes for a whole run of the fast
  profile. The pipeline report names what is over it.
- The style book 1.2 and the theme sheet 1.0, with scripts that check them.

### Changed

- The echelons only go forward: each one fixes what it finds itself, and only work built wrong goes to the head. A
  candidate whose own change passed but needs a fix from the main line stays at Tests, whose owner merges the main line
  into it and checks it again.
- Work outside a turn goes through no echelons: its holder does it alone from start to finish.
- Task and turn numbers go on after the highest ones a company gave, even when old tasks and turns are removed by hand,
  so a branch `task-N` or a version `0.N.0` never names two pieces of work.
- The tests of the node, the server and the web wait on a clock the test moves instead of real pauses, and no test
  downloads or starts a browser to check a node's start.
- A run is laid out by the times its files took before, the suites of one part run as one command, the batches of a
  run start beside its preparation, and Vitest gets the processors and memory a test machine has free. The longest test
  files are split so they run side by side.
- The author check runs the tests that read a changed document by its path, and a browser scenario follows every screen
  of the app it drives.
- On GitHub, where no full run follows, a commit runs every test its change reaches, or the whole suite.
- Codex is told that the words of its head, the orchestrator and a person of the company are instructions, and that what
  they quote is data.
- The engineering rules open with what matters most: no push or merge to the main line unless the task names it, a
  report of result and evidence, quality tools only when assigned, and three failed fixes before the premise is
  questioned.

### Fixed

- A program that connected to Hornhoof's tools after a short turn, or between turns, was turned away and lost its tools
  for the rest of its session. The node now answers that connection from what Hornhoof said before, and refuses only a
  tool call outside a turn.
- Antigravity starts with its feedback survey off, so the survey no longer takes the words of a turn.
- Hornhoof's own words left in a program's input are delivered or erased, a Claude Code whose start a busy node refused
  is typed into, recovery does not repeat itself, and a program without tools is not reminded.
- An answer to a colleague's message reaches the one who asked.
- The browser tests of the main line pass again after 0.17.2, and a task can be opened from the table while an agent
  window is open.
- A task's state stays on one line in the task table.
- Node secrets stay out of input intents and audit results.
- The release steps say that the workflow makes the tag itself: a tag made by hand makes the push skip the version.

## [0.17.2] - 2026-11-09

Fix what stalled turn 17 and the release of 0.17.0, so that a turn goes through its stages without waiting for people:
test results are reused, the author check takes minutes, a task can be paused, notices and waits stop repeating, a
message reaches every employee, and nodes check pages in Chromium, Firefox and WebKit.
Let an employee hand in work that adds a database migration: GitHub shows no patch of a migration's large snapshot, and
0.17.0 refused every such handoff. The department schema stands its roles by gates again, and the release tests check
only Hornhoof's own side.

### Before you update

- Migration 0089 adds the empty column `tasks.paused`. Every task starts not paused; nothing is converted.
- `create_task` now asks a code task for the paths its change may touch, and for the product when only the product keeps
  the repository. An open code task made on 0.17.0 without paths keeps its route; its head sets the paths before the
  task moves on, as `docs/development-echelons-release-data.md` describes.
- The node image now brings Firefox and WebKit beside Chromium, so it is larger.
- 0.17.0 kept green test results whatever runtimes a part ran on. After the update, clear the results kept before it
  once, as `docs/development-echelons-release-data.md` describes, so the next full run checks those files again.
- Migration 0091 adds the empty table `backlog_items` for each department's work kept for later turns; nothing is converted.

### Added

- A head, the orchestrator or a person with the CEO's rights can pause a task: nothing wakes its holder until someone
  resumes it (`pause_task`, `resume_task` and a button in the task panel).
- `submit` takes a named branch or commit, and refuses a submission without a commit it can read.
- `run_tests` refuses a command that names a test file its pinned commit does not have, before any part goes out.
- `npm run -s deps` puts the dependencies and builds in place in a new worktree, linking the packages its clone installed
  from the same lockfile.
- Nodes prepare Chromium, Firefox and WebKit and check that each one starts, naming the one that does not.
- `test_run` shows how many fingerprints a run brought and how many green results it kept.
- The tasks screen shows one department at a time as a table by turn, and its list of work kept for later turns, which
  its people add to, order by dragging and put into a turn (`backlog` for the orchestrator). A person sees only the tasks
  and lists of their own departments.

### Changed

- The author check runs the tests near a change with coverage, lists the rest of the import graph as left to the full
  run, and checks the types of only the projects the change reaches. On the same change it took 75 seconds instead of
  about 14.5 minutes.
- Gemini 4 Argon and Kimi K3.1 Pro check and hand in work in the strong band.
- Images build by themselves when a new version reaches main, one run of a branch at a time, so a release needs nobody
  to start them.
- An employee hears once about the waits of one holder on them until the work moves, and nobody hears of a wait on
  themselves.
- A blocked task opens again only on its giver's first comment after the block, and blocking a blocked task is refused.
- Program evidence receipts stay out of the employee feed.
- A message for an Antigravity employee at work goes with its next turn, as Antigravity takes typed words as a turn of
  its own.
- A new Tests owner is woken with its open work, an answered task goes back to the status of its stage, a head is never
  picked as checker by itself, and an independent part takes its parent's paths.
- A worker cannot close a coordination task without accepted subtasks in a department that keeps code.
- A person who sees a task sees the true number of findings at each stage; their details stay with those who see the
  whole task.
- The templates and the guide keep connected work with one owner, drop the release check on live programs, and ask for
  reports in plain words with spaces.
- Release tests check Hornhoof's own side only: what it starts, what it types and what it makes of a program's recorded
  output. They no longer run tmux, the agents' programs, npm or the operating system's refusals, depend on the machine's
  speed, or take random ports: every test port comes from a narrow range of its own. Skills and role templates name this
  principle first.

### Fixed

- A test part is accepted from any machine of the class of runtimes that described its run: the same system, libc and
  major versions, whatever the build or processor, so parts that ran on an arm64 Mac count for a run described on x64
  and are no longer refused by Tests. A part goes only to a machine of that class. A run whose describing node lacks a
  runtime its profile needs ends at once and names the runtime.
- The fingerprints of test files name the class of runtimes, not the build of one machine, and a part keeps its green
  results wherever it ran in that class, so a later run on any machine of the class skips unchanged files.
- A product run is laid out by the pace of each free machine, taken from how long the last parts of the repository ran,
  so its parts end at about the same time, and each part goes to the machine it was laid out for while that machine can
  take it.
- The log of a failed test part ends with the name and error of each test that failed, not with what a service said as
  it stopped.
- Quality tools in a test part read the grammars the machine keeps, and a crapper failure says why.
- A preparation step that hears nothing from Hornhoof for a minute stops, a part waits at most ten minutes for another
  machine's build and then builds it itself, and the part's log says each step.
- The local command rule finds a project's workspaces and named packages, names a missing script, and allows named parts
  of Go, Cargo, .NET, Maven and Gradle suites.
- The check command tests pass when the tests run as root, as in a clean `node:22` container.
- A turn is not reported stalled before its program gives its first sign.
- Tests that read the screen once now wait for the state they need.
- Antigravity's own words on its screen no longer look like a question for the subscription owner.
- The tree and speed views of a department with long turns answer at once.
- A checker's result is refused when its model, plan or ability changed before the result was stored.
- A cancelled task's route shows as cancelled, every stage reason is named, and an owner's raw id is never shown.
- A node describes a candidate for Tests again: the node image now ships TypeScript, which choosing the changed functions to
  mutate needs, so such a run no longer ends with `commit_unavailable` before any part goes out.
- A handoff no longer takes the comparison with its base for unknown when GitHub lists a file but shows no patch of it,
  as it does for a large file such as a migration's snapshot. The file's path stays in the candidate and is checked
  against the task's paths as before, the diff names the file with its added and removed lines, and the count of changed
  lines includes them. A patch GitHub cut short, or a comparison of 300 files or more, is still refused.
- A node describes a candidate for Tests again: the node image now ships TypeScript, which choosing the changed functions to
  mutate needs, so such a run no longer ends with `commit_unavailable` before any part goes out.
- On a busy machine a turn no longer ends with "The program did not take Hornhoof's prompt" when the program took it
  during the node's last look: the node looks once more after its time is up, and so does its wait for a program's screen.
- The department schema stands its roles left to right by gates again, as before 0.17.0: architecture, development, then
  each check in order, with "Gate 1", "Gate 2" between them. An employee always stays in its role's frame, and whoever
  leads a stage now is marked there; only teams such as Matrix and observers stand apart.

### Russian

Исправлено то, что останавливало ход 17 и выпуск 0.17.0, чтобы ход проходил свои этапы без ожидания людей: результаты
тестов используются повторно, проверка автора идет минуты, задачу можно поставить на паузу, уведомления и ожидания не
повторяются, сообщение доходит до каждого сотрудника, а ноды проверяют страницы в Chromium, Firefox и WebKit.
Сотрудник снова может сдать работу с новой миграцией базы: GitHub не показывает patch большого снимка миграции, и 0.17.0
отказывала в каждой такой сдаче. Схема отдела снова ставит роли по рубежам, а тесты выпуска проверяют только сторону
Hornhoof.

- Перед обновлением: миграция 0089 добавляет пустой столбец `tasks.paused`, все задачи начинают без паузы, ничего не
  переводится. `create_task` теперь требует у задачи кода пути, которые может менять правка, и продукт, когда репозиторий
  есть только у продукта. Открытая задача кода с 0.17.0 без путей сохраняет маршрут; глава задает пути до следующего
  этапа, как описано в `docs/development-echelons-release-data.md`. Образ ноды теперь содержит Firefox и WebKit рядом с
  Chromium и поэтому больше. 0.17.0 сохраняла зеленые результаты тестов, на каких бы средах ни шла часть: после
  обновления один раз удалите результаты, сохраненные до него, как описано в том же документе, и следующий полный прогон
  проверит эти файлы заново.
- Глава, оркестратор или человек с правами CEO ставит задачу на паузу: никто не будит ее исполнителя, пока паузу не
  снимут (`pause_task`, `resume_task` и кнопка в панели задачи).
- `submit` принимает названную ветку или коммит и отказывает сдаче без читаемого коммита.
- `run_tests` отказывает команде, которая называет тестовый файл, которого нет в закрепленном коммите, до раздачи частей.
- `npm run -s deps` ставит зависимости и сборки в новой рабочей папке, связывая пакеты, которые клон поставил по тому же
  lockfile.
- Ноды готовят Chromium, Firefox и WebKit и проверяют, что каждый запускается, и называют тот, который не запустился.
- `test_run` показывает, сколько отпечатков пришло в прогон и сколько зеленых результатов сохранено.
- Проверка автора запускает тесты рядом с правкой с покрытием, остальной граф импортов перечисляет как оставленный
  полному прогону и проверяет типы только затронутых проектов: на одной и той же правке 75 секунд вместо примерно 14,5
  минуты.
- Gemini 4 Argon и Kimi K3.1 Pro сдают и проверяют работу в сильной полосе.
- Образы собираются сами, когда новая версия попадает в main, по одному запуску на ветку, и выпуск не ждет человека.
- Сотрудник слышит об ожиданиях одного исполнителя на нем один раз, пока работа не сдвинется; об ожидании на самом себе
  никто не слышит.
- Заблокированная задача открывается снова только первым комментарием того, кому ушла блокировка; повторная блокировка
  отказывается.
- Квитанции о свидетельствах программы не попадают в ленту сотрудника.
- Сообщение сотруднику в Antigravity во время работы уходит с его следующим ходом, потому что Antigravity принимает
  набранные слова отдельным ходом.
- Новый владелец Тестов будится со своей открытой работой, задача после ответа возвращается в статус своего этапа, глава
  не выбирается проверяющим сам, а независимая часть берет пути родителя.
- Исполнитель не закрывает координационную задачу без принятых подзадач в отделе, который хранит код.
- Тот, кто видит задачу, видит настоящее число находок на каждом этапе; подробности видят только те, кто видит задачу
  целиком.
- Шаблоны и руководство держат связанную работу у одного владельца, убирают проверку живыми программами при выпуске и
  просят отчеты обычными словами с пробелами.
- Исправлено: часть сохраняет зеленые результаты везде, где шла на средах того же класса, что описали прогон; quality
  tools читают грамматики машины, а отказ crapper называет причину; шаг подготовки, который минуту ничего не слышит от
  Hornhoof, останавливается, часть ждет чужую сборку не больше десяти минут и потом собирает сама, а журнал части
  называет каждый шаг; локальное правило команд находит рабочие пространства и пакеты по имени, называет отсутствующий
  скрипт и пропускает части наборов Go, Cargo, .NET, Maven и Gradle; тесты check-command проходят под root в чистом
  `node:22`; ход не объявляется застрявшим до первого знака программы; тесты ждут нужного состояния вместо одного чтения
  экрана; собственные слова Antigravity на экране больше не выглядят вопросом владельцу подписки; дерево и скорость
  отдела с длинными ходами отвечают сразу; итог проверяющего отказывает, если его модель, подписка или навык сменились до
  записи; маршрут отмененной задачи показывается отмененным, каждая причина этапа названа, а сырой id владельца не
  показывается.
- Исправлено: Тесты принимают часть с любой машины того класса сред, что описали прогон: та же система, libc и
  основные версии, какими бы ни были сборка и процессор, поэтому части с Mac на arm64 засчитываются прогону, описанному
  на x64. Часть уходит только машине этого класса. Прогон, у описавшей ноды которого нет среды, нужной профилю,
  кончается сразу и называет эту среду. Отпечатки файлов тестов называют класс сред, а не сборку одной машины, и
  следующий прогон на любой машине класса пропускает неизмененные файлы.
- Прогон продукта раскладывается по скорости каждой свободной машины, взятой из того, сколько шли последние части
  репозитория, поэтому его части кончаются примерно вместе, и каждая часть уходит той машине, для которой разложена,
  пока та может ее взять.
- Журнал упавшей части кончается именем и ошибкой каждого упавшего теста, а не тем, что сказал сервис при остановке.
- Исправлено: нода снова описывает кандидата для Тестов: образ ноды теперь несет TypeScript, без которого нельзя выбрать измененные
  функции для мутаций, и такой прогон больше не кончается `commit_unavailable` до раздачи частей.
- Тесты выпуска проверяют только сторону Hornhoof: что он запускает, что вводит и как разбирает записанный вывод
  программы. Они больше не запускают tmux, программы агентов, npm и отказы операционной системы, не зависят от скорости
  машины и не берут случайные порты: каждый тестовый порт берется из своего узкого коридора. Навыки и шаблоны ролей
  называют этот принцип первым.
- Сдача больше не считает сравнение с базой неизвестным, когда GitHub перечисляет файл, но не показывает его patch, как
  бывает с большим файлом вроде снимка миграции. Путь файла остается в кандидате и проверяется по путям задачи, как
  раньше, diff называет файл с числом добавленных и удаленных строк, а число измененных строк их учитывает. Patch, который
  GitHub урезал, и сравнение из 300 файлов и больше по-прежнему отказ.
- Нода снова описывает кандидата для Тестов: образ ноды теперь несет TypeScript, без которого нельзя выбрать измененные
  функции для мутаций, и такой прогон больше не кончается `commit_unavailable` до раздачи частей.
- На загруженной машине ход больше не кончается сообщением "The program did not take Hornhoof's prompt", когда программа
  взяла задание во время последней проверки ноды: нода смотрит еще раз, когда время вышло, и так же ждет нужный экран
  программы.
- Схема отдела снова ставит роли слева направо по рубежам, как до 0.17.0: архитектура, разработка, затем каждая проверка
  по порядку, с пометками «Рубеж 1», «Рубеж 2» между ними. Сотрудник всегда в рамке своей роли, а кто сейчас ведет этап,
  выделен там же; отдельно стоят только подотряды вроде Matrix и наблюдатели.
- Экран задач показывает один отдел: таблицу задач по ходам и список работы на будущие ходы. Люди отдела пополняют
  список, меняют порядок перетаскиванием и ставят пункты в ход (у оркестратора инструмент `backlog`). Человек видит
  задачи и списки только своих отделов.
- Миграция 0091 добавляет пустую таблицу `backlog_items` для работы отдела на будущие ходы; ничего не переносится.

## [0.17.0] - 2026-11-09

Give every executable task of Development one required route with one current owner at each stage, let the checkers
repair what they find in the same branch, and close coordination work with a checked report instead of an invented
commit.

### Before you update

- This version replaces the numbered gates of a task with its route. Migrations 0087 and 0088 add the empty route table
  and drop the old gate, panel, stage, merging and bounces columns of tasks. They convert no existing task.
- Before the update, stop new work on the old server, settle running turns and keep a backup of the database. Record
  what the dropped columns hold for each task, then give every existing task its route by hand, as
  `docs/development-echelons-release-data.md` describes. An open task with no decided route stays held.
- Once the columns are dropped and work has moved through the new route, the old server can no longer read the
  database. Going back means the backup with its matching old server.

### Added

- Each executable task follows one route: Architecture when the task is large, Development, Review, Cleanup only when
  the head turns it on, Security when the head requires it or Review finds the risk, and Tests on the final candidate.
  Each stage has one current owner, and task tools and the work tree show the route and its owner.
- A checker is another employee whose model is at least as capable as the producer's. Another provider is preferred
  when one is free; the same provider, plan or tariff is allowed.
- A task without a repository and with no result kind named finishes with a checked report of its accepted parts, with
  no Git candidate made up for it.

### Changed

- Review and Security repair their own findings in the same branch. An ordinary finding no longer goes back to the
  author; work that pursues the wrong goal goes to the head.
- Tests checks the exact final candidate with every repair in it, reuses only results whose fingerprint matches, and
  mutates only changed pure functions that have fast tests.
- The department skills and guides describe the single route. A change to access, root, permissions or secrets still
  passes an independent Security engineer before it reaches any shared branch.

### Russian

У каждой исполняемой задачи Разработки теперь один обязательный маршрут с одним текущим владельцем на каждом этапе.
Проверяющие сами исправляют найденное в той же ветке, а координационная работа закрывается проверенным отчетом без
выдуманного коммита.

- Исполняемая задача проходит один маршрут: Архитектура для большой задачи, Разработка, Ревью, Очистка только по решению
  главы, Безопасность, когда ее требует глава или риск находит Ревью, и Тесты на итоговом кандидате. У каждого этапа один
  текущий владелец; инструменты задач и дерево работы показывают маршрут и владельца.
- Проверяет другой сотрудник с моделью не слабее, чем у автора. Другой провайдер предпочтителен, когда он свободен; тот же
  провайдер, подписка или тариф допустимы.
- Задача без репозитория и без явно названного вида результата завершается проверенным отчетом о принятых частях, без
  придуманного Git-кандидата.
- Ревью и Безопасность исправляют свои находки в той же ветке. Обычная находка больше не возвращается автору; работа
  с неверной целью идет к главе.
- Тесты проверяют точный итоговый кандидат со всеми исправлениями, повторно используют только результаты с совпадающим
  отпечатком и мутируют только измененные чистые функции с быстрыми тестами.
- Навыки отдела и руководства описывают единый маршрут. Правка доступа, root, прав или секретов по-прежнему проходит
  независимого инженера безопасности до любой общей ветки.

Перед обновлением: версия заменяет нумерованные ворота задачи ее маршрутом. Миграции 0087 и 0088 добавляют пустую таблицу
маршрутов и удаляют старые столбцы задач gates, panel, stage, merging и bounces; существующие задачи они не переводят.
Перед обновлением остановите выдачу новой работы на старом сервере, завершите идущие ходы и сохраните резервную копию базы.
Запишите, что хранят удаляемые столбцы для каждой задачи, затем вручную задайте маршрут каждой существующей задаче, как
описано в `docs/development-echelons-release-data.md`. Открытая задача без решенного маршрута остается на удержании.
После удаления столбцов и работы по новому маршруту старый сервер больше не читает базу; откат возможен только
к резервной копии вместе с ее старым сервером.

## [0.8.4] - 2026-11-08

Let the nodes on every computer follow the server to a new build by themselves, release a version without turns of the
programs on real nodes, let GitHub test each commit once and only where its change reaches, and tell an employee once that
someone waits for them.

### Before you update

- A server on 0.8.0 to 0.8.3 does not offer this version, as it waits for a check on real programs that no longer comes.
  Run the install line once on the server's computer to update it.
- On every computer other than the server's own, run the install line once more after the update. It starts the updater
  of that computer's nodes; from then on they follow the server by themselves.

### Added

- Nodes on every computer move to the server's build by themselves, each once its work ends: the install line starts a
  small updater next to them. It reads what the server serves only as data and runs only Hornhoof's own images, each by
  its digest.

### Changed

- A release no longer needs turns of Claude, Codex, Kimi and Antigravity on real nodes. Once the tests passed on main, the
  images built for that commit go out, every published build is offered and installed, and the nodes follow it. The live
  check, its proof, the live check stand, `install.sh check-node` and `install.sh back-node` are gone.
- GitHub tests each commit once, and runs only the tests its change reaches since the last commit whose tests passed. A
  change that reaches everything, such as one of the lockfile, still runs every test.
- A release no longer runs every test on GitHub because it moves the version in the package files and the lockfile:
  where only our own versions moved, the file counts as unchanged. Any other change of them still runs every test.
- A release builds its images faster. A new version alone no longer installs the dependencies or downloads the browser
  of an image again, and each image keeps its build cache next to it on GitHub, so a builder that dropped its own, or a
  new one, does not build the heavy parts again. GitHub's own cache, which took longer to fill than the build, is no
  longer used.

### Fixed

- An employee hears once that someone waits for them on a task. The one who waits can say its wait again with new words
  or a new date while it stands, or within ten minutes after the employee answered on the task, and that tells the
  employee nothing new. A wait on someone else, one after an older answer, or one after the last ran out or its holder
  ended it still tells them.
- An employee can no longer wait for itself by writing its own id in capitals, and is never told that it waits for itself.
- A push to main whose version is out already no longer shows as a failed run on GitHub: the publish job sees the
  version's tag and moves nothing.
- Two node tests that failed now and then on a busy GitHub runner pass every time. In the shared harness test the other
  machine now holds its claim while it builds, so the waiting machine cannot take the build in between, and the Kimi Code
  test waits for the input line to come back after the new program redraws it.

## [0.8.3] - 2026-11-08

Make every skill a self-contained ability and every role a short identity, give each employee an assignment of its own,
let whoever builds or reviews a change check it in their own workspace with its dependencies already in place, and stop
nodes from spending a whole processor core on their program observer.

### Added

- Give every employee an assignment on its card, apart from its role. A head sets the assignment of a worker in its own
  department with set_employee_assignment, and a reset keeps it.
- Split the orchestrator's company skill into structure, staffing, people and resources abilities.
- Mark the commit on GitHub when a run of the whole product passes, so the GitHub build can skip tests that already passed.

### Changed

- Skills of all departments stand alone: none names or relies on another, and any set of ticked skills works together.
- Roles are one line about who the employee is; how it works lives in its skills.
- The generalist developer role is gone: an employee with the skills that cover the whole chain does that work.
- Whoever builds or reviews a change checks it in their own workspace right away: dependency installs, the named test
  files of the change, types, lint, builds and quality checks. Only a whole test suite goes through run_tests, which
  splits it into groups over the free machines. A node refuses a whole suite, a task runner that runs everything and a
  watch mode in an agent's terminal.
- The architect designs new features and changes that reshape the architecture; one feature goes to one developer end to
  end. Below version 1.0 nothing old is kept for compatibility, and existing records are corrected at release.
- Removing what a change made unneeded is a skill a head can turn on for reviewers and developers; it is off by default.
- install.sh back-node returns a node to 0.8.1.
- A change of the templates or the skills checks only the tests that read them, not the whole server and node suites.
  A rule of a test environment can now name test files with `tests` beside its suites.
- Submitting a task starts no test run. The author runs the author check in their own workspace before submitting, and
  the `AUTHOR_CHECK` setting and the `review.authorCheckPlan` field of a submit are gone.
- `npm run check:author` checks the change in the workspace where it is called, instead of printing a line for run_tests,
  and builds the protocol and the node again when their files changed since their last build; its `--plan` option is gone.
- An agent's worktree gets its commit's dependencies from the company's shared harness before its program starts: one
  machine builds them for a commit and every other takes them, as for the full test runs. A worktree that already holds
  dependencies stays as it is, a repository without a test environment costs nothing, and a program never waits longer
  than ten minutes for them.

### Fixed

- Firefox and WebKit start on every node: the node image carries the system packages they need, not only Chromium's.
- On a busy machine, words a person sends to Kimi Code while an assignment waits stay theirs: the turn no longer ends with the answer to them, as the node now tells whose a prompt is by its words, not by when it hears of it.
- A node checks all its programs in one step a second. Before, it copied its whole observer state once for each program
  and delivery it remembered, and with a few hundred of them it sat at 100% CPU with nothing running, so tool and hook
  calls through it timed out.
- An agent may run the project's whole types and lint when their scripts build a workspace by its package name or lint
  every workspace: the node finds a workspace by name and judges the script in each workspace it runs in.

### Before you update

- Update the server before its nodes. Startup applies migration 0086: generalist developers and pending hires of that role
  become developers with their saved skills, and holders of the company skill get the new orchestrator abilities.
- Agents start a new session with their next turn, since their instructions change.

## [0.8.1] - 2026-11-07

Prepare a product's test environment once for the machines that share it, reuse unchanged green test files, and load each
agent's instructions from shared skills and the skills of its department.

### Added

- Build and share reusable test environments per product and machine architecture, updating the parts whose inputs changed.
- Keep green results by test-file fingerprint, run changed dependencies again, and report a mismatch found by a periodic
  full run without reuse.
- Offer a generalist developer role that takes a whole task through its own checks and cleanup.

### Changed

- Choose affected test groups by changed paths; a shared protocol change also selects its consumers.
- Load common instructions, leadership rules and department knowledge as separate skills. Existing heads and employees
  receive the speed skill without replacing their role text.
- Give heads one shared rule for fitting small work into a turn before its final check and choosing the check it needs.
- Require independent Security review before access, root, permissions or secrets changes reach a shared branch, including
  urgent and small fixes.

### Fixed

- Give a test job a writable copy of saved service state while keeping the protection against job-owned links.
- Declare access to the test environment's sharing routes and include its tool in agent tool lists.
- Bind shared environment uploads and publication to the current authorized lease and build attempt, and ignore stale replies.
- Hide repository tokens in manual preparation failures and reject unsupported Yarn PnP environments before sharing them.
- Include file modes, test helpers, configuration and tested Markdown files in reuse decisions, and validate fully reused
  runs before review.

### Before you update

- Update the server before its nodes. Startup applies migrations 0081 through 0085 for saved skills, test results and
  shared test environments. Keep a backup from 0.8.0; there is no down-migration command.
- Nodes must support skill files before agents restart with the new instructions. Older nodes cannot start a role whose
  instructions exceed their inline limit. Applying the generalist role to existing employees is a separate action.
- Nodes without the new sharing contract prepare their environments locally. Shared bundles are rebuilt for the new build
  attempts, and the new fingerprint format invalidates previously cached test results.

### Russian

Среда тестирования продукта готовится один раз для машин, которые ее используют. Неизмененные файлы с зеленым результатом
не запускаются повторно, а инструкции сотрудников собираются из общих навыков и знаний отдела.

- Готовая среда передается между машинами одной архитектуры; при изменении ее входных файлов обновляются затронутые части.
- Результат файла тестов хранится с отпечатком зависимостей. Изменение зависимости запускает файл снова, а периодический
  полный прогон без кэша показывает расхождения с сохраненным результатом.
- Добавлена роль разработчика-универсала, который ведет задачу целиком, проверяет ее и убирает лишнее.
- Группы тестов выбираются по измененным путям. Правка общего протокола выбирает также его потребителей.
- Общие инструкции, правила руководителя и знания отдела подключаются отдельными навыками. Действующие главы и сотрудники
  получают навык быстрой работы без замены текста их роли.
- Главы получают общее правило, как включать мелкую работу в ход до итоговой проверки и выбирать нужную ей проверку.
- Правки доступа, root, прав и секретов проходят независимую проверку безопасности до общей ветки, включая срочные
  и малые исправления.
- Копия сохраненного состояния сервиса доступна тестовому заданию на запись с сохранением защиты от подмены ссылками.
- Для маршрутов общей среды явно заданы правила доступа, а ее инструмент включен в списки инструментов сотрудников.
- Загрузка и публикация общей среды привязаны к действующему доступу, сроку аренды и попытке сборки; запоздалые ответы
  не меняют актуальное состояние.
- Токены репозитория скрываются при сбоях ручной подготовки. Неподдерживаемая среда Yarn PnP не передается другим машинам.
- Повторное использование тестов учитывает права файлов, вспомогательный код тестов, настройки и проверяемые Markdown-файлы.
  Полностью сохраненный результат проверяется перед ревью.

Перед обновлением: сначала обновите сервер, затем ноды. При старте применяются миграции 0081–0085. Сохраните резервную копию
0.8.0: команды обратных миграций нет. Перед перезапуском сотрудников ноды должны поддерживать файлы навыков; старые ноды
не запускают роли, чьи инструкции превышают их предел. Применение роли универсала к действующим сотрудникам идет отдельно.
Ноды без нового протокола обмена готовят среду локально. Общие пакеты среды пересобираются для новых попыток сборки,
а новый формат отпечатков сбрасывает ранее сохраненные результаты тестов.

## [0.8.0] - 2026-11-06

Turn 8: agents on Codex and Kimi Code get their assignments again, and a release reaches machines only after a live check of its
exact build on all four programs. Departments get an owner and approval rules, messages to the outside go through one checked
way, a test run checks one pinned commit, and terminals and panels hold their content on every screen.

### Added

- Give each department an owner and approval rules for each channel, and see and change them in its panel.
- Send messages to people outside the company through one checked way: admission, a last look, exact approvals and model checks,
  also for support replies, on the Outbound screen.
- See how any turn went on the third tab of the speed panel: stages, the critical path and waits, by department.
- Every wait says who answers for it and until when, and one past its date goes to its owner and then to their head.
- The people of a machine hear at once when it goes away, with no agent in between.
- Small tasks take a short way through the checks of a turn, are marked as small, and the speed panel shows how fast they close.
- A task that comes after another gives out at once the part of it that does not depend on the other, and task views show it.
- A team that takes only urgent work refuses the rest.
- Send free-form feedback on a choice request.
- Show and change a repository's full test command on its screen.
- A product can describe its tests in a file of its own, with their services and profiles, and a run prepares them in isolation.

### Changed

- Everyone who may write to an agent writes in its terminal, with no second line under it, and control of the program stays with
  the owner of its plan.
- People see only the agents on their own plans in their departments, and only their work.
- A stuck task goes to its head or the orchestrator, never to the CEO. A turn that failed or ran no program no longer counts
  towards being stuck.
- What a person types or a letter that comes at the end of a turn opens its own turn, in the sender's name.
- How hard a turn thinks follows from why it starts.
- Every part of a test run checks one pinned commit, and review, approval and release are tied to it.
- Machines share one queue for heavy checks, so a machine's own load decides when the next one starts.
- Turn reviews are assigned by the changes in a task, to independent vendors, and bound to the exact commit and evidence.
- The task watchdog tells a head when people stand free while work waits.
- A machine says on the Versions screen what each node waits for before an update, and until when.

### Fixed

- Agents on Codex and Kimi Code receive their assignments again: a node reads the real empty prompt of these programs, also
  after a long session has moved everything else off the screen, and keeps out of a draft a person left there.
- Words a program lost are typed again in the same turn, and words on hold go on by themselves once as soon as the program
  stands ready with an empty input.
- A turn cut off by a node restart runs once more in its own session and for whoever asked for it, also outside a task, and
  never twice.
- Your Enter at an agent's terminal sends its saved words on, also for a session that goes on.
- Operations hears of words on hold within five minutes and can release them with a checked tool that logs who did it and why.
- An update is offered and installed only when its exact build passed a live check on Claude, Codex, Kimi Code and
  Antigravity. Without one, a machine stays on the version it runs, and asking for that version says why.
- The installer holds to that check too: joining a machine, moving its nodes, `--urgent` and `install.sh server` stop with the
  reason and change nothing for a build without one. Only a new server of its own, set up to run a live check, runs such a build.
- Codex no longer asks near the limits of a plan whether to switch to a cheaper model. Nobody was there to answer: the next words were
  lost, Enter answered for them, the turn failed after two minutes and the agent changed model until it started again.
- A turn on Codex ends when Codex says so in its log, so the next words no longer go into a turn that is still closing and run twice.
- The live check of a release runs on real nodes one at a time: `install.sh check-node` moves one named node to the build, and
  `install.sh back-node` puts it back on 0.6.1 at once if its turn fails.
- Words someone left in a program's input are kept before a new assignment or a restart, and the agent's log names who typed there.
- Agent terminals show all their columns, keep your place in the history while output grows, and keep what you type while the
  view reconnects.
- Panels, tables, dialogs and the Notebook hold their content at any width, with room for the scrollbar and buttons in one row
  under the text.
- Long reports stay whole, and a person's feedback may be 12,000 characters long.

## [0.7.0] - 2026-11-05

Turn 7: planned node updates wait for running turns to finish; nodes reconnect on their own and keep Chromium ready in a
read-only cache; direct browser links open every screen; the agent window takes pasted and dropped pictures, and the
program operator handles stuck agent programs from masked screen snapshots.

### Added

- Open any screen, panel or agent window directly from its browser address, share the link and step back with the
  browser's Back button.
- Drag or paste screenshots and images into the agent window so the agent sees them in its turn.
- Change your own display name from your account menu, with a history of name changes.
- Inspect a machine's connection history with disconnect reasons, and see on its card when it waits for running turns to
  finish before a planned update or warns how many turns an immediate update would stop.
- Recover stuck CLI programs through Operations' program operator, which receives masked PNG snapshots of the program
  screen and sends keys when delivery receipts stall, with Operations staffed in full across companies.

### Changed

- Planned node updates now stop assigning new turns to the machine, wait up to a bounded deadline for active turns to
  finish before restarting, and postpone the update with a signal to Operations if a turn is still running at the
  deadline; task watchdogs and the program operator treat update waiting as normal waiting, not a hang.
- Nodes detect silent connection drops on their own and reconnect immediately, and `install.sh` installs the node image
  matching the server's build.
- Worker nodes prepare and verify Playwright Chromium ahead of time in a root-owned read-only cache so checks use it
  without downloading a browser, while regular agent turns keep running even if a node's browser check fails.
- On the home screen, the circle now shows the turn number and a task progress bar instead of the turn goal text, and
  cards in the work tree keep their natural size without squishing.
- In the agent window, the close, minimize and maximize buttons sit on the left of the header, every small panel slides
  out beside the terminal through one shared mechanism, minimized windows stay as edge strips across all screens, the
  yellow "no task" banner is gone, the message box stays visible alongside the terminal for everyone allowed to write,
  and machine access in the orchestrator window is a compact strip supporting multiple machines.
- Notifications always show who sent them, to whom and why, without bare "From Hornhoof" headers, and collapse duplicate
  notices of the same event into one message.
- Every wait now rests on a specific holder, waiting cycles are surfaced to the orchestrator, quiet departments alert
  Operations, and task comments reach the active executor or review panel with delivery receipts.

### Fixed

- Task messages sent with `message_employee` deliver reliably to the holder or queue for its next turn when no live
  terminal is open, and a task's executor can reply about its own task.
- Stale turns now keep their reason, program state and last output lines instead of losing diagnostics, and a cancelled
  wake that never started is recorded as obsolete rather than an agent failure.
- Antigravity and other subscription limits refresh reliably when readings succeed without change and stop showing a
  cached timestamp as fresh when a reading fails.

### Before you update

- Update the server first, then the nodes: the server applies database migrations 0052 through 0060 on startup and adds
  the protocol messages for node update draining, connection history, browser readiness, limit freshness and program
  operator receipts that 0.7.0 nodes send.

## [0.6.2] - 2026-11-04

Words typed into a running turn are no longer lost or delivered twice, and a turn keeps answering the CEO when Hornhoof
or another agent writes into it.

### Fixed

- Live words stay with the turn they were typed into until the program's own record shows it took them, also across a
  restart of the program. Words it never took come back as unheard and go with its next turn, in the same session.
- A paste of several lines is erased from the input box only when the box still shows exactly what the paste left
  there, so the words are neither sent twice nor wiped while a person types.
- The next turn waits for the words of the one before at most 15 seconds after it ended, and stops waiting when the
  machine reconnects, disconnects or no longer runs the agent.
- Notices from Hornhoof and messages from other agents no longer take computer access away from the CEO or the CEO's
  deputy in a turn they started.

### Changed

- The agent doing a task, the agent it is assigned to and the reviewers at its gate can all write about it to other
  employees.

### Before you update

- Update the server first, then the nodes: a node from 0.6.2 tells the server when a finished turn's words settled, and
  an older server does not know that message.

## [0.6.1] - 2026-11-04

Urgent fixes for Antigravity: a new machine no longer fails every turn at its
first-run setup, and its agents have Hornhoof's tools from their first turn.

### Fixed

- Antigravity no longer fails every turn on a machine where it never ran. The
  node picks its colors itself and never accepts its terms or the consent to
  use interactions data for a person: the plan shows "Waiting for the first
  setup", its agents wait without spending retries, and its owner accepts the
  terms by running the install command on that machine again. The choice stays
  on the node's volume across updates.
- Antigravity agents have Hornhoof's tools from their first turn again, so they
  hand in work and give verdicts without detours through subagents. Antigravity
  connects to them only once it takes its first message or opens its MCP panel,
  and that first message works without them. The node now opens the MCP panel
  first, waits until Antigravity has listed Hornhoof's tools, closes the panel
  and only then types the work. If they are not listed within 15 seconds, the
  turn fails as "Hornhoof's tools missing" and is tried again in a new
  Antigravity.
- A turn that is tried again says in one short line why the last try failed,
  without the program's screen, and repeats the work its first try was given,
  not the text of the previous retry.

### Before you update

- Update the server first, then the nodes: a server older than 0.6.1 cannot
  read how a 0.6.1 node ends an Antigravity turn that stopped at the first-run
  setup or without Hornhoof's tools, and that turn can hang.

## [0.6.0] - 2026-11-04

Turn 6: one agent window you can open from anywhere, with the agent's current
task beside its terminal; side panels on the left; a work tree you can move and
zoom.

### Added

- Open the same agent window by clicking an agent on the map, in the work tree,
  in Subscriptions or in Machines, also for an agent that is asleep, and write to
  it from there.
- Open the task the agent is working on now with Task in the window header. On a
  wide screen it opens to the left of the terminal; on a narrow one it takes the
  terminal's place, and you can go back to the terminal.
- Close, minimize and maximize the agent window with the three buttons in its
  corner. A minimized window waits as a thin strip at the right edge and slides
  back out when you click it.
- Move and zoom the work tree with the same gestures and buttons as the map.

### Changed

- Every side panel other than the agent window, Speed included, now opens on the
  left, in the same place.
- Agents you cannot open are shown as plain names in Subscriptions and Machines
  instead of buttons that led to an empty window.
- Developers, code reviewers and security engineers now install a project's
  dependencies before they run its checks, so they no longer lose turns on tools
  that seem to be missing.
- The node image includes ShellCheck 0.11.0, so agents can check shell scripts.

### Fixed

- Task in the agent window opens the agent's actual current task, also for the
  orchestrator and for employees of a product.
- Pressing Escape to close a side panel, the account menu or a dialog no longer
  stops a busy agent.
- A minimized agent window no longer hides the live line of a department or
  keeps room for itself on the map.
- Ctrl+O right after new messages appear folds or unfolds the log instead of
  being lost.
- If the company could not be loaded, opening an agent from Subscriptions or
  Machines now shows the error instead of doing nothing.

## [0.5.1] - 2026-11-04

An urgent fix: a message that reached an agent during its turn no longer comes
to it a second time.

### Fixed

- Count a message as delivered when the agent reads it during a turn in Claude
  Code. Claude Code records words pasted over several lines in its own wrapper,
  the node did not recognize them, and Hornhoof gave the agent the same message
  again as a new turn.

## [0.5.0] - 2026-11-04

Turn 5: one work tree for the whole turn, closed tasks that stay quiet, clearer
plan and machine screens, and node restarts that say why they happened.

### Added

- See the whole turn in one work tree: every task, every review and the final
  check, what each agent's program is doing, and who waits for whom since when.
- Mark a task as waiting for an outside event, with a reason and a deadline, so
  it is not reported as stuck while it waits.
- Get a plan's connect command at once in two places: a block on top and the
  plan's row "Waiting for a machine", with the time it stays valid. "Done" hides
  only the block; the command works until it is used or 24 hours pass.
- Make a deputy CEO in "Edit" on the People screen: a deputy sees the whole
  company and takes the CEO's decisions. A short "Dep" badge marks the name.
- Put a person alone in a sub-unit of a department, with a direct line from the
  head (used for urgent fixes).
- Open "About" from the account menu: what Hornhoof is, its version, developer,
  license and links.
- See why a node restarted: which node, planned or not, and the end of its log.
- See the node build: machines whose nodes run another build than the server
  are marked "Other build", with the update command.
- Choose Antigravity models and use Antigravity's own terminal screen.

### Changed

- A plan that does not work shows one full-width block on its card: what is
  wrong and where, the action that fixes it (copy the update command, sign in or
  make a new command) and "Remove". Limits, agents and controls come back once
  it works.
- Signing in on a node that is too old names the machine and gives the update
  command with "Copy".
- Nodes update agent programs when they start and on the update button, never
  in the middle of a turn.
- A second connect command for the same place is refused while the first one
  is still valid.
- Retry and continue send the text that was asked for, without later additions
  from the queue.
- Versions follow turns: turn N is version 0.N.0, urgent fixes between turns
  are 0.N.1, 0.N.2.
- The node image includes the GitHub CLI (gh).

### Fixed

- A closed task no longer wakes anyone: no late comments, no "merge after
  gates" and no retries after an interrupted turn.
- When a task it waited for is cancelled, the waiting task's creator is told.
- A reviewer moved into a sub-unit leaves the reviews it was on.
- Text pasted into an agent's terminal can no longer end the paste early.
- An agent's answer after Stop goes to the right turn.
- A turn on the built-in node cut off by a server restart gets its real reason
  instead of "unknown".
- Reconnecting a plan no longer leaves an old record behind, and a node silent
  for a day is no longer shown as ready.
- After a plan reconnects, the old machine's connection is closed and can no
  longer act for the new node.
- Dots on the map lines no longer vanish with "reduce motion".
- Agents no longer receive the node machine's CLAUDE_CODE_AUTO_COMPACT_WINDOW.
- The server log no longer shows the FSTDEP023 warning.

### Before you update

- Database migrations 0045, 0047 and 0049 to 0052 run on start. They add
  indexes and columns. 0051 clears leftovers of earlier plan reconnects: an
  older plan still waiting for a machine, with no agents and no work, is
  removed with its nodes and saved sign-in when the same owner has a newer
  ready plan of that provider; nodes shown as ready without a key, or of a
  removed plan, are set to "needs sign-in". Removed rows do not come back if
  you return to 0.4.
- Every node restarts once on the new image.
- Update a node on a Mac with the command from the machine card, without
  `--join`.
- Install commands made before this version keep working until a new command
  is made for the same place or 24 hours pass.
