# #244 / #234: Оператор программ, вариант Kimi

Проверен `origin/main` `6ae552b692b6316e164ef0673521a266e0871eee`. Это проектная записка, кода и прогонов тестов в ней нет. Пути ниже относительно корня репозитория.

Главные решения:

- Два MCP-инструмента, `program_screen` и `program_keys`, доступны только роли `OPS-PROGRAM` через grant `program_operator`. Нода повторно проверяет запрет непосредственно перед каждой клавишей.
- Поводы возникают только из квитанций программы. Экран нужен оператору для решения, но сам никогда не меняет состояние хода и не создает повод.
- Повод 2 ждет только первое собственное событие после квитанции поручения. После первого события таймер снимается навсегда, поэтому долгая работа без нового вывода не зовет оператора.
- Неизвестный экран до первого ввода не получает текст поручения. Через 60 секунд нода зовет оператора и ждет его, а не падает по текущему `ready()` через 120 секунд.
- Живые компании доводятся идемпотентной проверкой при старте, не SQL-миграцией с наймом. Миграции части А создают только общие таблицы и индексы, без данных какой-либо компании и без прав людям.
- В задаче говорится о восьми шаблонах, но в проверенном коде их девять: `home` добавлен девятым (`packages/protocol/src/index.ts:194-200`, `packages/protocol/test/protocol.test.ts:286-289`). Меняем все девять, покрывая и требуемые восемь.

## 1. Данные и протокол

### 1.1. Хранение поводов и идемпотентных действий

В `apps/server/src/db/schema.ts` часть А добавляет две общие таблицы и новую миграцию через `npx drizzle-kit generate` в `apps/server`:

```ts
program_operator_cases {
  id: text primary key;                 // prompt:<jobId>, first-event:<jobId>, unheard:<agentId>:<seq>, exit:<jobId>
  companyId: uuid not null;
  agentId: uuid not null;               // чья программа
  jobId: uuid null;                     // ее ход, если он еще существует
  reason: 'prompt_receipt' | 'first_event' | 'live_unheard' | 'quick_exit';
  status: 'open' | 'queued' | 'resolved' | 'timed_out';
  operatorJobId: uuid null;
  detail: text null;
  createdAt: timestamp not null;
  resolvedAt: timestamp null;
}

program_operator_actions {
  id: uuid primary key;                 // actionId от оператора
  companyId: uuid not null;
  agentId: uuid not null;               // чья программа
  caseId: text null references program_operator_cases.id;
  operatorAgentId: uuid not null;
  operatorJobId: uuid not null;
  request: jsonb not null;
  response: jsonb not null;
  createdAt: timestamp not null;
}
```

Вставка повода делается `INSERT ... ON CONFLICT DO NOTHING`. Только транзакция, действительно вставившая строку, ставит вызов оператору. Повторная квитанция, одновременный reconcile и reconnect не создают второй вызов. Повтор `program_keys` с тем же `actionId` только читает сохраненный `response` и ничего не посылает в tmux. Статус повода и журнал исхода обновляются вместе.

Существующие `agent_events` остаются журналом агента (`apps/server/src/db/schema.ts:367-395`), а `appendEvent` публикует события в его окно (`apps/server/src/modules/events/store.ts:46-68`). Новые квитанции записываются туда с существующим `kind: 'program'`, аудит клавиш с `kind: 'message'` и `turnFact: true`, поэтому нового вида событий и изменения веба не требуется.

### 1.2. Сообщения ноды

Новый `packages/protocol/src/program-operator.ts` содержит Zod-схемы и типы:

```ts
// node -> server
job.receipt {
  jobId: string;
  kind: 'prompt_attempt' | 'prompt_taken' | 'live_taken';
  at: number;
}
operator.need { jobId: string; reason: 'prompt_receipt' | 'first_event' }
operator.screen_result { requestId: string; screen: string; state: ProgramState; waitingCaseId: string | null }
operator.action_result { actionId: string; results: { key: string; ok: boolean; code: string }[]; screen: string; state: ProgramState }

// server -> node
operator.screen { requestId: string; agentKey: string }
operator.action {
  actionId: string;
  agentKey: string;
  expectedJobId: string | null;
  caseId: string | null;
  action: { type: 'keys'; keys: OperatorKey[] }
        | { type: 'ready' }
        | { type: 'escalate' | 'fail'; detail: string }
}
```

`OperatorKey` только перечисление: `Enter`, `Space`, `Escape`, `Tab`, `BTab`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PgUp`, `PgDn`, `BSpace`. Произвольного текста, paste, CSI-последовательностей, `C-c`, `C-d`, `C-z`, tmux prefix и аргументов tmux нет. Так API сам исключает ввод пароля, кода, команды оболочки и завершение процесса, а не только просит об этом навык.

Модуль экспортирует `parseOperatorNodeMessage(raw)` и `parseOperatorServerMessage(raw)`: сначала вызывают существующий parser, затем разбирают только добавленные типы. `apps/server/src/modules/nodes/hub.ts:91-107` и `apps/node/src/connection.ts:43-46` переходят на эти обертки. В `packages/protocol/package.json:5-25` добавляется только subpath export `./program-operator`.

Это позволяет части А не трогать `packages/protocol/src/index.ts`, который меняет часть Б. Для совместимости версий в том же модуле есть `operator.hello { programOperator: 1 }` от ноды и `operator.ready { programOperator: 1 }` от сервера. Нода посылает hello сразу после обычного `hello`, а новые поводы и ожидание оператора включает только после ready. Старый сервер не отвечает ready, поэтому нода сохраняет прежнее поведение и не зависает на обновлении раньше сервера. Сервер хранит capability у подключения ноды, старой ноде возвращает `node_outdated` и не ждет от нее новых квитанций. Это осознанный компромисс разделения без общих файлов.

Все screen-строки нода пропускает через существующий `redact` до wire-ограничения, как `ProgramWatch` (`apps/node/src/terminal/program-state.ts:40-48`). Снимок ограничен последними 40 строками и `PROGRAM_SCREEN_MAX`, как текущий lastScreen (`apps/node/src/terminal/program-state.ts:31-34`).

## 2. MCP-инструменты и путь до tmux

### 2.1. Регистрация и права

Новый `apps/server/src/modules/terminals/operator.ts` экспортирует `registerProgramOperatorTools(server, ctx, job)`. Он вызывается из `registerWatchTools` при `grants.has('program_operator')`; это место уже получает grants навыка (`apps/server/src/modules/tools/watch.ts:73-80`), а `apps/server/src/modules/tools/mcp.ts:38-45` регистрирует их у каждого не-оркестратора.

Дополнительно к grant сервер проверяет `job.companyId`, `job.agentId`, `job.roleKey === 'OPS-PROGRAM'`, действующий running tool token и цель в той же компании. Сам `jobOf` уже связывает token с running job и агентом (`apps/server/src/modules/tools/job.ts:18-37`). Grant без нужной роли и роль без включенного навыка инструментов не получают. Чужой `employee` дает 404, чтобы не раскрывать чужую компанию.

Для узла используется `programNode`, который выбирает ноду текущего running job, а не просто последнюю ноду агента (`apps/server/src/modules/conversation/queue.ts:189-214`). Это не дает послать клавиши на машину, куда агент уже переехал.

### 2.2. `program_screen`

Вход строгий:

```ts
{ employee: uuid }
```

Ответ-пример:

```json
{
  "employee": "7f0b...",
  "jobId": "99c1...",
  "state": "idle",
  "waitingCaseId": "prompt:99c1...",
  "keysAllowed": true,
  "keysRefusal": null,
  "screen": "Choose a color theme\n> Dark\n  Light"
}
```

Путь: MCP -> `programNode` -> `operator.screen` -> `apps/node/src/main.ts` -> `TerminalHost.screen` -> `Tmux.screen` -> `capture-pane`. Уже существуют `TerminalHost.screen` (`apps/node/src/terminal/host.ts:389-391`) и `Tmux.screen` (`apps/node/src/terminal/tmux.ts:218-221`). Живой терминал подключен к той же tmux-сессии `a-<agentId>` через `Tmux.attach` (`apps/node/src/terminal/tmux.ts:259-270`), поэтому отдельного реплея или второго экрана нет. Ответ содержит текстовый снимок того же pane, не PNG и не новый renderer.

Чтение экрана разрешено и во время работы: оно не меняет программу. Ожидание ответа 5 секунд, без периодического polling.

### 2.3. `program_keys`

Вход strict и discriminated by `action.type`:

```ts
{
  employee: uuid;
  actionId: uuid;             // повторный вызов обязан сохранить тот же id
  reason: string;             // 1..1000, зачем действие
  caseId?: string;            // обязателен для ready/escalate/fail
  action:
    | { type: 'keys'; keys: OperatorKey[] }       // 1..20
    | { type: 'ready' }                           // экран пройден, продолжить исходный ход
    | { type: 'escalate' | 'fail'; detail: string } // 1..2000, названная причина
}
```

Пример вызова и ответа:

```json
{
  "employee": "7f0b...",
  "actionId": "b2f1...",
  "caseId": "prompt:99c1...",
  "reason": "The first-run theme is harmless; choose the default and continue.",
  "action": { "type": "keys", "keys": ["Enter"] }
}
```

```json
{
  "actionId": "b2f1...",
  "results": [{ "key": "Enter", "ok": true, "code": "sent" }],
  "state": "idle",
  "screen": "Choose a color theme\n> Dark\n  Light"
}
```

Сервер повторно проверяет running `jobId`, case, `program.state` и ноду, затем вызывает `operator.action`. Нода использует собственные `a.turn`, `a.busy`, `a.took`, `a.question`, `a.calls` и `programState`, а не текст экрана. Перед каждой клавишей проверка повторяется, действия сериализуются после `a.saying`, чтобы не смешаться с живыми словами (`apps/node/src/terminal/host.ts:1494-1537`). Отправка идет только через `Tmux.keys` (`apps/node/src/terminal/tmux.ts:214-216`).

Стабильные отказы: `program_busy`, `escape_busy`, `turn_changed`, `program_gone`, `node_offline`, `node_outdated`, `case_not_waiting`, `not_ready`, `unknown_key`. Ошибка не считается нажатием и не приводит к повторной отправке при retry.

`ready` разрешен только в ожидании повода 1 и только если программа действительно достигла известного ready/prompt или дала `prompt_taken`. Иначе `not_ready`. `escalate` и `fail` завершают ожидание с названной причиной; вне ожидания они не останавливают работающий ход. При `escalate` сервер сам пишет оркестратору с текстовым снимком, `caseId`, agent, job и `detail`, поэтому третий MCP-инструмент и особое разрешение писать оркестратору не нужны. Для `escalate` после `program_gone` нода не нужна: сервер использует последний снимок и не пытается послать действие в мертвый pane. `fail` после гибели программы отклоняется `program_gone`, поскольку исходный ход уже закрыт.

### 2.4. Аудит каждой клавиши

После подтверждения ноды сервер пишет в `agent_events` целевого агента одну запись на клавишу:

```ts
{
  kind: 'message',
  jobId: targetJobId,
  personId: null,
  data: {
    turnFact: true,
    text: 'Program operator <name> pressed Enter: <reason>',
    operatorActionId: actionId,
    operatorAgentId: job.agentId,
    operatorJobId: job.id,
    operatorKey: 'Enter',
    reason,
    result: 'sent'
  }
}
```

Отказ тоже журналируется с `result` и stable code, но без текста `pressed`: например, `refused Escape: escape_busy`. В событии видно, кто нажал, что, в чей ход и почему. Секретов в записи нет, поскольку принимаются только имена из enum. Экран в журнал каждого нажатия не копируем; он приходит в ответе и при escalation.

## 3. Запрет во время работы

Единая функция нового `apps/node/src/terminal/operator.ts`:

```ts
operatorRefusal(a: Agent, expectedJobId: string | null, key?: OperatorKey): string | null
```

Правила:

1. `expectedJobId !== (a.turn?.jobId ?? null)` => `turn_changed`. Проверка предотвращает нажатие в следующий ход после гонки.
2. Программа мертва => `program_gone`.
3. `working = a.turn && (a.turn.typed || (a.busy && a.took))`. Это те же признаки, которые использует текущий `stoppable` (`apps/node/src/terminal/host.ts:883-885`).
4. `asking = a.question?.asking || a.question?.name === 'AskUserQuestion'`; состояние берется из hook/log через `programState`, не из экрана (`apps/node/src/terminal/program-state.ts:20-29`).
5. `working && !asking` => любые клавиши отклонены, включая Enter и Escape.
6. `working && asking && key === 'Escape'` => `escape_busy`; остальные разрешенные enum-клавиши допустимы.
7. До первого `prompt_taken` `working` ложно, поэтому навигация по неизвестному стартовому экрану разрешена. Произвольный текст все равно невозможен по API.
8. Проверка выполняется снова непосредственно перед каждым `send-keys`. Если состояние изменилось между клавишами, остаток пакета не отправляется.

Сервер делает такой же предварительный отказ по сохраненному `job.program`, чтобы не дергать ноду зря, но он не является защитой: окончательное слово всегда за нодой. `job.program` уже строится только из событий программы (`apps/server/src/modules/tasks/silent.ts:47-89`). Изменять существующий человеческий терминал и его stop/Escape не требуется: запрет относится к новому инструменту оператора.

## 4. Четыре повода и их таймеры

### 4.1. Общая доставка

`apps/server/src/modules/tasks/operator.ts`:

- `recordProgramReceipt(ctx, node, msg)` проверяет владельца job через текущий `jobsOf` и сохраняет квитанцию;
- `requestOperator(ctx, job, reason, caseId, detail?)` атомарно создает case;
- `dispatchOperatorCase(ctx, caseId)` выбирает неудаленного, включенного `OPS-PROGRAM` той компании с действующей подпиской, самого старого по `createdAt`, и делает `enqueueTurn` с reason, agent, job, caseId и инструкцией вызвать `program_screen`;
- `sendPendingOperatorCases(ctx)` обрабатывает `open` без `operatorJobId` при старте, после появления подписки и в минутном `reconcile` (`apps/server/src/modules/tasks/reconcile.ts:96-112`);
- `resolveOperatorCase(ctx, caseId, status, detail?)` идемпотентно закрывает случай.

Если оператора или тарифа нет, case остается `open`, а оркестратор один раз получает `operator_unavailable` с исходным agent/job/reason. Это не новый повод вызова и не повтор каждую минуту. Один оператор может читать вызовы последовательно из своей очереди; busy не ведет к выбору второго оператора и дублированию.

### 4.2. Повод 1: нет квитанции поручения 60 секунд

Сейчас нода ждет ready до 120 секунд (`apps/node/src/terminal/host.ts:579-609`, `950-982`), затем вставляет prompt и повторяет Enter (`apps/node/src/terminal/host.ts:634-655`). Меняем только live conversation, не безагентные test jobs:

1. В `turnIn`, до `startProgram` и ожидания `ready()`, нода регистрирует `prompt_attempt` с `jobId`. Это покрывает и ожидание готовности по уточнению руководителя.
2. Только подтверждение исходного prompt из hook/log порождает `prompt_taken`. `TurnWords` уже сопоставляет слова с программным журналом (`apps/node/src/terminal/program-restart.ts:66-116`), а тесты #151 находятся в `apps/node/test/terminal-host-receipts.test.ts`.
3. Если через 60 секунд нет `prompt_taken`, нода посылает `operator.need('prompt_receipt')`, прекращает автоматические Enter и ждет. До известного ready текст не вставляется никогда.
4. Текущий `failedTurn` по истечении `readyMs` для этого случая удаляется. Известные auth/setup сохраняют свой `a.failure` для последующего владельца тарифа, но тоже ждут оператора после 60 секунд, а не обходят его. Отмена хода и смерть процесса идут своими прежними путями.
5. Принятая клавиша сбрасывает 15-минутный таймер бездействия оператора. Нода продолжает проверять ready/receipt. `ready` от оператора проверяется нодой, после чего исходный prompt вставляется и ход продолжается.
6. `escalate`/`fail` завершает ход с переданной причиной. Если уже был `a.failure` вида auth/setup, сохраняется его класс, иначе `unknown`, `retryable: false`. Существующий `afterFailure` дальше применяет обычную политику (`apps/server/src/modules/tasks/failures.ts:151-168`).
7. Если оператора нет или он молчит, через 15 минут после последнего принятого действия ход заканчивается `agent_failed` с `Operator did not resolve prompt receipt within 15 minutes` и последним экраном. Case становится `timed_out`, оркестратор получает один сигнал с caseId и экраном. Повторного вызова по этому case нет.

15 минут относится к ожиданию решения, не к общей длительности работы. Live host сейчас намеренно untimed (`apps/node/src/main.ts:454-465`), поэтому отдельный явный предел здесь обязателен.

### 4.3. Повод 2: квитанция есть, первого своего события нет 5 минут

На `prompt_taken` нода ставит один таймер на 5 минут. Первый собственный `AgentEvent` этой программы, который идет в `job.event` (`text`, `tool`, `tool_result`, `todo`), снимает его навсегда. Существующий путь событий: `host.emit` -> `job.event` -> `appendTurnEvent` (`apps/node/src/terminal/host.ts:1237-1251`, `apps/server/src/modules/nodes/messages.ts:225-227`).

Если первого события нет через 5 минут, нода посылает `operator.need('first_event')`. Сам ход не завершается и не останавливается. Пока события говорят `thinking/tool/retrying`, оператор получит `program_busy` на клавиши и только посмотрит экран или эскалирует.

После первого события никаких таймеров на промежутки между событиями нет. Долгая работа без вывода, долгий tool и `asking` не создают повод. Текущие 30-минутные/2-часовые silent alarms остаются отдельным механизмом OPS-WATCH (`apps/server/src/modules/tasks/silent.ts:117-135`), не новым вызовом оператора.

### 4.4. Повод 3: живые слова не взяты три раза подряд

Сейчас `TurnWords` различает `waiting/queued/held/taken/discarded` (`apps/node/src/terminal/program-restart.ts:43-67`), нода сообщает `agent.unheard` (`apps/node/src/terminal/host.ts:1136-1157`), а сервер считает три записи за час и зовет общего Operations watcher (`apps/server/src/modules/conversation/unheard.ts:35-48`).

Меняем:

- при фактическом `taken` живых слов нода дополнительно шлет `live_taken`; `queued`, `held` и `agent.said(ok)` успехом не считаются;
- `repeatedUnheard` идет по сохраненным событиям агента назад и считает `unheardAt` только до ближайшего `live_taken`. Окна в час больше нет: счет именно подряд;
- повторное переиспользование текста в следующий ход остается без изменений (`apps/server/src/modules/conversation/unheard.ts:15-33`);
- на третьем подряд создается case `unheard:<agentId>:<seq третьего agent_event>` с reason `live_unheard`. Четвертый без нового `live_taken` нового case для той же тройки не создает; следующая тройка после успешного взятия получает новый seq и является новым поводом.

Общий `notifyFailure` для этого случая заменяется вызовом `OPS-PROGRAM`, чтобы не будить две роли по одному событию.

### 4.5. Повод 4: программа сразу завершилась или упала

Обработчик `job.done` уже получает `exit` и время завершения (`apps/server/src/modules/nodes/messages.ts:37-59`, `235-258`). Для conversation job с агентом создается `exit:<jobId>`, если:

- `msg.exit` присутствует, включая code 0;
- между `job.startedAt` и `finishedAt` меньше 60 секунд;
- это не `cancelled`, `machine_restarted`, `machine_offline`, `machine_disconnected`, `subscription_removed`, `removed`, `switched_off`.

Обычные retry/failure/лимиты не меняются. Порог 60 секунд фиксирует «сразу после запуска», а не текущие три минуты для серии быстрых падений (`apps/server/src/modules/tasks/wake.ts:402-416`). `remain-on-exit` tmux сохраняет последний экран (`apps/node/src/terminal/tmux.ts:13-24`), поэтому `program_screen` работает, а `program_keys` отвечает `program_gone`.

Экран, `screenAt`, `signAt`, `node_silent` и долгое отсутствие вывода сами по себе ни одного из четырех случаев не создают.

## 5. Роль и навык

Новые общие файлы:

- `templates/roles/operations/OPS-PROGRAM.md`;
- `templates/skills/ops-program-operator.md`;
- строки обоих в `templates/SOURCES.md`, источник собственный Hornhoof, как у соседних Operations (`templates/SOURCES.md:60-65`).

Frontmatter роли:

```yaml
id: OPS-PROGRAM
department: operations
kind: member
title: { en: "Program operator", ru: "Оператор программ" }
description: { en: "Passes harmless agent program screens and escalates account, consent and payment screens with evidence.", ru: "Проходит безобидные экраны программ агентов и передает оркестратору экраны входа, согласий и оплаты с доказательствами." }
tier: standard
effort: medium
perProduct: false
default: true
order: 70
skills: [ops-program-operator]
```

В `GRANTS` добавляется `program_operator` рядом с текущими (`apps/server/src/modules/templates/load.ts:12-17`). Навык имеет `grants: [program_operator]`, собственный текст без компании, продукта, отрасли и языка программирования по `AGENTS.md:18-20`.

Навык предписывает:

1. Начать с `program_screen`, сверить agent/job/case. Не нажимать по предположению и не классифицировать работу по мерцающему экрану: отказ инструмента читать как текущее состояние.
2. Самому пройти только безобидное: цветовую схему, «нажмите Enter», новость о версии, подсказку первого запуска, закрытие информационной панели. Использовать минимум клавиш, затем `ready`, если ждали повод 1.
3. Ничего не нажимать на условиях, любом согласии, включая передачу данных, входе, учетной записи, паролях, кодах, оплате и смене тарифа. Вызвать `escalate` с `detail` и снимком: это решает владелец тарифа. Любой неизвестный секрет на экране дополнительно маскируется в тексте сигнала.
4. При непонятном экране, отказе клавиши или невозможности пройти не пробовать случайные клавиши. Сразу `fail` с тем, что за экран и почему стоит; сервер передает это оркестратору. После `program_gone` вызвать `escalate` с тем же снимком: клавиши в мертвый pane не посылаются, а завершать уже закрытый ход не требуется.
5. Никогда не вводить текст или секреты, не останавливать работающего агента, не принимать условия, не менять тариф, не повторять action с новым `actionId`. Retry только со старым `actionId`.
6. Завершить одной строкой: какой case, что нажато или кому передано, какой stable code получен.

Частые известные экраны нода продолжает проходить сама, в частности Antigravity colors (`apps/node/src/terminal/host.ts:985-995`). Оператор нужен только для четырех поводов.

## 6. Полные Операции и закрепленные роли

### 6.1. Шаблоны компаний

В `COMPANY_TEMPLATES` каждой Operations задается по одному `OPS-HEAD`, `OPS-WATCH`, `OPS-BUGS`, `OPS-PROGRAM`. Существующие `OPS-INTEG` и `OPS-FIX` сохраняются: «полный состав» означает обязательный минимум, не удаление других ролей. Текущие различия видны в `packages/protocol/src/index.ts:200-283`. Те же массивы меняются в `apps/web/src/templates.ts:21-107`; существующий тест равенства не дает им разойтись (`apps/web/test/StructureCard.test.tsx:130-132`).

Setup создает отделы, а не сотрудников (`apps/server/src/modules/setup/routes.ts:132-147`), поэтому фактический найм идет через roster/propose_staff ниже. Обновляем и инструкцию оркестратора в `apps/server/src/modules/conversation/prompt.ts:17`: четыре роли обязательны и не предлагаются к исключению ради экономии тарифа.

### 6.2. Предложение состава

В `apps/server/src/modules/tools/staff.ts` единый список:

```ts
export const REQUIRED_OPERATIONS_ROLES = ['OPS-HEAD', 'OPS-WATCH', 'OPS-BUGS', 'OPS-PROGRAM'] as const;
```

- `propose_staff` в `apps/server/src/modules/tools/mcp.ts:83-111` добавляет недостающие обязательные роли Operations и принудительно ставит им `checked: true`. Уже существующих живых сотрудников в список не добавляет повторно.
- `GET /roster` отдает каждой роли `required: true/false`; default roster содержит обязательные роли благодаря `default: true` (`apps/server/src/modules/departments/routes.ts:326-349`).
- `StaffCard` вычисляет `fixed = r.role.required`, ставит checked и отключает только checkbox, как `StructureCard.fixed` делает для Operations (`apps/web/src/ui/StructureCard.tsx:22-24`, `67-73`). Модель и тариф оператора остаются доступными. Текущий свободный checkbox находится в `apps/web/src/ui/StaffCard.tsx:110-126`.
- Сервер не доверяет скрытому checkbox. При apply `POST /staff` объединяет роли живых агентов отдела и `body.people`; для Operations отсутствие любой обязательной роли дает 400 `operations_roles_required` до вставки. Поэтому нельзя ни снять роль в подделанном запросе, ни нанять второго head ради обхода. Точка вставки до текущего цикла найма: `apps/server/src/modules/departments/routes.ts:352-414`.
- Добавление одной недостающей роли в уже укомплектованные Операции разрешено: существующие три засчитываются. Другие отделы не меняются.

## 7. Тариф оператора

В `apps/server/src/modules/operations/ensure.ts` два отдельных помощника:

```ts
firstOperationsSubscription(ctx, companyId): Promise<Subscription | null>
assignOperatorSubscription(ctx, companyId): Promise<void>
```

Выбор использует тот же порядок и правила доступа, что `servingSubscriptions` (`apps/server/src/modules/tools/staff.ts:66-104`): сначала подходящие персональные тарифы и ключи места, затем ключи `any`, по `createdAt`. Отличие одно: для автоматического ожидания не отбрасываются `waiting_machine`, `needs_login`, `needs_setup`, потому что тариф уже существует и очередь сама ждет готовности (`apps/server/src/modules/conversation/queue.ts:626-650`). Удаленные тарифы и тарифы disabled-владельца не берутся. Роль `standard` может работать на любом provider по `runsTier` (`apps/server/src/modules/tools/staff.ts:49-51`). Тариф, который не имеет права служить Operations, автоматически не захватывается.

- При найме оператора, если line.subscription не задан явно, используется `firstOperationsSubscription`, а не только текущий список уже connected.
- Если подходящего тарифа нет, сотрудник создается с `subscriptionId: null`, моделью `''` и ждет. Существующий state уже честно показывает `no_subscription` (`apps/server/src/modules/conversation/queue.ts:768-789`).
- После создания API key и после `/subscriptions/connect` вызывается `assignOperatorSubscription`: оно заполняет только `null`, никого не переносит с уже выбранного тарифа и не спрашивает CEO. Затем `resumeAgent` и `pump`, как после ручного назначения (`apps/server/src/modules/agents/routes.ts:259-263`).
- Те же проверки при старте заполняют `null` у уже существующего оператора. Повторный вызов ничего не меняет. Удаление тарифа по-прежнему обнуляет подписку (`apps/server/src/modules/subscriptions/routes.ts:269-289`), следующий подходящий первый тариф будет назначен тем же правилом.

Если несколько тарифов появились одновременно, выбирается самый ранний `createdAt` с детерминированным tie-break по `id`. Это мой выбор для повторяемости, а не новое требование CEO.

## 8. Уже живые компании

Выбираем проверку при старте, не найм в SQL-миграции. `createDb` выполняет миграции до загрузки шаблонов и построения app (`apps/server/src/db/client.ts:23-28`, `apps/server/src/app.ts:73-99`), а найму нужны templates, доступы, тарифы и проверка длины инструкций. SQL-миграция не должна содержать данных одной компании или выдачи прав людям.

`ensureOperations(ctx)` вызывается в `onReady` после `ctx.templates = loadTemplates` и повторяется идемпотентно:

1. Находит каждый живой top-level отдел `templateKey: 'operations'` каждой компании.
2. Под transaction и advisory lock по `companyId` перечитывает живые roleKey.
3. Нанимает только отсутствующие обязательные роли через ту же функцию подготовки agent row, что staff route: template hashes, enabled skills, timer роли, `createdBy: null`, модель `''`, подходящий тариф или null. Таймеры OPS-WATCH и OPS-BUGS берутся из их шаблонов (`templates/roles/operations/OPS-WATCH.md:10-13`, `OPS-BUGS.md:10-13`).
4. Проверяет `renderInstructions` по тому же `MAX_INSTRUCTIONS`, что обычный найм (`apps/server/src/modules/departments/routes.ts:382-410`). Ошибка одной компании логируется и не мешает старту остальных; она не приводит к половинчатой транзакции.
5. Пишет `agentChanges` с `personId: null`, `byOrchestrator: false`, field `hired`: это автоматическая системная доводка, не действие человека и не выдача прав. Схема допускает системную запись (`apps/server/src/db/schema.ts:274-290`).
6. Вызывает `assignOperatorSubscription`, публикует `org` и запускает ожидающие turn только после commit.

Проверка не удаляет и не переименовывает сотрудников, не включает выключенных, не сбрасывает overrides, не меняет права людей и не переназначает существующие тарифы. Повторный старт не создает дублей. Сотрудник, удаленный человеком после доводки, будет создан снова при следующем старте, поскольку состав обязателен; до перезапуска обычный fire не блокируем.

## 9. Разделение на две части без общих файлов

### Часть А: инструменты, запрет, поводы

Файлы:

- новый `packages/protocol/src/program-operator.ts`, новый `packages/protocol/test/program-operator.test.ts`, `packages/protocol/package.json`;
- новый `apps/server/src/modules/terminals/operator.ts`;
- новый `apps/server/src/modules/tasks/operator.ts`;
- `apps/server/src/modules/tools/watch.ts`;
- `apps/server/src/modules/nodes/hub.ts`, `messages.ts`;
- `apps/server/src/modules/conversation/unheard.ts`;
- `apps/server/src/db/schema.ts` и только новая `apps/server/drizzle/*` миграция части А;
- новый `apps/node/src/terminal/operator.ts`;
- `apps/node/src/terminal/host.ts`, `program-restart.ts`;
- `apps/node/src/main.ts`, `connection.ts`;
- новые тесты `apps/server/test/program-operator.test.ts`, `program-operator-cases.test.ts` и новый `apps/node/test/terminal-operator.test.ts`; существующие `apps/server/test/unheard.test.ts` и `apps/node/test/terminal-host-receipts.test.ts` только А.

Часть А не меняет `tools/mcp.ts`, `templates/load.ts`, `protocol/src/index.ts` или веб.

Тесты А, сначала падающие:

- MCP отсутствует без grant/роли, чужая компания 404, повтор `actionId` не шлет клавишу повторно;
- снимок именно текущего tmux pane redacted, offline/old node дает стабильный отказ;
- `thinking`, `tool`, `retrying` и typed turn отклоняют все клавиши; `asking` пропускает Enter, но не Escape; до первого receipt разрешены enum-клавиши; смена job между вызовом и нажатием отклоняет пакет;
- каждая подтвержденная клавиша и каждый отказ имеют отдельный audit с operator agent/job, key и reason;
- повод 1 наступает от `prompt_attempt` во время `ready()`, текст в неизвестный экран не вставлен, 60 секунд -> ровно один case, `ready` продолжает исходный prompt;
- без оператора и при молчании через 15 минут названный timeout и один сигнал; принятая клавиша продлевает окно; escalate на consent не шлет ни одной клавиши;
- повод 2: нет первого event 5 минут -> один case; после первого event долгие `thinking` и `tool` без вывода не зовут;
- повод 3: две неудачи, успех `live_taken`, затем три неудачи -> только один новый case; `queued/held` не сбрасывают серию;
- повод 4: быстрые exit code 0 и crash зовут однажды; cancel/restart/machine offline и поздний exit не зовут;
- одновременные `requestOperator` с одним caseId создают одну строку и один operator job; reconnect и `sendPendingOperatorCases` не дублируют;
- существующие receipt, restart, live/unheard тесты остаются зелеными, кроме осознанно измененного правила «три за час» -> «три подряд».

### Часть Б: роль, навык, шаблоны, состав, тариф, живые компании

Файлы:

- `templates/roles/operations/OPS-PROGRAM.md`, `templates/skills/ops-program-operator.md`, `templates/SOURCES.md`;
- `apps/server/src/modules/templates/load.ts`;
- новый `apps/server/src/modules/operations/ensure.ts`;
- `apps/server/src/app.ts`, `modules/conversation/prompt.ts`;
- `apps/server/src/modules/tools/staff.ts`, `tools/mcp.ts`;
- `apps/server/src/modules/departments/routes.ts`, `modules/subscriptions/routes.ts`;
- `packages/protocol/src/index.ts`, `packages/protocol/test/protocol.test.ts`;
- `apps/web/src/templates.ts`, `types.ts`, `ui/StaffCard.tsx`, при новой подписи `i18n/en.ts` и `ru.ts`;
- новые `apps/server/test/operations-ensure.test.ts` и существующие `templates.test.ts`, `departments.test.ts`, `orchestrator-control.test.ts`;
- `apps/web/test/StaffCard.test.tsx`, `StructureCard.test.tsx`, `Setup.test.tsx`.

Часть Б не меняет protocol package.json, `tools/watch.ts`, DB schema, ноду или файлы поводов.

Тесты Б, сначала падающие:

- каждый из девяти шаблонов содержит обязательные четыре роли, дополнительные роли не потеряны, web и server массивы равны;
- роль загружается, навык существует, `program_operator` входит в grants, инструкции укладываются в лимит;
- proposal Operations содержит четыре checked/fixed роли; подделанное снятие галочки и прямой apply с пропуском получают 400; добавление только недостающего оператора к трем существующим работает;
- найм с существующим подходящим тарифом назначает его сразу; без тарифа создает null; первый следующий тариф назначается автоматически без CEO; повтор не переносит;
- `waiting_machine` тоже считается существующим тарифом и очередь ждет готовности;
- живая компания с одним head получает три недостающие роли за одну проверку, со вторым запуском дублей нет; выключенные и удаленные старые записи не воскрешаются в пределах той же проверки; overrides и права людей не меняются;
- отсутствие тарифа не мешает доводке, последующий `assignOperatorSubscription` запускает ожидающего оператора;
- новая компания из каждого шаблона после обычного staffing имеет полный минимум.

Общий контракт А <-> Б только в данных, не в импортах друг друга:

- roleKey `OPS-PROGRAM`;
- grant `program_operator`;
- MCP `program_screen`, `program_keys` и их strict схемы из разделов 2.2-2.3;
- `operatorCase` с reason и `actionId`;
- часть А корректно оставляет case `open`, если Б еще не слили или оператор ждет тариф. Поэтому порядок merge не блокирует ни одну часть.

После merge совместный сценарий: неизвестный экран -> case -> `OPS-PROGRAM` -> безобидный Enter -> `ready` -> исходная работа продолжается. Затем consent -> ни одной клавиши -> оркестратор получает экран. Полный набор каждой части, typecheck server/node/web/protocol и полный `npm test` на итоговой ветке; Linux через `run_tests`, как требует #234.

## 10. Риски и ранние проверки

- **Чужая программа.** Главная граница не UI, а running tool token + roleKey + grant + company на сервере и повторная проверка job/state на ноде. Это проверяется первым тестом до tmux.
- **Секреты и оплата.** API не принимает свободный текст и управляющие последовательности. Consent/payment классифицирует оператор, а не экранный regex. Любое нажатие аудируется. Нода маскирует известные секреты в экране, оператор дополнительно маскирует увиденное в escalation.
- **Гонка состояния.** `expectedJobId`, `a.saying` и проверка перед каждой клавишей закрывают смену хода и смешение с живыми словами. Отдельный тест меняет состояние между двумя клавишами.
- **Ложные вызовы.** Повод 2 только до первого события; queued/held не считаются взятием; экран и тишина не участвуют. Auth/setup проходят через оператора только по поводу 1, их прежняя классификация сохраняется для владельца.
- **Дубли после reconnect.** Первичный ключ case и actionId в БД, а не WeakMap, является источником идемпотентности. In-memory timers лишь напоминают о pending.
- **Нагрузка.** Нет фонового захвата экранов: только on-demand. На ход максимум два таймера, 60 секунд и 5 минут, плюс 15 минут только при ожидании. Case/action запросы по PK; pending читается раз в минуту. Пакет ограничен 20 клавишами, экран 4000 символами.
- **Оператор недоступен.** Исходный ход не висит бесконечно: 15 минут бездействия, затем названный исход и оркестратор. Другие поводы не останавливают работу.
- **Разделение протокола.** Отдельный subpath parser необычен, поэтому ранний contract test проверяет старые и новые сообщения в обе стороны и `tsc` после сборки protocol. Альтернатива, общий `index.ts`, отвергнута: она создает конфликт двух разработчиков.
- **Доводка при старте.** Риск только в повторном найме, закрыт transaction + advisory lock + тестом двух одновременных `ensureOperations`. SQL остается общей схемой, найм выполняется доменным кодом после загрузки templates.

## 11. Принятые проектные допущения

- «Первый тариф» означает первый подходящий Operations по существующим правилам доступа, включая ожидающий машину, но не удаленный и не disabled. Захват чужого недоступного тарифа был бы расширением прав, а не доводкой состава.
- «Сразу после запуска» для повода 4 зафиксировано как 60 секунд, чтобы правило было проверяемым и не совпадало с отдельной серией трехминутных quick crashes.
- Текстовый capture tmux считается снимком экрана для MCP. PNG-renderer и новая зависимость не нужны.
- Ожидание оператора ограничено 15 минутами бездействия, а не бесконечным ожиданием и не двухчасовым test timeout.
- Обязательный состав является минимумом из четырех; остальные Operations roles сохраняются.
