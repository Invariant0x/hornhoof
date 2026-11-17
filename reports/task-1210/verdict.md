# Вердикт Security #1210: отдельный одноразовый контейнер для codex review (для #1157)

Проверяющий: Architect (Claude Opus 5.5), только чтение. Дата: 17.11.2026, UTC.
Кандидат: `task-1157-isolated-plan.txt` v1, вложение 0646d688-ba27-41c2-bbf4-2cf75fdf2e76 в #1157, SHA-256 `dc2c9fa78c59581368a512a14731df79328afa78ae612c4b4c096ca81c641470` (скачан, сумма совпала).

## Решение: ДОПУСТИТЬ С ГРАНИЦАМИ — архитектуру, не запуск

Отдельный одноразовый контейнер без общего `/data`, со своим PID и сетевым пространством, своим UID, home и снимком кода закрывает все четыре канала, из-за которых v2 отклонил контейнер тарифа: чужие рабочие папки, окружение чужих процессов, адреса моста и git-токены. Это верно при условиях раздела «Условия допуска». План верно отказывается от расширения 606af686.

**Запуск этим вердиктом не разрешен.** Сами Операции пишут, что v1 — проект: образ, UID, сеть, авторизация и запас ресурсов не закреплены. Нужна v2 плана с закрепленными значениями из таблицы ниже, и ее точная версия должна пройти Security. Затем — фаза A (без сети и без учетных данных), и только после нее фаза B.

В плане есть пробел, который надо закрыть в v2 (находка 1 ниже): учетные данные Codex внутри контейнера по умолчанию доступны командам, которые выбирает модель. Есть и противоречие, из-за которого план в нынешнем виде, скорее всего, остановится на шаге 4 (находка 2): песочница Codex, скорее всего, не сможет создать namespace в этом же контейнере.

## Что прочитано и на каком коде

- План v1 полностью. Verdict v2 из #1162 (файл `verdict.md`, SHA-256 `fbd16de1…a3ba5a`), его ограничения перенесены. Факты оркестратора от 17.11 02:53 UTC — из тела #1210: сама #1157 мне не видна.
- Код Hornhoof на закрепленном `f4fb7eff1840c17bacd6826c109e341a35d076ba` (origin/main; тот же SHA, что в v2), через `git show`, без checkout и запуска. В turn-31 `359c2efa` из этих файлов изменены `bridge.ts`, `runner.ts` и `credentials.ts` (токен вложений через мост, приватность вывода хода). Выводы ниже это не меняет.
- Официальная документация Codex (developers.openai.com/codex перенаправляет на learn.chatgpt.com/docs): sandboxing, agent-approvals-security, auth, config-reference, environment-variables, non-interactive-mode, developer-commands, agents-md. Цитаты ниже дословные. Где документ молчит, стоит NOT FOUND.
- На Маке ничего не запускал, ходы не трогал, значений секретов не читал.

### Опора в коде (f4fb7eff)

- Папка агента `/data/work/agents/<ключ>` (`apps/node/src/runner.ts:112`). Права 0700 у пользователя тарифа (`isolation.ts:63-69`). Один UID на подписку (`isolation.ts:18-35`, первый UID 20000). По фактам оркестратора, в 606af686 агенты фактически идут под uid 1000, а папки принадлежат node, права 755. Отсюда вывод: `/data` нельзя монтировать даже частично.
- В окружении агента: `HH_BRIDGE`, `HH_ATTACH_URL`, `HH_ATTACH_PASS` (`terminal/programs.ts:42-48`); MCP Hornhoof и хуки `hh-hook` через `-c` (`programs.ts:99-104`); `CODEX_HOME` тарифа (`programs.ts:104`). Git-токен хода — `GIT_ASKPASS=/app/git-askpass` и `HH_GIT_PASSWORD` (`workspace.ts:10-12, 74-76`).
- Мост слушает 127.0.0.1 узла (`terminal/bridge.ts:86`). Из другого сетевого пространства он недостижим.
- Вход Codex тарифа — `auth.json` в home тарифа. Тариф Codex работает на одной машине за раз (`credentials.ts:7-11`).
- Контейнер тарифа: root, `CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID SYS_PTRACE`, `apparmor=unconfined`, `--restart unless-stopped`, без `--memory`, `--cpus`, `--pids-limit` (`scripts/install.sh:603-605`). Это источник риска общего OOM, не новый контейнер.
- Наш собственный запуск `codex exec` уже держится принципа «граница — контейнер»: «The container is the sandbox, so Codex's own approvals and sandbox are off» (`providers/codex.ts:33-34`).

## Ответы на шесть вопросов

### 1. Чужие папки, окружение, адреса моста, git-токены — закрыто при условиях

| Канал в 606af686 | Чем закрывает новый контейнер | Условие |
|---|---|---|
| `/data/work/agents/*` (755, uid 1000) | `/data` не монтируется | Никаких `-v`/`--mount`, кроме `/input` RO и tmpfs; `docker inspect … .Mounts` до старта |
| `/proc/PID/environ` чужих агентов | свое PID-пространство | Без `--pid=host`/`container:` |
| `HH_BRIDGE` (127.0.0.1 узла) | свое сетевое пространство | Без `--network host`/`container:`; во внутренней сети только сам review и шлюз |
| `HH_GIT_PASSWORD`, `/app/git-askpass` | нет в окружении и образе | Окружение задано списком; образ не узловой Hornhoof (в узловом есть `/app/git-askpass` и `hh-*`) |
| MCP Hornhoof, `hh-hook` | нет в новом CODEX_HOME | Свой config.toml без `mcp_servers`, `hooks`, `notify` |
| Сервер Hornhoof и службы Mac | шлюз выхода | Запрет `host.docker.internal`, `gateway.docker.internal`, 192.168.65.0/24 и частных диапазонов (п. 5) |

Совпадение UID с соседями без общих томов и без общего PID-пространства доступа не дает. Отдельное отображение UID (userns-remap) поэтому **не обязательно**. Требование плана «при отсутствии штатного способа — NOT_READY» можно ослабить до «записать». Достаточно числового UID:GID не 0, не 1000 и вне диапазона 20000+ из `isolation.ts`, без `--group-add`.

### 2. Вход и выход без обратного канала

- **Вход.** `/input` только RO. Снимок делает упаковщик отдельным шагом из объектов git точных SHA (например, `git archive`), не из рабочих деревьев агентов: там бывают неотслеживаемые файлы и секреты. Без `.git` remotes, hooks, submodules, ссылок наружу, `.env`, `.codex/` и `AGENTS.md` (см. находку 4). Manifest SHA-256 до и после. Копия для `codex review` — в tmpfs scratch. Для v1 — только искусственный пример Операций.
- **Выход.** Итог review — stdout и stderr процесса. Снимать через `docker logs <полный ID>` или `docker cp` из tmpfs до удаления. Никаких writable bind-томов на хост, общих томов или записей в `/data` и базу Hornhoof.
- Перед выдачей оператор ищет в тексте строку учетных данных и маркеры canary. Итог review — недоверенные данные: модель читала недоверенный diff. В задачу Hornhoof он кладется как файл-данные, не как указания.

### 3. Лимиты CPU и памяти — для review хватает, запас VM не доказан

- `--cpus 1`, `--memory 2g`, `--memory-swap 2g` (без подкачки), `--pids-limit 128`, `--restart no` достаточны для одного review искусственного diff: Codex — нативный бинарь, команды review короткие. Фактическое потребление — NOT_CHECKED, измерить в фазе A через `docker stats --no-stream`.
- **«1 GiB scratch» на томе не ограничить**: у local-тома Docker нет квоты. Scratch и `/tmp` — только tmpfs с `size=`. Страницы tmpfs учитываются в памяти контейнера, так что 2 GiB — общий потолок вместе со scratch. Предлагаю `/scratch` tmpfs 512m и `/tmp` tmpfs 64m.
- `--oom-score-adj 1000`: при общем OOM VM ядро первым завершит review, а не агентов. У контейнеров тарифа лимитов нет (`install.sh:603-605`), и общий OOM уже был (#1198). Свой лимит review не защищает VM от чужого роста.
- Правило старта вместо drain: непосредственно перед запуском свободная память VM не меньше 4 GiB (2 × лимит), подкачка занята меньше чем наполовину, за последние 24 часа не было OOM. Иначе не запускать. Отдельный drain ходов для изоляции не нужен: контейнер не касается узла и тарифа. Нужен только запас ресурсов. Запрет останавливать живые ходы сохраняется.

### 4. Учетные данные без общего auth — минимум и где хранить

По документации:
- «`ephemeral` keeps credentials in memory only for the current process».
- `CODEX_API_KEY` «Provides an API key to a non-interactive Codex process», используется в «Exec, review, …».
- `codex logout` — «clear the current credentials». Отзыв на сервере — NOT FOUND.
- Вход по коду устройства — «(beta)»; его надо включить в настройках безопасности ChatGPT.

Чтение файлов песочница не ограничивает (NOT FOUND, документ описывает только ограничение записи). Значит, учетные данные, видимые review UID, могут прочитать и команды модели.

Минимум: **одни учетные данные только для вызова модели Codex, на одну попытку**. Они не попадают в образ, том, задачу или журнал, живут в tmpfs `CODEX_HOME` (0600, review UID) или в окружении одного процесса codex и отзываются сразу после попытки. Два штатных пути:
- **A. Отдельный ключ API через `CODEX_API_KEY`** плюс `cli_auth_credentials_store = "ephemeral"`. Это новые учетные данные и, возможно, оплата: решает владелец подписки или CEO, план сам их не разрешает.
- **B. Вход по коду устройства владельца подписки** в свежий tmpfs `CODEX_HOME` (режим `file`). Это отдельная сессия, не копия auth.json тарифа. Копировать `auth.json` тарифа нельзя: Codex обновляет вход сам, и тариф работает на одной машине за раз (`credentials.ts:10-11`). Влияет ли вторая сессия на сессию тарифа — NOT_CHECKED. После попытки — `codex logout`, затем завершение сессии в настройках аккаунта: logout чистит только локальное.

В обоих путях обязательно (находка 1): `shell_environment_policy.inherit = "core"` и `shell_environment_policy.ignore_default_excludes = false`. По умолчанию переменные с KEY, SECRET, TOKEN в имени **передаются** командам: «Keep variables containing KEY, SECRET, or TOKEN before other filters run (default: true)». И проверка выхода на строку учетных данных.

Выбор между A и B — решение владельца подписки. Вопрос идет через главу Разработки.

### 5. Что закрепить до запуска

| Значение | Требование |
|---|---|
| Образ | Минимальный arm64 (codex, git; bwrap — только для варианта «а» ниже), не узловой образ Hornhoof. Закрепить `@sha256:` digest, версию codex и SHA-256 его бинаря. Установок во время review нет. |
| Пользователь | `--user <UID>:<GID>` числом, не 0, не 1000, не 20000+; без `--group-add`; образ не root |
| Файловая система | `--read-only`; `--tmpfs /scratch:size=512m,mode=0700,uid=<UID>,gid=<GID>`; `--tmpfs /tmp:size=64m,noexec,nosuid,nodev`; `/input` RO; других томов нет |
| Права | `--cap-drop ALL`, `--security-opt no-new-privileges`; seccomp по умолчанию (без `seccomp=`); нет `--privileged`, `--device`, `apparmor=unconfined`; нет docker socket |
| Пространства | Без `--pid`, `--ipc`, `--uts`, `--network host`/`container:`; `--init` |
| Ресурсы | `--cpus 1 --memory 2g --memory-swap 2g --pids-limit 128 --oom-score-adj 1000 --restart no`; таймаут 10 мин снаружи (`timeout` у исполнителя), затем `docker stop` по полному ID |
| Окружение | Только списком: `HOME=/scratch/home`, `CODEX_HOME=/scratch/codex`, `PATH`, `LANG`, при варианте A — `CODEX_API_KEY`. Ни `--env-file` родителя, ни `HH_*`, ни `GIT_ASKPASS` |
| config.toml Codex | Без `mcp_servers`, `hooks`, `notify`; `plugins._default.enabled = false`; `shell_environment_policy` как в п. 4; `projects."/scratch/review".trust_level = "untrusted"`; модель и effort — назначенные; `cli_auth_credentials_store` по выбранному пути. Файл с SHA-256 |
| Сеть, фаза A | `--network none` |
| Сеть, фаза B | Своя `docker network create --internal` (IPv6 выключен), в ней только review и шлюз. Шлюз пускает только к хостам Codex, остальное запрещает и пишет в журнал. Запрет `host.docker.internal`, `gateway.docker.internal`, 192.168.65.0/24, 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, IPv6 ULA и link-local. Проверка IP после DNS (против rebinding) и после переадресаций |
| Хосты Codex | В документации списка нет (NOT FOUND). Кандидаты `api.openai.com`, `chatgpt.com`, `auth.openai.com` — только предположение; подтвердить по журналу шлюза в фазе B, лишнее не открывать |

### 6. Проверка на безопасном примере и откат

План это уже содержит. Добавить:
- **Фаза A**, без сети и без учетных данных:
  - `docker inspect` выбранных полей против таблицы выше.
  - Внутри контейнера: `id`, `/proc/self/status` (Uid, Gid, Groups, CapEff, NoNewPrivs, Seccomp), `findmnt`, `ls /proc` (видны только свои PID).
  - Маркер canary вне scratch недоступен; запись в `/input` и в rootfs отказана.
  - `codex --version` и SHA-256 бинаря; список MCP пуст (команда по `codex mcp --help` закрепленной версии).
  - Пробник песочницы: команда `codex sandbox` (точная форма по `codex sandbox --help` закрепленной версии) с безвредной командой, полный вывод и exit. Плюс отказ записи вне рабочей папки внутри пробника.
- **Фаза B**: отказы шлюза к запрещенным адресам по согласованному списку (без сканирования служб). Затем ровно один `codex review` искусственного diff. Exit записывается сразу после процесса, без `head` или `tee`.
- **Откат**: остановить и удалить только записанные полные ID (контейнер review, шлюз, внутренняя сеть); tmpfs исчезает с контейнером. Отозвать учетные данные (ключ API или сессию; `codex logout` недостаточно). Сравнить `docker inspect` 606af686 до и после. Никаких `prune`, `pkill` или пересоздания тарифа.

## Находки к плану

1. **Высокая. Учетные данные доступны командам модели.** Чтение песочница не ограничивает (NOT FOUND в документации). По умолчанию `ignore_default_excludes = true` оставляет переменные с KEY, SECRET, TOKEN в окружении команд. Процессы одного UID внутри контейнера могут читать `/proc/<pid codex>/environ`. Сценарий: инструкция в diff заставляет команду напечатать `auth.json` или ключ, и они уходят в текст review, а оттуда в задачи и журналы. Условия: настройка окружения из п. 4, учетные данные одной попытки, проверка выхода на строку учетных данных, отзыв после попытки. Полностью исключить чтение изнутри нельзя. Поэтому отзыв обязателен всегда, даже при чистом выходе.
2. **Высокая для исполнимости. Песочница Codex против seccomp по умолчанию.** Документация: «the sandbox may not work if the host or container configuration blocks the namespace, setuid `bwrap`, or `seccomp` operations that Codex needs». Профиль seccomp Docker по умолчанию (moby) с `--cap-drop ALL` пускает `unshare` и `clone` с флагами namespace только при `CAP_SYS_ADMIN`, то есть не дает создать user namespace, а `no-new-privileges` выключает setuid `bwrap`. Это тот же отказ, что в 606af686. Что делает Codex при отказе — только «startup warning», fail-closed — NOT FOUND. Значит, шаг 4 плана, скорее всего, даст BLOCKED. Предупреждение или ошибка песочницы — остановка, а не повод продолжать. Выходы:
   - **а) Свой seccomp-профиль**, разрешающий `unshare`/`clone` с `CLONE_NEWUSER`. Для этой VM **не рекомендую**: user namespace расширяет поверхность ядра в VM, где живут все контейнеры тарифов.
   - **б) Режим, который документация называет для контейнеров**: «configure your Docker container to provide the isolation you need, then run `codex` with `--sandbox danger-full-access`». Внутри этого одноразового контейнера, при всех границах таблицы и выходе только через шлюз. Так же устроен наш `providers/codex.ts:33`. По сравнению с «а» команды модели теряют только сетевой запрет Codex, а его заменяет шлюз. Запрет v2 касался общего контейнера тарифа и сюда не переносится.

   Сейчас план запрещает danger-full-access, поэтому вариант «б» — только через v2 плана Операций и новую проверку Security. До этого допустим лишь вариант с песочницей Codex, если пробник фазы A пройдет на seccomp по умолчанию.
3. **Средняя. Квота scratch.** «1 GiB scratch» на томе не обеспечивается. Решение — tmpfs с `size=` внутри общего лимита памяти (п. 3).
4. **Средняя. AGENTS.md читается всегда.** «Codex reads `AGENTS.md` files before doing any work», выключателя нет (NOT FOUND). Неуказанный проект: загружает ли он свой `.codex/` — NOT FOUND. Условие: в снимке нет `AGENTS.md` и `.codex/`, CODEX_HOME свежий, проект явно `untrusted`. Для будущих продуктовых diff `AGENTS.md` нашего репозитория станет указаниями для review — это решать отдельно, в v1 не входит.
5. **Средняя. Сеть Docker Desktop.** Встроенный DNS резолвит `host.docker.internal` и имена контейнеров той же сети, а хост VM доступен по 192.168.65.0/24. Поэтому во внутренней сети только review и шлюз, а запреты из п. 5 — в правилах шлюза, не в переменной `HTTPS_PROXY`. Поддержка `HTTPS_PROXY` в документации не найдена. Без маршрута наружу запросы просто не пройдут — это безопасный отказ.
6. **Низкая. Образ.** Узловой образ Hornhoof тянет `/app/git-askpass` и `hh-*`. Нужен минимальный образ без настроек git credential.
7. **Низкая. Drain.** Для изоляции не нужен; его место занимает правило запаса ресурсов (п. 3).

## Чего нельзя

- Монтировать `/data`, home или `CODEX_HOME` тарифа, docker socket, SSH-agent, `/proc` хоста; копировать `auth.json` или окружение тарифа.
- `--privileged`, `SYS_ADMIN`, `seccomp=unconfined`, `apparmor=unconfined`, host-пространства, `--restart` кроме `no`.
- Менять 606af686, его seccomp, сеть или права; останавливать живые ходы.
- Запуск при свободной памяти VM меньше 4 GiB или при подкачке, занятой больше чем наполовину.
- Выдавать итог review наружу без проверки на учетные данные; считать exit 0 успехом без завершенного review.
- Продуктовый diff в v1; повтор попытки без нового решения.
- Новые аккаунты или оплату без решения владельца подписки.

## NOT_CHECKED и команды только для чтения для Операций

Не проверено мной: фактический образ и его digest, версия codex на Маке, запас памяти VM, сети Docker Desktop, поведение Codex при отказе песочницы, хосты Codex, влияние второй сессии на тариф.

Только чтение, на Docker-хосте Мака, без вывода Env и Cmd:

```sh
docker info --format '{{.ServerVersion}} {{.OperatingSystem}} {{.KernelVersion}} cpus={{.NCPU}} mem={{.MemTotal}} cgroup={{.CgroupVersion}} sec={{json .SecurityOptions}}'
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}'
docker network ls --format '{{.ID}} {{.Name}} {{.Driver}} internal={{.Internal}} ipv6={{.IPv6}}'
docker network inspect bridge --format '{{json .IPAM.Config}}'
docker inspect --format 'id={{.Id}} user={{json .Config.User}} mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{json .HostConfig.PidsLimit}} oom={{.HostConfig.OomScoreAdj}} restart={{.HostConfig.RestartPolicy.Name}}' 038c67748414
docker image inspect <кандидат образа> --format '{{.Id}} {{json .RepoDigests}} {{.Architecture}} user={{json .Config.User}}'
```

## Пределы этого вердикта

Это вердикт по архитектуре и условиям, а не runtime PASS. Изменен только этот документ. Тестов, сетевых проб и запуска контейнеров не было. Восстановление review — NOT_CHECKED.
