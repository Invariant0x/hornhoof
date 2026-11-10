# Network Phase 1, Plan 13: The Lab, the Real Run and the Series' End, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the series built is told to people and proved. The guide says, in plain words and in the screens'
own words, what the owner sees on several machines; `SECURITY.md` and the README say what ships and nothing it does
not. The lab grows to the spec's last missing parts: five machines, joins from 2 to 5 and back, `tc netem`, a stepped
clock and a real frps. Then, outside this build, the lab runs, the relay is deployed at night, one rehearsal passes,
the real run on Ivan's Debian and Mac gives its timings and screenshots with no confirmed write lost, and the series
merges into main once.

**Architecture:** Two kinds of task. Tasks 1 to 8 change no behavior but one line of text and run where the series is
built: a test (`apps/web/test/guide-words.test.ts`) holds a table of the screens' words, English and Russian, and
fails until each guide page names them as `en.ts` and `ru.ts` do. Tasks 9 to 17 run elsewhere: lab code written and
type-checked here, with its pure parts tested here (Tasks 9 to 12), then David AI's and Ivan's steps in the order the
series needs: the lab, the relay, the rehearsal, the real run, the merge (Tasks 13 to 17).

**Tech Stack:** Markdown for the guide; TypeScript on Node 22 and vitest, with `npm run test:lab` on Docker-in-Docker
machines (`docker:28-dind`), `tc netem` from `iproute2`, `libfaketime` in a lab-only Postgres image; Python 3.12 with
the real frps 0.71.1 and Caddy 2.11 in a lab-only relay image.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` section 12's lab and real bullets (spec:1166-1175),
section 2 (what the owner sees), section 4 (each failure's row), section 10 ("A stolen machine"), section 11 ("It must
pass the lab and the real tests of section 12 with no confirmed write lost"). Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`, plan 13's entry and "The real order". The audit
`network-build/runs/plan-audit.md`, section 4. Parked here by other plans: p1:1023-1031 (addendum A1's deploy),
p9c:1637-1640 (addendum A2's deploy), each plan's closing line "The rehearsal, the merge into main, Ivan's Updates and
the worktree's close are done once, for the whole series, at its end", p5b:240 ("tc netem and five machines", which
the ledger's ruling moved here from plan 9), p7's Task A1 (its deploy).

**Who does what.** Each task's first line names its kind, of two:
- **Runs in this build** (Tasks 1 to 8): a writer writes it, tests first, and runs its **Done when**, one task at a
  time; the lead reviews it. Hand the writer this plan from the top to the end of Review Focus, plus that one task.
- **Written here, run elsewhere** (Tasks 9 to 17): it needs Docker, root tools, the droplet or Ivan's machines. In
  Tasks 9 to 12 a writer writes the code and its pure tests and runs what **Done when** gives for here, and David AI
  runs the scenario on a machine with Docker to spare, fixing what it finds, each fix with its failing test first.
  Tasks 13 to 17 are steps alone, written in this plan, and each says whether David AI or Ivan takes it. No writer and
  no lead of this build runs them; a writer handed one stops and reports.

**One repository, and the relay's.** Hornhoof, the `network` worktree on its branch `network`, after plan 11b's last
task is committed there; the relay repo where a task says so.

**Handed over** (on the `network` branch before this plan starts; none of it is shipped):
- Plan 5b: `Lab`, `LabMachine`, `lab.ts`, `machine.Dockerfile`, `join.test.ts`, the disk check of its Task 9 Step 3,
  the Connect a machine panel, the card's "Open here" and "Make <host> a full machine of the company".
- Plan 7: `Lab.remove`, `Lab.add`, `steps.ts` (`installServer`, `setUp`, `joinWorker`), `guide/backups.md`. Plan 8:
  the merge task, `MergeCard` and that page's "What came after a restore".
- Plan 9: `relay()`, `startWriter`, `checkRows`, `Machines.tsx`'s copy lines and `leftAt`. Plan 9b: `PUT
  /api/machines/:id/priority`, the Priority part's strings. Plan 9c: `edge()`, `POST /api/machines/:id/move`,
  `machines.move`.
- Plan 10: `cut`, `mend`, `leaderOf`, `Written`, `confirmedOf`, `lateConfirms`, the switch word, `switch.*`,
  `switched.*`, `question.*`. Plan 11: `homes`, `heal`, `relayCut`, `internet`, `internetStub`, `playRelay`,
  `relay()`'s `down` and `up`, `split.*`. Plan 11b: `here.*`, `task.away`, the `saved/...` and `@` branches.
- The relay repo: `relay/test/harness.py`'s `Stack(tmp, caddy=True)`, `Stack.https`, `frp.sh`, `caddy.sh`, addenda A1
  and A2, plan 7's Task A1.
- Where the branch's code differs from these names or strings, the writer uses the code's, and says so in its report.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф», and a hostname
  as the subject takes «Машина» before it, so the feminine verbs agree.
- Commits only with the identity CLAUDE.md gives, no Co-Authored-By, no "Generated with" lines; messages are plain
  sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
  In this build writers do not commit: the lead does, after review (`network-build/briefs/build-rulings.md`).
- Nothing private in either repo or in a guide page: no droplet IP, no hostname but hornhoof.org and names under it,
  no key, token, ssh config or certificate file, no company's link name, no person's address. Guide pages use `acme`,
  Debian, Mac and rack-02, as the spec does.
- No new npm dependency. No migration. No change to what a screen does but Task 7's one line.
- Nothing that makes Ivan type commands, except the one install command a machine has always needed to join (spec
  section 1). A guide page that tells a person to type anything else is a bug, but for what the page already says
  today.
- Tests first. From `apps/web`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/server` the
  same. The whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`.
  Types: `npx tsc -p apps/web/tsconfig.json --noEmit`, `npx tsc -p apps/server/tsconfig.json --noEmit` and `npm run
  typecheck:tests`, each printing nothing. In this build every test run goes through `network-build/light.sh` (a few
  tests) or `network-build/heavy.sh` (a whole suite). Never run prettier.
- In this build: no Docker, no `tc`, no `iptables`, no sudo, nothing on the droplet, no push, no merge. `npm run
  test:lab` and `npm run test:real` never run here.
- In a lab run: `tc`, `iptables` and clock files act only inside a lab machine's own container, never on the host
  running the lab. A lab never changes a kernel's clock (`date -s` or the like): a Docker-in-Docker machine shares the
  kernel with everything else on that host.
- Before a lab run: `df -h /` and `docker system df`; clean only build cache and `hornhoof-lab/*` images, never a
  volume.

## Rulings made while planning

1. **What this plan takes.** Overview's plan 13 entry, spec section 12's lab and real bullets, the audit's section 4,
   and what the plans parked at the series' end. It adds no feature. Fixes the lab or the real run finds go into the
   plan and test file that owns the code, each with its failing test first.
2. **The guide stays in English, and names the screens' Russian words.** `AGENTS.md`: repository text is in English;
   every screen ships in both languages; no page of the app shows the guide. A person on a Russian screen looks for
   the Russian word, so the first time a page names a screen's word it writes it as `"Move the server here"
   («Перенести сервер сюда»)`, then English only. Cost if wrong: a little more text on a page, removed by one edit.
3. **A test keeps the pages true to the screens.** `apps/web/test/guide-words.test.ts` has one row per word a page
   names, and reads `en.ts`, `ru.ts` and the page as text. A word with a value in it is written with that value in
   braces (`Moving the company to {Mac}.`): the page must hold it without the braces, the language file must hold each
   part between them. It imports no message object, so no key name is pinned and a reworded string fails here, where
   someone sees it. Cost if wrong: a row to fix when a string changes on purpose.
4. **One new page, `guide/network.md`, and small edits elsewhere.** Today a person asks "what happens when a machine
   stops?", and six plans answer. So one page tells the whole of it, and the other pages link to it and change only
   what has become untrue. Backups stay on plan 7's page.
5. **What the lab bullet still lacks** (the audit named the first three; reading the plans added the last two):

   | Spec:1166-1171 | Where it is | This plan |
   |---|---|---|
   | 5 machines | plan 11's Task 9 has 4 | Tasks 9, 10 |
   | joins from 2 to 5 and back | plan 5b, 9: 2 and 3 only | Task 10 |
   | `tc netem` | nowhere | Tasks 9, 10 |
   | a stepped clock for a lagging VM | nowhere; plan 10 has only the table row (p10:691) | Tasks 9, 11 |
   | a local frps with the contract | nowhere: "No frps runs in the lab" (p9:1846), the test plays frps | Task 12 |
   | iptables, `docker pause` | plans 9, 10, 11 | none |
   | the CEO reordering 3 data machines | plan 9b's Task 8 (a pin among m1, m2, m3) | none |
   | number 1 cut off and coming back; the leader and its sync copy stopped together | plan 10's Task 11 | none |
   | a 2 and 3 split; three homes with the relay down; a split side meeting a newer leader | plan 11's Task 9 | none |
   | writer, checker, overlap checker | plans 9 and 10 | used here |

6. **The ranking's reorder is not forced by `netem`** (overview: "the ranking reordering 3 data machines"; spec: "the
   CEO reordering"). The spec binds, and plan 9b's lab does that. The score reads a day's median of its round trips
   (p9b ruling 2), which an hour's `netem` does not move. Faking the measures would test the fake. So the score stays
   with plan 9b's table tests and the real run shows the numbers on real machines. Cost if wrong: a ranking bug that
   only real measures show is found in the real run, not in the lab.
7. **`netem` shows what only a slow or lossy link shows.** A copy over a 1500 ms link stops being sync and comes back
   (spec 3.7's "commits under 1 MB waited over 1 s for 5 s", "within 1 s for 30 s"). A lossy link never moves the
   server. A 20 Mbit/s link makes "Move the server here" on number 4 wait for its copy with a moving percent.
8. **The stepped clock.** A real VM's sleep stops both clocks, then the wall clock lags; `docker pause` leaves the
   clocks running, so a keeper sees a late tick and fences at once, and fence 3 is never reached. So the lab shifts
   both clocks of that machine by the length of the pause, while it is paused: the keeper by `--require lab-clock.cjs`
   (the image is Alpine, its `Date` and `performance.now()` are what the keeper reads), and `db` by `libfaketime` in a
   lab-only image (Debian, what `clock_timestamp()` reads). Nothing in the product changes, and no kernel clock moves.
   Cost if wrong: harness work when `libfaketime` misbehaves under Postgres. The fallback is to leave the scenario out
   and report that fence 3 is shown only by plan 10's table and plan 9's real pairs; the lead rules on it then.
9. **A real frps in the lab, in one scenario.** Until now Hornhoof's frpc settings meet a real frps only in the
   rehearsal. One scenario runs the relay repo's own `Stack` in a container, with Caddy and frps, and a machine's
   keeper trusting its test CA. Hornhoof's repository keeps none of the edge's internals (overview decision 1): the
   image's Dockerfile and its entry live in the relay repo, and the scenario is skipped with one line unless
   `HORNHOOF_EDGE_DIR` names that repo. `ACME_DIRECTORY=off` there, so its links stay in http mode; plan 1b's Pebble
   tests prove the certificate, and the relay's own tests prove passthrough. Cost if wrong: an https-mode fault
   between frps and the keeper shows first in the rehearsal.
10. **Lab scenarios are written before their first red.** CLAUDE.md asks for the failing test first; a scenario that
    cannot run here gets its first red from David AI, and the ledger marks it not run (QUESTIONS.md item 4).
    Everything in it that is pure goes test first here. Cost if wrong: a typo costs David AI one lab run.
11. **The order at the end.** The lab, then the relay at night (a deployed relay is what plan 2 and later rest on),
    then the migrations numbered again, the rehearsal, the real run on a branch build, and only then the one merge.
    The spec wants the real run passed before phase 1 counts as done, and an Update reaches every company, so the
    merge comes last. Cost if wrong: none; each step is only later.
12. **The removed plan 12's texts.** `notes/ops/going-public.md`'s list of texts written ahead of the code is not on
    this machine. Task 7 therefore checks `SECURITY.md` and the README line by line against what the plans ship, which
    does not need that list; Task 17 has David AI read the list once on the Mac. Cost if wrong: a line the list names
    and this check missed, caught there.
13. **A stolen machine's FileVault or LUKS line** (spec section 10: "recommends FileVault or LUKS"). No plan has it;
    plan 9's `leftAt` line stops at the company secret and API keys (p9:1797). It joins that line (Task 7). It is
    advice, on the card that says the machine left. Cost if wrong: one sentence.
14. **Power, Wi-Fi and routers are Ivan's.** The real run's physical steps stop whatever else runs on those machines. David AI tells Ivan what will stop before each one, and
    Ivan picks the moment or leaves the step out; a step left out is written in the result as not done, never as
    passed.

## Review Focus

1. A page that says what the screen does not: a button's name no language file holds, a Russian word that is not
   `ru.ts`'s, a behavior the code changed after the plan. Tests in Task 1 (`names each word as the screens do`) and
   each page's rows.
2. A page or a public text that promises too much: "nothing is ever lost" without the limit of a change only one disk
   holds, voting, "Voter", a role name no screen has. Tests in Task 1 (`says the honest limit`) and Task 7 (`says no
   more than ships`).
3. A guide that makes a person type: a command for what a click does. Test in Task 1 (`asks nobody to type on the
   network page`); the reviewer reads each new section for it.
4. A lab step that reaches past the lab: `tc`, `iptables` or a clock on the host, a kernel clock changed, `docker
   stop` of something without the lab's label, a real company or hornhoof.org in a scenario. Tests in Task 9
   (`netemArgs` takes no device from a caller, `refuses what is out of range`) and Task 12 (`names only the lab's
   hosts`); the reviewer reads each scenario for it.
5. A real-run step taken on the wrong company, or a result that hides a failure: a confirmed write missing, a step
   left out and written as passed, a switch timed from the wrong moment. Test in Task 9 (`counts a gap as a switch`,
   `says a missing write by id`); Task 16's table has a line for each step, with "not done" as an answer.

---

### Task 1: The guide's words, and the page "One company on all your machines"

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** plan 11b's last task committed. **Done when:**
from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/guide-words.test.ts test/i18n.test.tsx` passes;
`npx tsc -p apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `guide/network.md`, `apps/web/test/guide-words.test.ts`, `apps/web/test/guide-words.ts` (the table)
- Modify: `guide/README.md`, `README.md` ("Learn more")

**Interfaces:**
- Produces:
  ```ts
  // apps/web/test/guide-words.ts
  export type GuideWord = { page: string; en: string; ru: string };   // page: a file name under guide/
  export const GUIDE_WORDS: readonly GuideWord[];                     // each task below adds its pages' rows
  export const literalParts: (word: string) => string[];              // what stands between {...}, empty parts left out
  export const onPage: (word: string) => string;                      // the word with its braces taken away
  ```
- `guide-words.test.ts`, reading with `readFileSync` `src/i18n/en.ts`, `src/i18n/ru.ts` and `../../guide/*.md`, with
  `\'` read as `'` in the language files:
  - `names each word as the screens do`: for each row, its page holds `onPage(en)` and `onPage(ru)`; `en.ts` holds
    each of `literalParts(en)`; `ru.ts` holds each of `literalParts(ru)`.
  - `reads a word's parts`: `literalParts('Moving the company to {Mac}. Your work is kept.')` is `['Moving the company
    to ', '. Your work is kept.']`; `onPage` of it has no brace; `literalParts('{a}{b}')` is `[]`.
  - `keeps the guide's Russian plain`: no page under `guide/` holds `ё`, an em dash (`\u2014` in the test),
    `компьютер` or `узел`, in any case.
  - `lists every page`: every `guide/*.md` but `README.md` is linked from `guide/README.md`, and ends with `[Back to
    the guide](README.md)`; `README.md`'s "Learn more" links `guide/network.md` and `guide/backups.md`.
  - `finds every link`: each relative `](x.md)` and `](x.md#y)` of `guide/*.md` names a file there or under the
    repository root, and `#y` a heading of it, by GitHub's rule (lowercase, spaces to `-`, other punctuation dropped).
  - `asks nobody to type on the network page`: `guide/network.md` has no code fence.
  - `says the honest limit`: `guide/network.md` holds `losing that disk loses those changes` and `never lost
    silently`.

**The page** `guide/network.md`, in the guide's voice: an "In short" line, a question for each heading, short
sentences. Each `"EN" («RU»)` below is one row of `GUIDE_WORDS`; on the page the Russian stands only at a word's first
mention.

- `# One company on all your machines`
- `> In short:` Your company runs on all your machines as one network. One machine holds the company server, and up to
  two more keep a full copy of the data. If that machine stops, a copy takes over within about a minute, at the same
  link, and nobody types anything.
- `## Where do I open the company?` On any machine of the company, at its `localhost`, as well as at the public link.
  Each card says the address: "Open here" («Открыть здесь»), `localhost:8081`. Other companies on that machine have
  their own port. A machine that cannot reach the server shows a page listing the machines where the company can be
  opened.
- `## Which machine does what?` The machine with number 1 holds the company server, and its card has the badge
  "Company server here" («Здесь сервер компании»). Numbers 2 and 3 keep a full copy of the data. Every other machine
  only works: it runs agents and tests, opens the company on its `localhost`, and holds no data and no company secret.
  Phones, and machines without Docker, get no number. The tab says it in one line: "{Debian} leads. {Mac} keeps a copy
  and takes over if {Debian} stops." («{Debian} ведет компанию. {Mac} хранит копию и возьмет сервер, если {Debian}
  остановится.»)
- `## What does the number on a card mean?` The row "Priority" («Приоритет») shows the number and one line on why,
  such as "The company server runs here" («Здесь работает сервер компании»), "Always online" («Всегда в сети») with
  "best connection to machine 1" («лучшая связь с машиной 1»), "Number set by hand" («Номер задан вручную»), "Gets a
  copy if one of the first three leaves" («Получит копию, если одна из первых трех уйдет») and "New: connected less
  than 3 days ago" («Новая: подключена меньше 3 дней назад»). "If machine 1 goes away, machine 2 takes the server,
  then 3." («Если машина 1 пропадет, сервер возьмет машина 2, за ней 3.») More exactly, it goes to the copy the server
  last named as keeping pace, which is the lowest number that does.
- `## How does Hornhoof pick the numbers?` Number 1 is where the server runs now, and a ranking never moves the
  server. The others are ranked by how much of the last 7 days they were online, then their connection to number 1 and
  to the internet, their disk, their memory and cores. A machine online 95% of the time or more never ranks below one
  that is not. Hornhoof ranks once a day, when a machine joins or leaves, and after the server moved. A machine passes
  the one above it only by more than 5 points, so two close machines do not swap every day. A machine connected less
  than 3 days ago ranks below the others. A machine ranked into the first three gets its copy first, and the one
  ranked out keeps its own until then, at most once a day.
- `## Can I set a number by hand?` Yes, the CEO can, on the card: "Automatically" («Автоматически»), "By hand"
  («Вручную») with a place, or "Does not take the server" («Не берет сервер»). The others rank around a place set by
  hand. Hornhoof refuses to keep out the machine with the server ("Move the server to another machine first." «Сначала
  перенесите сервер на другую машину.») and the only up-to-date copy ("{Debian} holds the only up-to-date copy; give
  another machine a place first." «{Debian} хранит единственную актуальную копию; сначала дайте место другой
  машине.»).
- `## Which machines can keep a copy?` A computer with Docker, of the CEO or of someone who sees the whole company.
  Docker gets 4 GB of memory or more, free disk is at least three times the database plus 10 GB, and the disk saves
  quickly. A machine that cannot says why: "Cannot take the server" («Не может взять сервер») and, for example,
  "Docker here gets less than 4 GB of memory." («Docker здесь получает меньше 4 ГБ памяти.») To let a deputy's
  machines keep copies, give that person the whole company. A person who loses it: their machine stops holding the
  company's data at once, and sends back what it held when it next comes online.
- `## What do the copy lines mean?` A list: "Copy: up to date" («Копия: актуальна»); "Copy: being made, {40}%"
  («Копия: создается, {40}%»); "Copy: {3} min behind" («Копия: отстает на {3} мин»); "Copy: asleep since {23:40}"
  («Копия: спит с {23:40}»); "Copy: stopped: disk full" («Копия: остановлена: диск заполнен»). Then: when no copy is
  up to date, the tab says "Only {Debian} holds changes since {23:40}." («Только {Debian} хранит изменения с
  {23:40}.») Until a copy catches up, losing that disk loses those changes. It is the one limit on "nothing is lost".
- `## How do I move the server myself?` "Move the server here" («Перенести сервер сюда») on a numbered machine's card,
  the CEO's alone. It asks first: "Move the company server to {rack-02}? Hornhoof stops for a short while as it moves;
  your work is kept." («Перенести сервер компании на {rack-02}? Пока он переезжает, Hornhoof ненадолго остановится;
  ваша работа сохранится.») A machine with no copy gets one first: "{rack-02} takes the server once its copy is up to
  date ({40}%)" («{rack-02} возьмет сервер, как только ее копия станет актуальной ({40}%)»), and "Cancel the move"
  («Отменить перенос») stops it. The move itself takes about 10 seconds. If it cannot finish: "The server stayed on
  {Debian}: " («Сервер остался на {Debian}: ») and why. It is the only way the server moves while its machine runs.
- `## What happens when the machine with the server stops?` The page stays open. "Moving the company to {Mac}. Your
  work is kept. About a minute." («Компания переезжает на {Mac}. Ваша работа сохранена. Около минуты.») Requests wait
  instead of failing, and agents go on. Then: "Hornhoof runs on {Mac} now. {Debian} stopped answering at {14:02}."
  («Hornhoof теперь работает на {Mac}. Машина {Debian} перестала отвечать в {14:02}.») When Debian is back: "Copy:
  saving what it did while it led" («Копия: сохраняет то, что сделано, пока она держала сервер»), and once it has
  caught up, "{Debian} ran the server until {14:02} and is up to date again." («Машина {Debian} держала сервер до
  {14:02}, ее копия снова актуальна.») The server stays where it is, and moves back only when you press the button.
- `## When does Hornhoof ask me first?` A copy that may lack something asks, when its last word from the server is too
  old, or the server and the copy it named stop together: "{Debian} stopped answering at {03:12}. This {Mac} may not
  have what {Debian} did after {23:40}. That comes back when {Debian} does." («Машина {Debian} перестала отвечать в
  {03:12}. У {Mac} может не быть того, что машина {Debian} сделала после {23:40}. Это вернется вместе с {Debian}.»)
  "Go on from {23:40}" («Продолжить с {23:40}»), or "Wait for {Debian}" («Ждать {Debian}»). Under them: "Only if
  {Debian} is off. If {Debian} works too, both sides get changes; Hornhoof merges them later and the orchestrator asks
  you about real conflicts." («Только если машина {Debian} выключена. Если машина {Debian} тоже работает, изменения
  будут на обеих сторонах; Hornhoof потом сольет их, а оркестратор спросит вас о настоящих конфликтах.») Only the CEO
  answers this. A short outage of hornhoof.org can end in this question too, when the server dies in it.
- `## What if my machines lose sight of each other?` Each side with internet keeps working. "Lost {Mac} and
  hornhoof.org. Going on by itself in {1:40}; changes from both sides are merged later." («Нет связи с машиной {Mac} и
  hornhoof.org. Hornhoof продолжит сам через {1:40}; изменения обеих сторон потом сольются.») Then "Working apart from
  {Mac} since {14:02}." («Работаем отдельно от машины {Mac} с {14:02}.»), and on a side that was behind "This side has
  {Debian}'s changes up to {23:40} only." («На этой стороне есть изменения машины {Debian} только до {23:40}.») Agents
  go on. A task in progress stays with the side whose agent has it, and free tasks from before go out only on the side
  of the old server, so work is not done twice but for a rare case the merge shows. When they meet: "Back in touch
  with {Mac}; merging." («Снова есть связь с машиной {Mac}; изменения сливаются.») Records merge by themselves, code
  comes back as branches ([Repositories](repositories.md)), and real conflicts go to the orchestrator, who tells you
  ([The orchestrator](orchestrator.md)). A confirmed change may come back as a conflict, but is never lost silently.
- `## What if a machine has no internet?` It never goes on by itself. "This machine has no internet and cannot reach
  {Mac}, so it stopped taking changes. You can read everything." («У этой машины нет интернета и связи с машиной
  {Mac}, поэтому она перестала принимать изменения. Читать можно все.») Agents are not interrupted, and their work
  folders are saved as they are. The CEO may press "Go on here without {Mac}" («Продолжить здесь без машины {Mac}»),
  under the warning of the part above. It waits for the saving: "Going on here once the work is saved." («Продолжим
  здесь, как только работа сохранится.») Without it, the work moves to the side that leads.
- `## What if a disk fills up?` The card warns: "Disk {85}% full." («Диск заполнен на {85}%.») A full disk on the
  machine with the server moves it: "{Debian}'s disk is full; {Mac} leads." («Диск машины {Debian} заполнен; сервер
  теперь держит {Mac}.»)
- `## What does this rest on?` hornhoof.org breaks the tie: a name points to one machine, and that machine leads. It
  holds one record per name, whether a copy keeps up, and decides nothing else ([The link on the
  internet](public-link.md)). Machines in one home talk directly; between homes all their traffic goes through
  hornhoof.org, encrypted from one machine to the other.
- `[Back to the guide](README.md)`

`guide/README.md` gains, after "Machines and plans": `- [One company on all your machines](network.md): which machine
does what, what the numbers mean, what happens when a machine stops or machines lose sight of each other.` Its
orchestrator line's "also on the computer the server runs on" becomes "also on your machines". `README.md`'s "Learn
more" gains the same line with `guide/network.md`, and `- [Backups](guide/backups.md): what is saved and where, the
recovery file, and how to restore the company, also after losing its server.`

- [ ] **Step 1: Write the failing test and the table** with this page's rows.
- [ ] **Step 2: Run** Done when. Expected: FAIL: `names each word as the screens do` on `guide/network.md`, which does
  not exist. A row that fails because a language file words it otherwise: read the code; the page and the row take the
  code's word, and the report says so.
- [ ] **Step 3: Write the page** and the two lists.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Tell in one page what the owner sees on several machines, and test its words against the
  screens".

### Task 2: Machines and plans, and the free machines' page

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** Task 1's command
passes.

**Files:**
- Modify: `guide/machines-and-plans.md`, `guide/free-machines.md`, `apps/web/test/guide-words.ts` (the rows)

**Interfaces:** Consumes: Task 1's `GUIDE_WORDS`.

**`guide/machines-and-plans.md`** (line numbers as of plan 11b's head; find them by their text). Each `"EN" («RU»)` is
a row:
- The "Sign in once" part, the line "Each machine has a key of its own...": becomes "Each plan's node on a machine has
  a key of its own, kept on that machine. The sign-in is sealed to each of those keys, so Hornhoof stores it and
  passes it on without reading it. A machine you connect later gets it from one of your machines that has it, as soon
  as both are online." (Plan 5's addendum, as the lead rules.)
- "Can a machine join without a plan?": "It starts one container with nothing to sign in to." becomes "It starts the
  company's small core there, so the company opens on that machine's `localhost`, and one container with nothing to
  sign in to."
- New, after it, `## What does the command put on a machine?` The core: three small containers, in a folder of their
  own. No data and no company secret. Your own key: "Hornhoof makes your own key now, once. The command carries it to
  your machine, so that only you can open that machine to the orchestrator. Enter your password." («Hornhoof сейчас
  один раз создаст ваш личный ключ. Команда отнесет его на вашу машину, чтобы открыть эту машину оркестратору могли
  только вы. Введите пароль.») A machine that qualifies gets a number and a copy by itself ([One company on all your
  machines](network.md)). A machine that only works follows the server's build by itself, between its turns
  ([Updates](updates.md)).
- New, `## A Mac with its firewall on`: "If the company server runs on a Mac with its firewall on, the Mac may ask
  once whether Docker (com.docker.backend, or ssh with Colima) may take incoming connections: allow it, or this
  machine reaches the server only through hornhoof.org." («Если на машине сервера компании стоит macOS с включенным
  файрволом, macOS может один раз спросить, можно ли Docker (com.docker.backend, а с Colima ssh) принимать входящие
  подключения: разрешите, иначе эта машина будет связываться с сервером только через hornhoof.org.»)
- New, `## A machine that joined before`: a machine that carries only plans has its own small command once: "Make
  {Mac} a full machine of the company" («Сделать {Mac} полной машиной компании»). After that the company opens on its
  `localhost` and updates come by themselves.
- "What happens when I disconnect a machine?" gains: Disconnect cuts it off for good: its certificate and node keys
  stop working and it can no longer reach the company. To connect it again, get a new command. If it was stolen: "If
  it was stolen, its owner should also revoke its Claude sign-in at claude.ai, which stays valid for a year." («Если
  ее украли, владельцу нужно еще отозвать вход Claude на claude.ai: он действует год.») A machine that held the
  company's data still holds what it had: its card says "Stopped holding the company's data on" («Перестала хранить
  данные компании») and what to do about it, and the company's link gets a new key by itself; the banner asks for a
  new recovery file. The machine with the server cannot be disconnected: "{Debian} runs the company server. Move the
  server to another machine first." («На {Debian} работает сервер компании. Сначала перенесите сервер на другую
  машину.») Nor the machine the company was installed on: "The company was installed on {Debian}, so it cannot be
  disconnected." («Компания установлена на {Debian}, поэтому эту машину нельзя отключить.»)
- "Update or remove the nodes on a machine": first line gains "A machine with the core updates by itself. For a
  machine that carries only plans:".

**`guide/free-machines.md`**:
- "What does the Machines tab show?": the list's "its plans;" goes (the plans row left the cards with Step 0, overview
  discrepancy 9) and it gains "its number, its copy and where to open the company there ([One company on all your
  machines](network.md));" and "the tick "Keep company backups" («Хранить резервные копии компании»)
  ([Backups](backups.md));".

- [ ] **Step 1: Add the rows.**
- [ ] **Step 2: Run** Done when. Expected: FAIL on these pages' rows.
- [ ] **Step 3: Edit the pages.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in the guide what joining puts on a machine, what Disconnect does and what a card
  shows".

### Task 3: The orchestrator, and who sees what

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 2 committed. **Done when:** Task 1's command
passes.

**Files:**
- Modify: `guide/orchestrator.md`, `guide/departments-and-employees.md`, `apps/web/test/guide-words.ts`

**`guide/orchestrator.md`:**
- "In short" stays. "Can he change the database?" gains, at its end: "He sends only `SELECT`, `INSERT`, `UPDATE` and
  `DELETE`. Anything else, like `COMMIT`, `SET` or a function that could get around Hornhoof's checks, gets a plain
  refusal. A call can take 5 seconds."
- "Can he fix the computer the server runs on?" becomes `## Can he fix one of my machines?` Some trouble sits outside
  Hornhoof, in Docker or in the system. He never asks you to type commands for it; he asks for access to a named
  machine. 1. A card says it: "The orchestrator asks for access to {Debian}" («Оркестратор просит доступ к машине
  {Debian}»). 2. "Open access to {Debian} for a day" («Открыть доступ к машине {Debian} на сутки») gives it to him. 3.
  For a day he runs commands as root on that machine, and each one shows in his window: "Access to {Debian} is open
  until {18:20}." («Доступ к машине {Debian} открыт до {18:20}.») 4. It closes by itself after a day, or when you
  close it. Then: only that machine's owner opens it, from any screen; nobody else does, the CEO included, and the CEO
  opens it for the CEO's own machines. On a machine that holds the data: "Open access lets the orchestrator change
  anything on {Debian}, the company's data included." («Открытый доступ позволяет оркестратору изменить на машине
  {Debian} что угодно, включая данные компании.») On a Mac: "On a Mac this reaches Docker's Linux system, not macOS
  itself." («На Mac этот доступ открывает только Linux внутри Docker, а не саму macOS.») When you came through a
  machine's `localhost`, the account menu offers "Give the orchestrator access to this machine ({Mac})" («Дать
  оркестратору доступ к этой машине ({Mac})»). A machine joined before your key existed says: "{Mac} does not hold
  your key yet. Run a new command from Connect a machine on it: it takes your key only from there." («Машина {Mac}
  пока не хранит ваш ключ. Выполните на ней новую команду из «Подключить машину»: ключ она берет только оттуда.») The
  sentences "Only the CEO opens and closes it" and "The computer here is the one the server runs on" go.
- New, before "What stays with people?", `## What does he do after machines worked apart?` When two sides of the
  company meet, or a restore brings an old database back, what Hornhoof cannot prove by itself goes to him as one
  task, with both values. He picks a side or writes a merged value, one at a time or in bulk, wakes the agents whose
  tasks changed, and tells you what was kept and what he decided. Conflicts about people, access, plans or machines
  are yours, on a card: "Keep here" («Оставить здесь»), "Take there" («Взять оттуда»), with "Keep all here" («Оставить
  все здесь») and "Take all from there" («Взять все оттуда») for a whole table. Until someone picks, the value on the
  leading machine stays.

**`guide/departments-and-employees.md`**, "Who sees which departments?" gains: "Copies of the company's data go only
to machines of the CEO and of people who see the whole company ([One company on all your machines](network.md)).
Taking the whole company away from someone makes their machine stop holding the data at once."

- [ ] **Step 1: Add the rows.**
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Edit the pages.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in the guide that computer access is per machine and its owner's, and what the
  orchestrator does after a merge".

### Task 4: Updates and the install

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 3 committed. **Done when:** Task 1's command
passes.

**Files:**
- Modify: `guide/updates.md`, `guide/install.md`, `apps/web/test/guide-words.ts`

**`guide/updates.md`:**
- "In short" gains: "One Update moves every machine."
- "What does the updater do?", step 2: "It saves the database." becomes "It saves the database, also as an encrypted
  backup ([Backups](backups.md))."
- New, after it, `## What happens on several machines?` One click moves them all. 1. Every online machine downloads
  the build, and nothing stops. 2. Hornhoof asks the copies not to take over meanwhile; the progress says "asking the
  copies to wait" («прошу копии подождать»). 3. Changes stop: "Maintenance: Hornhoof is installing the update and
  takes no changes until it ends." («Обслуживание: Hornhoof ставит обновление и не принимает изменений, пока оно не
  закончится.») Requests wait for a while. 4. The database is saved only once every online copy holds every change. 5.
  The machine with the server installs. If the build changed the database's tables, each copy then makes itself again
  from it, and for that time no copy is up to date: the Machines tab says so. 6. Machines that only work follow one at
  a time, each between its turns. A machine that was offline moves to the same build before it joins again.
- New, `## When does an update wait?` It starts only when one machine leads and the company is not working apart. It
  never waits for a copy that is offline. While the server moves: "The server is moving to {Mac}. Update once it
  moved." («Сервер переезжает на {Mac}. Обновите, когда он переедет.») And the other way round: "Hornhoof is updating.
  Move the server once the update ended." («Hornhoof обновляется. Перенесите сервер, когда обновление закончится.»)
- New, `## What if the machine with the server dies during an update?` The copies keep their word until the time it
  gave, up to 15 minutes, then the usual rule holds; when the update was changing the tables, the CEO is asked ([One
  company on all your machines](network.md#when-does-hornhoof-ask-me-first)).

**`guide/install.md`:**
- New, after "How do I update it?", `## Lost the server? Restore instead of starting new`: a fresh install's setup
  screen offers "Restore from a recovery file" («Восстановить из файла восстановления»). [Backups](backups.md) says
  how.
- "Run several companies on one computer" keeps plan 2's text. New, after it, `## Which ports does a company use on a
  machine?` Two: a web port from 8080, which opens the company on `localhost`, and a peer port from 8180, on which
  your machines talk to each other. The peer port is open to your local network, and takes only machines with a
  certificate from the company.
- "What in `.env` must I keep safe?" gains: "A machine that only works has none of these in its `.env`. A machine that
  keeps a copy has the first two, and a database password of its own." and "The recovery file you save in Settings
  opens the backups: keep it like a password too."

- [ ] **Step 1: Add the rows.**
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Edit the pages.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in the guide how one Update moves every machine, and which ports and secrets a machine
  holds".

### Task 5: Tasks and repositories, when a machine goes away

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 4 committed. **Done when:** Task 1's command
passes.

**Files:**
- Modify: `guide/tasks-and-turns.md`, `guide/repositories.md`, `apps/web/test/guide-words.ts`

**`guide/tasks-and-turns.md`:** new, after "What if an agent keeps breaking down?", `## What if an agent's machine
goes away?` The agent is never interrupted, and its work is not lost. While Hornhoof cannot reach the machine, the
task's card says "Work saved on {Debian} at {14:05}, not sent yet" («Работа сохранена на машине {Debian} в {14:05},
еще не отправлена»), and whoever gave the task out hears it once. If the agent pushed its branch, they may give the
task to another agent at once, who goes on from that branch. If not, the task waits up to 30 minutes for the machine,
then may go to another agent from what was last pushed. What the machine saved comes back as a branch when it returns.
If the old agent comes back meanwhile, its next tool call says where the task went, and it pushes its work and ends
its turn. While the company works apart, the task stays with its side ([One company on all your
machines](network.md)).

**`guide/repositories.md`:** new, before "Whose name goes on the commits?", `## Which branches appear by themselves?`
Two kinds, only when machines were cut off or worked apart; each goes through its task's gates.
`saved/<task>@<machine>-<time>`: a machine with no internet saves each agent's folder, untracked files too, without
touching it, and sends it as this branch once it can. `<branch>@<machine>`: while a machine works apart, a push that
would not fast-forward lands here, never forced, and the agent is told. The merge task lists them all, and the
orchestrator decides who takes each. A force push through something other than the agent's `git`, such as `gh api`,
can still overwrite a branch; GitHub keeps the overwritten commits only for a while.

- [ ] **Step 1: Add the rows.**
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Edit the pages.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in the guide what happens to a task and its branch when its machine goes away".

### Task 6: The link and backups, with copies

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 5 committed. **Done when:** Task 1's command
passes.

**Files:**
- Modify: `guide/public-link.md`, `guide/backups.md`, `apps/web/test/guide-words.ts`

**`guide/public-link.md`:**
- "What does hornhoof.org see?" gains: "For a company on several machines it also keeps which machine holds the link,
  and one record that says whether a copy keeps up and which machine holds it. It never sees the numbers on your
  cards, and picks no machine."
- New, after it, `## What if the machine with the link stops?` The same link goes on working: the machine that takes
  over takes the link too, with the same certificate, in about a minute ([One company on all your
  machines](network.md)).
- New, `## And a company with no link?` It keeps a hidden name at hornhoof.org, only so that its machines can tell
  which of them leads. Nobody can open it. Until it exists a card may say: "the company's hidden name at hornhoof.org
  is not made yet; Hornhoof makes it once hornhoof.org answers" («скрытое имя компании на hornhoof.org еще не создано;
  Hornhoof создаст его, как только hornhoof.org ответит»).

**`guide/backups.md`** (plan 7's page, with plan 8's part), new, before its "Back to the guide", `## With copies`: The
machines that hold the data can each open a backup; a machine that lost the whole company's scope can still open the
ones from while it was trusted, until holders roll them over, and none made after. Restoring runs on the machine that
leads; open it on another machine and you reach the same screen. After a restore every copy makes itself again, and
what its old database held and the restore lacks comes back first, as "What came after a restore" says. When the
link's key changes, because a machine that held the data left: "The public link changed, so the recovery file is out
of date. Save a new one." («Публичная ссылка изменилась, и файл восстановления устарел. Сохраните новый.»)

- [ ] **Step 1: Add the rows.**
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Edit the pages.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in the guide how the link follows the server, what a company with no link keeps, and
  what copies change for backups".

### Task 7: `SECURITY.md`, the README and the stolen machine's line

**Kind: runs in this build.**

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from `apps/web`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/guide-words.test.ts test/Machines.test.tsx test/i18n.test.tsx`
passes; `npx tsc -p apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `SECURITY.md`, `README.md`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts` (`machines.copy.leftAt`),
  `apps/web/test/guide-words.test.ts`
- Test: `apps/web/test/guide-words.test.ts`, `apps/web/test/Machines.test.tsx`

**Interfaces:** `guide-words.test.ts` gains `says no more than ships`:
- `SECURITY.md` and `README.md` hold neither `Voter` nor `by vote` (spec 3.5), `may hold the data` (plan 7's ruling 3)
  nor `ends at hornhoof.org. It opens each request` (plan 1b);
- `README.md` holds `Priority`, `Move the server here` and `guide/network.md`; `SECURITY.md` holds `FileVault`, `goes
  on by itself after 2 minutes` and `the company's data included`.

**The check, line by line.** What each line says against what the series ships; a line not named here was read and
stands:

| Line at this plan's writing (find it by its text: plans 1b, 2 and 7 add lines) | Says | Ships | Becomes |
|---|---|---|---|
| `SECURITY.md:8-9`, `:11-12` | up to three machines, a copy takes over, peer port takes only certificates | plans 5, 5b, 9, 10 | stands |
| `SECURITY.md:10` | backups, "may hold" | plan 7 corrected it | stands, as plan 7 wrote it |
| `SECURITY.md:27` | a sign-in is sealed to your machines; server and copies cannot open it | true with node keys, plan 5's addendum | stands |
| `SECURITY.md:31` | Disconnect takes its keys away | true, and not all of it | gains the sentences below |
| `SECURITY.md:43` | root only when the owner opens it | plan 6, and on a data machine more | gains the sentence below |
| `SECURITY.md:52` | what hornhoof.org keeps for a link | plan 1 keeps more: a visitor key's hash, the sync record's machine | becomes the text below |
| `SECURITY.md:53` | https ends at | plan 1b changed it | stands, as plan 1b wrote it |
| `SECURITY.md:55` | "Three or more machines that are always on choose the leader by vote" | voting was removed (spec 3.5) | that sentence becomes the text below |
| `README.md:103` | "Leader, Copy, Voter, or Worker" | no such names; numbers | its first sentence becomes the text below |
| `README.md:105` | sides merge | true | gains the sentence below |
| `README.md:101`, `:107`, `:111`, `:126-131`, `:182` | as they are | true | stand |

Texts, exactly:
- `SECURITY.md:31` gains: `A machine that held the company's data still holds what it had: its card says to change the
  company secret and the API keys, and to use disk encryption (FileVault on a Mac, LUKS on Linux) on the machines that
  hold the data. A stolen machine's Claude sign-in stays valid for a year until its owner revokes it at claude.ai.`
- `SECURITY.md:43` gains: `On a machine that holds the data, that means the company's data included: the card says so
  before anyone opens it.`
- `SECURITY.md:52`'s last sentence becomes: `For a company on several machines it also keeps which machine holds the
  link, a hash of the key those machines use to reach each other through it, and one record that says whether a copy
  keeps up and which machine holds it.`
- `SECURITY.md:55`'s last sentence becomes: `When machines reach neither hornhoof.org nor each other but still have
  internet, each side goes on by itself after 2 minutes, and Hornhoof merges the sides when they meet. A machine with
  no internet stops taking changes until its owner says otherwise.`
- `README.md:103`'s first sentence becomes: `Each machine that can hold the server gets a number on the Machines tab,
  in its "Priority" row, with one line on why: 1 is where the server runs now, and if it stops, the copy it named
  takes over. Hornhoof ranks the others by itself; the CEO may set a number by hand, keep a machine out, or press
  "Move the server here". Every other machine only does work.`
- `README.md:105` gains: `A machine with no internet stops taking changes, and you can still read everything.`
- `machines.copy.leftAt`, EN: `Stopped holding the company's data on <date>. If it may be in other hands, change the
  company secret and the API keys, and turn on disk encryption (FileVault on a Mac, LUKS on Linux) on the machines
  that hold the data.`; RU: `Перестала хранить данные компании <date>. Если она может быть в чужих руках, смените
  секрет компании и API-ключи и включите шифрование диска (FileVault на Mac, LUKS на Linux) на машинах, которые хранят
  данные.`

- [ ] **Step 1: Write failing tests.** `says no more than ships` above. `Machines.test.tsx`, `says what to do after a
  machine that held the data left`: a machine with `dataLeftAt`: its card holds `FileVault` and `LUKS`, in English and
  with `ru` in Russian `шифрование диска`.
- [ ] **Step 2: Run** Done when. Expected: FAIL on `Voter`, on `by vote`, and on `FileVault`.
- [ ] **Step 3: Edit the texts and the two strings.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say in the public texts what the series ships: no voting, numbers on the cards, and what a
  stolen machine leaves".

### Task 8: Everything that can run here

**Kind: runs in this build.**

**Repo:** the `network` worktree and the relay repo. **Starts from:** Tasks 1 to 7 committed and reviewed. **Done
when:** Steps 1 to 3 pass, and Step 4's list is in `QUESTIONS.md`.

- [ ] **Step 1: Hornhoof.** Through `heavy.sh`, from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > network-build/tmp/plan13-full.log 2>&1; tail -30 network-build/tmp/plan13-full.log` → all
  pass; the `tsc` commands and `npm run typecheck:tests` → no output.
- [ ] **Step 2: The relay repo.** Through `heavy.sh`, with Python 3.12 and 3.14 as the build rulings name them:
  `python3 -m unittest discover -s relay/test -v` → pass.
- [ ] **Step 3: Check the public-repo rule.** As plan 7's Task 11 Step 2, in both repositories, and `grep -rn
  "$(printf '\342\200\224')" guide SECURITY.md README.md` prints nothing.
- [ ] **Step 4: Say what has not run.** Add to `QUESTIONS.md` under item 4 one line per plan's task whose test needs
  Docker and is written but not run (the audit's section 5, with this plan's Tasks 10, 11 and 12), and point David AI
  to Tasks 13 to 17 here.

### Task 9: The lab's helpers: five machines, `netem`, the clock, the real run's writer

**Kind: written here, run elsewhere.** Writer: writes all of it; its pure tests run here. David AI: runs the machines'
parts through Tasks 10 and 11.

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8. **Done when:** from `apps/server`, as
plan 10's `overlap.test.ts` runs, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/lab/netem.test.ts
test/lab/lab-clock.test.ts test/lab/real-run.test.ts test/pins.test.ts` passes; `npx tsc -p apps/server/tsconfig.json
--noEmit` and `npm run typecheck:tests` print nothing. No Docker here.

**Files:**
- Create: `apps/server/test/lab/netem.ts`, `apps/server/test/lab/lab-clock.cjs`,
  `apps/server/test/lab/compose-lab.ts`, `apps/server/test/lab/db-clock.Dockerfile`,
  `apps/server/test/lab/real-run.ts`, and tests `netem.test.ts`, `lab-clock.test.ts`, `real-run.test.ts` beside them
- Modify: `apps/server/test/lab/machine.Dockerfile` (`iproute2`), `apps/server/test/lab/lab.ts`,
  `apps/server/test/lab/writer.ts` (exports `createTask`), `apps/server/test/pins.test.ts`

**Interfaces:**
- Consumes: plan 5b's `Lab`, `LabMachine`; plan 10's `startWriter`; plan 9's way of making a task.
- Produces:
  ```ts
  // test/lab/netem.ts
  export type Shape = { delayMs: number; jitterMs?: number; lossPct?: number; rateMbit?: number };
  export function netemArgs(shape: Shape | null): string[];
  //   ['qdisc', 'replace', 'dev', 'eth0', 'root', 'netem', 'delay', '1500ms', ...] in the order delay, jitter, loss, rate;
  //   null: ['qdisc', 'del', 'dev', 'eth0', 'root']. eth0 is fixed: the machine's own container interface, never a caller's choice.
  //   RangeError for delayMs below 0 or over 5000, jitterMs over delayMs, lossPct over 100, rateMbit below 1

  // test/lab/compose-lab.ts
  export function withLabFile(env: string): string;
  //   the .env text with COMPOSE_FILE ending in :compose.lab.yaml, keeping a list it holds (compose.yaml when none); the same text when it ends so
  export function clockOverride(): string;     // the YAML below
  export function relayOverride(o: { ip: string; link: string }): string;   // Task 12's YAML

  // test/lab/lab.ts: Lab gains
  //   netem(m: LabMachine, shape: Shape | null): Promise<void>
  //     // tc <netemArgs> by m.exec, so inside m's own container. The first use on a machine sets `delay 1ms` first: a failure there throws
  //     // 'netem needs sch_netem in the kernel of the host running the lab', and the scenario stops. null on a machine with no shape does nothing.
  //   useLabFile(m: LabMachine, folder: string, yaml: string): Promise<void>
  //     // writes <folder>/compose.lab.yaml, <folder>/.env by withLabFile, runs docker compose up -d in the folder
  //   useClock(m: LabMachine, folder: string): Promise<void>
  //     // /lab/clock/offset holding 0, /lab/lab-clock.cjs, then useLabFile with clockOverride(). Lab.start's option clock: true builds and loads the db image.
  //   clock(m: LabMachine, seconds: number): Promise<void>      // writes the whole number to /lab/clock/offset, by a temporary file and a move
  //   pauseAll(m: LabMachine): Promise<void>; unpauseAll(m: LabMachine): Promise<void>   // docker pause and unpause of every container running inside m

  // test/lab/writer.ts
  export function createTask(url: string, session: string, title: string): Promise<{ status: number; id: string | null }>;   // what startWriter sends

  // test/lab/real-run.ts, run with tsx by David AI against the real run's company only (Task 16)
  export type Line = { id: string | null; title: string; at: number; ms: number; status: number };
  export function summarize(lines: Line[]): { sent: number; confirmed: number; p50: number; p95: number; p99: number; max: number;
    gaps: { from: number; to: number; seconds: number }[] };   // ms of the 2xx answers; gaps: runs of 2 s or more with no 2xx answer, a switch's length
  export function missing(lines: Line[], has: (id: string) => Promise<boolean>): Promise<string[]>;   // ids answered 2xx that the company no longer has
  export function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number>;
  //   write <url> <file>: creates a task each 200 ms, a JSON line per answer into <file>, until a signal; the session from HORNHOOF_RUN_SESSION, never printed or written
  //   check <url> <file>: prints summarize's numbers and each id of missing; exit 1 when one is missing
  ```
- `machine.Dockerfile`'s `apk add` gains `iproute2`.
- `lab-clock.cjs`, plain Node with no dependency: when `HORNHOOF_LAB_CLOCK` names a file, `Date` and
  `performance.now()` run that many seconds off (the file's whole number, read at most every 100 ms by the real clock;
  an unreadable file counts as what it last held): `Date.now()`, `new Date()` with no argument, and
  `performance.now()`. `new Date(x)` and timers are left alone. It exports nothing the product uses, and lives only in
  the lab's folder.
- `db-clock.Dockerfile`, `FROM` the exact `postgres:17.11@sha256:` of `compose.yaml` (`pins.test.ts` asserts they
  match), `apt-get install -y --no-install-recommends libfaketime`, and a link `/usr/local/lib/libfaketime.so.1` to
  the file `dpkg -L libfaketime` names. Tag `hornhoof-lab/db-clock:dev`.
- `clockOverride()`, exactly:
  ```yaml
  services:
    keeper:
      environment:
        NODE_OPTIONS: --require /lab/lab-clock.cjs
        HORNHOOF_LAB_CLOCK: /lab/clock/offset
      volumes: ["/lab:/lab:ro"]
    db:
      image: hornhoof-lab/db-clock:dev
      environment:
        LD_PRELOAD: /usr/local/lib/libfaketime.so.1
        FAKETIME_TIMESTAMP_FILE: /lab/clock/offset
        FAKETIME_NO_CACHE: "1"
        FAKETIME_DONT_FAKE_MONOTONIC: "1"
        DONT_FAKE_MONOTONIC: "1"
      volumes: ["/lab:/lab:ro"]
  ```
- `Lab.start({ machines })` takes up to 5; the disk check counts each machine's images, as plan 5b's Task 9 Step 3
  says.

- [ ] **Step 1: Write failing tests.**
  - `netem.test.ts`: `shapes the link`: `{ delayMs: 1500 }`, `{ delayMs: 100, jitterMs: 50, lossPct: 5 }` and `{
    delayMs: 0, rateMbit: 20 }` give the exact arrays; `clears it`: null; `refuses what is out of range`: each
    RangeError above; `takes no device`: every array has `eth0` right after `dev`.
  - `netem.test.ts` also, for `compose-lab.ts`: `adds the lab's file once`: `A=1\n` gains
    `COMPOSE_FILE=compose.yaml:compose.lab.yaml`; `COMPOSE_FILE=compose.yaml:compose.worker.yaml` gains the file after
    them; applied twice: the same; `A=1` stays.
  - `lab-clock.test.ts`, `node --require lab-clock.cjs -e` in a child process with a temporary file: holding `-90`:
    `Date.now()` and `new Date().getTime()` are 90 s behind the parent's, within 2 s; `new Date(0).getTime()` is 0;
    the file changed to `0` in the child's run: within 300 ms `performance.now()` has stepped forward by about 90000;
    with no `HORNHOOF_LAB_CLOCK`: the real clock.
  - `real-run.test.ts`, a fake server on `node:http`: `counts a gap as a switch`: answers 200 at 0 to 5 s, 503 to 65
    s, 200 after: one gap of about 60 s; `gives the commit times`: p50, p95, p99 and max of ten known lines; `says a
    missing write by id`: `missing` of three 2xx lines and one 503, one id absent: that id alone; `never prints the
    session`: `main` with `HORNHOOF_RUN_SESSION` set: the session in no output and in no line of the file.
  - `pins.test.ts`, `pins the lab's Postgres to compose's`: the digest in `db-clock.Dockerfile`'s `FROM` is the one of
    `compose.yaml`'s `db`.
- [ ] **Step 2: Run** Done when. Expected: FAIL: no such modules.
- [ ] **Step 3: Implement** in the files above. The `Lab` methods and `db-clock.Dockerfile` cannot run here: they are
  type-checked here, and Task 13 is their first run.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give the lab five machines, tc netem and a clock of its own, and the real run a writer and a
  checker".

### Task 10: The lab: from 2 machines to 5 and back

**Kind: written here, run elsewhere.** Writer: writes and type-checks it. David AI: runs it (Task 13).

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 9 committed. **Done when (here):** `npx tsc
-p apps/server/tsconfig.json --noEmit` and `npm run typecheck:tests` print nothing. **Done when (David AI):** `npm run
test:lab` passes this scenario, after the disk check.

**Files:**
- Create: `apps/server/test/lab/five.test.ts`

**Interfaces:**
- Consumes: Task 9's `netem`; plan 11's `playRelay`, plan 9's `relay()` and `startWriter`, `checkRows`; plan 9c's
  `edge()` and move; plan 10's `leaderOf`, `confirmedOf`, `lateConfirms`; plan 9b's priority route; `steps.ts`.
- `five.test.ts`, one scenario, 150 minutes at most, the disk check first, `Lab.start({ machines: 5 })`. m1 a server
  with the lab's relay, edge and `playRelay`, set up, the link on. The owner joins m2 and m4, a person P with the
  whole company's scope m3, a person Q who sees one department m5. A one-second sample of every `/api/keeper` for the
  whole scenario fails it when two say `lead`.
  1. "Two": the writer with `leaderOf` of every data machine, for the whole scenario. m2 joined: within 5 minutes
     number 2, within 15 `ready`; the fake's record `on` with m2's network id; the tab's `copies` line holds m1 and
     m2.
  2. "Three": m3 joined: number 3 within 5 minutes, `ready` within 15. The record still names m2.
  3. "Four and five": m4 joined: number 4 with `server_why` `next`, role `worker`, no `db` in its `docker compose ps`.
     m5 joined: no number, `unfit` `scope`, role `worker`. On each of the five, `curl localhost:<its web
     port>/api/health` gives one commit, and `/api/keeper` names m1 leader, within 2 minutes.
  4. "A slow copy": `netem(m2, { delayMs: 1500 })`. The writer's answers go on. Within 60 s the record is `on` with
     m3's network id, m2 not sync. `netem(m2, null)`: within 3 minutes the record names m2 again (a lower number that
     kept pace for 30 s, through "sync off"). `checkRows` of m2 and m3, once both `ready`, is empty.
  5. "A lossy link": `netem(m1, { delayMs: 100, jitterMs: 50, lossPct: 5 })` for 5 minutes: m1 leads throughout, no
     handover row is written, and the writer has at least one 2xx answer in each minute. `netem(m1, null)`.
  6. "Number 4 takes the server": the CEO pins m2 to place 2 (`{ pin: 2 }`), so it keeps its copy through what
     follows. `netem(m4, { delayMs: 0, rateMbit: 20 })`. "Move the server here" on m4 as the CEO: 202; `GET
     /api/machines` shows its `move` `preparing` with a progress that grows between two samples. `netem(m4, null)`.
     Within 20 minutes m4 leads as number 1, and within 5 more the copies are `ready`. `net.ranking` shows at most one
     copy handed over (spec 3.3: at most one a day). Then "Move the server here" on m1, and m1 leads again as number
     1, m2 still number 2 and named sync once it keeps pace.
  7. "Back to four, three and two": Disconnect m5, then m4, then m3, waiting for each. Each: its `/api/keeper` says
     `disconnected` within 30 s, and its number is gone. One that held data at that moment (m4 or m3, by what step 6
     left): also, within 10 minutes, its row has `data_left_at`, its upload is `merged` or `done`, the fake relay's
     link key changed, and its `.env` has empty `HORNHOOF_SECRET`, `NODE_KEY` and `POSTGRES_PASSWORD`. m1 stays number
     1 and m2 number 2, the record `on` with m2's network id.
  8. The writer stopped. Once m2 is `ready` (2 minutes at most), `checkRows` of m1 and m2 for every id it kept is
     empty, and `lateConfirms(await confirmedOf(m1, <every kept write>))` is empty.

- [ ] **Step 1: Write the scenario**; type-check it. It cannot run here.
- [ ] **Step 2 (David AI): Run it.** Expected at first: FAIL at step 1 until Task 9's `Lab` parts work. Each failure
  of the product: its failing test first, in the owning plan's test file.
- [ ] **Step 3 (David AI): Check the disk, then Done when.** Expected: PASS.
- [ ] **Step 4: Commit** "Test in the lab a company growing from two machines to five and back, over slow and lossy
  links".

### Task 11: The lab: a laptop that wakes with a lagging clock

**Kind: written here, run elsewhere.** Writer: writes and type-checks it. David AI: runs it (Task 13).

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 10 committed. **Done when (here):** `npx tsc
-p apps/server/tsconfig.json --noEmit` and `npm run typecheck:tests` print nothing. **Done when (David AI):** `npm run
test:lab` passes this scenario, after the disk check.

**Files:**
- Create: `apps/server/test/lab/clock.test.ts`

**Interfaces:**
- Consumes: Task 9's `useClock`, `clock`, `pauseAll`, `unpauseAll`; plan 11's `playRelay`; plan 10's `leaderOf`,
  `confirmedOf`, `lateConfirms`; plan 9's `relay()`, `checkRows`; plan 9c's `edge()`.
- `clock.test.ts`, one scenario, 45 minutes at most, the disk check first, `Lab.start({ machines: 2, clock: true })`.
  Spec section 4's row "Leader laptop sleeps", and 3.4 fence 3 (spec:396-402):
  1. m1 a server with the lab's relay, edge and `playRelay`; `useClock(m1, <its folder>)`; m2 number 2 named sync,
     `ready`. The writer with `leaderOf([m1, m2])`.
  2. "It sleeps": `pauseAll(m1)` at t0. Within 75 s of t0, m2's `/api/keeper` says `lead` under a term above m1's, and
     its handover is of kind `takeover`.
  3. "It wakes with its clock behind": at t1, about t0 + 90 s, `clock(m1, -(t1 - t0 seconds, rounded up))`, then
     `unpauseAll(m1)` within 1 s. So m1's keeper and `db` see no jump.
  4. "It cannot get a commit confirmed": for 30 s from then, from inside m1's `app` container (`docker exec`), a task
     created every 200 ms on m1's own API, its title marked `stale-<n>`. No answer is 2xx: each waits and fails, or is
     refused. Within 15 s m1's `/api/keeper` says `read`, and its log has no `a tick came` line (it fenced because the
     link's probe named m2, plan 10's row, not by a late tick). A request that is still waiting gets its error once
     the keeper fences. The titles `stale-%` that m1's `tasks` then holds are noted: committed locally, never
     confirmed. There must be at least one: none means fence 1 refused them all, the scenario did not reach fence 3,
     and the step fails.
  5. "It comes back": `clock(m1, 0)`, as a real VM's clock corrects itself. Within 2 minutes m1 follows m2; within 15
     its led database is merged and its copy `ready`; each noted `stale-` task is on m2, as an added row (spec section
     1: "A change committed but never confirmed ... stays on its disk and is merged").
  6. The writer stopped. `checkRows` of m1 and m2 for every id it kept is empty, and `lateConfirms(await
     confirmedOf(m2, <every kept write>))` is empty.

- [ ] **Step 1: Write the scenario**; type-check it. It cannot run here.
- [ ] **Step 2 (David AI): Run it.** Expected at first: FAIL at step 3 until `db-clock` and `lab-clock.cjs` work under
  the machine. If `libfaketime` cannot be made to work under Postgres: ruling 8's fallback: report it, and the lead
  rules.
- [ ] **Step 3 (David AI): Check the disk, then Done when.** Expected: PASS.
- [ ] **Step 4: Commit** "Test in the lab a leader that wakes with a lagging clock: nothing confirmed, and its rows
  merged".

### Task 12: The lab with a real frps and relay

**Kind: written here, run elsewhere.** Writer: writes both repos' parts; the relay repo's test runs here, with no
Docker. David AI: runs the scenario (Task 13).

**Repo:** the relay repo, branch `main`, and the `network` worktree, branch `network`. **Starts from:** Task 11
committed, and the relay repo's plan 1 Tasks 1 to 12 and addenda. **Done when (here):** in the relay repo `python3 -m
unittest relay/test/test_lab_stack.py -v` passes on 3.12 and 3.14, through `light.sh`; in Hornhoof `npx tsc -p
apps/server/tsconfig.json --noEmit` and `npm run typecheck:tests` print nothing, and `VITEST_MAX_WORKERS=2 nice -n 10
npx vitest run test/lab/netem.test.ts` from `apps/server` passes. **Done when (David AI):** `HORNHOOF_EDGE_DIR=<the
relay repo> npm run test:lab` passes this scenario, after the disk check.

**Files (relay repo):**
- Create: `relay/test/lab_stack.py`, `relay/test/lab.Dockerfile`
- Modify: `relay/test/harness.py` (`Stack` takes `public_https`, `public_http` and `bind`)
- Test: `relay/test/test_lab_stack.py`

**Files (Hornhoof):**
- Create: `apps/server/test/lab/real-relay.test.ts`
- Modify: `apps/server/test/lab/lab.ts` (`realRelay`), `apps/server/test/lab/compose-lab.ts` (`relayOverride`),
  `apps/server/test/lab/netem.test.ts`, `apps/server/test/lab/steps.ts` (`installServer`'s and `joinWorker`'s `{
  realRelay }`)

**Interfaces:**
- Consumes: Task 9's `useLabFile`; plan 11's `homes`; plan 10's `leaderOf`, `confirmedOf`, `lateConfirms`; plan 9's
  `startWriter`, `checkRows`.
- `Stack(tmp, dashboard=True, caddy=False, public_https=None, public_http=None, bind='127.0.0.1')`: with
  `public_https` and `public_http` set, those ports and not free test ports; `bind` the address its public listeners
  take, the rest stays on loopback. Today's callers do not change.
- `lab_stack.py [--https 443] [--http 80] [--bind 0.0.0.0] [--dir /lab/stack]`: starts that `Stack` with `caddy=True`,
  writes the test CA to `<dir>/ca.pem`, prints `ready`, and runs until a signal. `lab_stack.py --route <name> [--dir]`
  prints `route_of(name)` as JSON, from the relay's database.
- `lab.Dockerfile`: `FROM python:3.12-slim@sha256:<digest>` (the writer pins the current one), `curl`, `openssl` and
  `ca-certificates`; copies `relay/`, `Caddyfile`, `pages/` and `www/`; runs `relay/test/frp.sh` and
  `relay/test/caddy.sh` at build, whose checksums it keeps; `CMD python3 relay/test/lab_stack.py`.
- `test_lab_stack.py`, on free ports, no Docker: `starts and answers`: `lab_stack.py --https <p> --http <q> --bind
  127.0.0.1 --dir <tmp>` prints `ready`; `https://hornhoof.org:<p>/api/v1/health`, by SNI and the written CA, answers
  `{"ok": true, "frps": true, ...}`; `--route nobody` prints `state` `empty`; a signal ends every child. `names only
  the lab's hosts`: its source names no host but `hornhoof.org` and names under it, and no key, token or address.
- `lab.ts`: `realRelay(): Promise<{ ip: string; ca: string; route(name: string): Promise<RouteBody>; restart():
  Promise<void>; stop(): Promise<void>; start(): Promise<void> }>`: `docker build -f relay/test/lab.Dockerfile
  $HORNHOOF_EDGE_DIR` as `hornhoof-lab/relay:dev`, a container on the lab's network carrying the lab's label; `ca` the
  file's text, by `docker cp`. A scenario calls it only when `HORNHOOF_EDGE_DIR` is set; otherwise
  `real-relay.test.ts` is skipped with the line `no relay repo: HORNHOOF_EDGE_DIR is not set`.
- `relayOverride({ ip, link })`, for the services `keeper`, and on data machines `app` and `updater`: `extra_hosts`
  `hornhoof.org:<ip>` and `<link>.hornhoof.org:<ip>`; `/lab/ca-certificates.crt` read-only over
  `/etc/ssl/certs/ca-certificates.crt`; `NODE_EXTRA_CA_CERTS: /lab/relay-ca.pem`. `steps.ts`, with `{ realRelay }`:
  writes on the machine `/lab/relay-ca.pem`, `/lab/ca-certificates.crt` (the machine's own bundle and the CA),
  `RELAY_URL=https://hornhoof.org` and `ACME_DIRECTORY=off` in `.env` and no `HORNHOOF_LINK_PROBE`, then `useLabFile`.
  `netem.test.ts`, `overrides for the real relay`: the YAML names both hosts and the two files, and no other address.
- `real-relay.test.ts`, one scenario, 75 minutes at most, the disk check first, `Lab.start({ machines: 2 })`; no
  `FakeRelay`, `edge` or `playRelay`:
  1. `realRelay()`. From m1's `keeper` container, `https://hornhoof.org/api/v1/health` answers `frps` true.
  2. m1 a server with `{ realRelay }`, set up, a random link on. Within 60 s `route(link)` says `held`, `client`
     `<link>-<m1's 8>-link`. From inside the relay container, `https://<link>.hornhoof.org/api/health` answers 200
     with m1's commit.
  3. m2 joined by the owner, then `homes([[m1], [m2]])`, so nothing direct: its path `relay`; within 20 minutes its
     copy is `ready` through the `-data` stcp service, and `route(link)`'s `sync` is `on` naming m2. The writer with
     `leaderOf([m1, m2])`. `docker pause` of m2's `keeper` and `db` for 30 s: m1 leads throughout on the link's proof
     alone, `route(link)`'s `sync` says `off` within 10 s; unpaused, `on` again within 3 minutes.
  4. "Power off": `docker stop` of every container in m1 at t0. `route(link)` says `empty` within 40 s (R3, frps's own
     eviction); within 90 s of t0 m2 leads, `route(link)` `held` by m2's link client at a higher generation, and the
     link's `/api/health` answers m2's. The seconds from t0 to m2's first 2xx write go into the test's log, as the
     lab's timing against the spec's "about 60 s".
  5. "Coming back": m1's containers started, the two still apart: within 15 minutes m1 follows m2, its led database
     merged, its copy `ready`. "Move the server here" on m1: within 120 s m1 leads, `route(link)` held by m1's client,
     and never two at once.
  6. "The relay restarts": `restart()`. The link answers again within 30 s, `relayStarted` is new, `generation` grew,
     `sync` as it was, and m1 leads throughout the next 120 s. No handover.
  7. "The relay stops for 40 s", the two machines still apart, so nothing else carries their peer link, then
     `start()`: m1 fences within 15 s; nobody leads under a split term; once the relay is back m1 leads again within
     60 s under a normal term, and the writer's answers go on.
  8. The writer stopped. `checkRows` of m1 and m2 for every id it kept is empty, and `lateConfirms(await
     confirmedOf(m1, <every kept write>))` is empty.

- [ ] **Step 1: Write the failing relay tests.** `test_lab_stack.py`.
- [ ] **Step 2: Run** them. Expected: FAIL: no `lab_stack.py`.
- [ ] **Step 3: Implement** `harness.py`'s options and `lab_stack.py`; run. Expected: PASS, and every other relay test
  as before.
- [ ] **Step 4: Write `lab.Dockerfile`, `realRelay`, the override and the scenario**; `netem.test.ts`'s case first,
  watched failing. Type-check. The scenario cannot run here.
- [ ] **Step 5 (David AI): Check the disk, then Done when.** Expected: PASS. A failure of the product: its failing
  test first, in the owning plan's test file; a difference between the fake relay and the real one: the fake gets
  fixed too, with its test.
- [ ] **Step 6: Commit**, in each repo, "Run a real frps and relay in the lab, in one scenario: power off, coming
  back, a restart and a short stop".

### Task 13: Run the whole lab and the real tests

**Kind: written here, run elsewhere.** Steps alone. Runs: David AI, on a machine with Docker to spare (QUESTIONS.md
item 4).

**Repo:** the `network` branch and the relay repo, taken from where the series was built by David AI's own means;
nothing on the build machine pushes. **Starts from:** Tasks 1 to 12 committed and reviewed. **Done when:** Steps 2 to
4 pass.

- [ ] **Step 1: Check the disk.** `df -h /` and `docker system df`, counting six machines' images in the largest
  scenario, as plan 5b's Task 9 Step 3 says.
- [ ] **Step 2: Real Postgres and Pebble.** `npm run test:real`. Expected: pass, on both architectures where plan 9's
  Task 8 asks it. It is the first run of those tests: expect findings.
- [ ] **Step 3: The lab, scenario by scenario, in the series' order:** `join` (5b), `backups` (7), the merge's (8),
  `copies` with its steps 3a to 3d (9, 9b), `switch` (9c), `takeover` (10), `splits` (11), `cut-off` (11b), `five`,
  `clock`, `real-relay` (`HORNHOOF_EDGE_DIR` set). Expected: each passes, every `checkRows` empty, every
  `lateConfirms` empty, never two machines leading a normal term.
- [ ] **Step 4: Fix what they find.** Each fix with its failing test first, in the test file of the plan that owns the
  code; a fix to a plan's logic gets a ledger line. Re-run the scenario that found it and the whole of `npm test`.
- [ ] **Step 5: Keep the numbers.** Each scenario's time and the timings its log wrote go into David AI's own notes,
  and into Task 16's table as the lab's column.

### Task 14: Deploy the relay at night

**Kind: written here, run elsewhere.** Steps alone. Runs: David AI, on the Mac, with the droplet's keys, which are
nowhere else. Ivan is told before.

**Repo:** the relay repo, with its private settings outside it. **Starts from:** Task 13's Steps 2 and 3 pass. **Done
when:** Step 5's checks pass.

- [ ] **Step 1: The private words.** `python3 -m unittest relay.test.test_public` with
  `~/.hornhoof-edge/private-words` in place (QUESTIONS.md item 2). Expected: no private word.
- [ ] **Step 2: Everything in one deploy** (overview decision 4: at most one restart): plan 1's Tasks 1 to 13,
  addendum A1, plan 9c's Task 12 (addendum A2), plan 7's Task A1 if it changed a setting. The Mac's paths and
  `$EDGE_SSH` as plan 1 says.
- [ ] **Step 3: Before it**, as plan 1's Task 13 Step 7: `caddy version` on the droplet against
  `relay/test/caddy.sh`'s pin; the install script's sha256 kept. And plan 1b's Task 10 Step 4: `dig +short CAA
  hornhoof.org` is empty or names `letsencrypt.org`.
- [ ] **Step 4: Deploy**, between 06:00 and 07:15 UTC (03:00 to 04:15 at UTC-3), only while the gate says quiet: `sh
  relay/deploy.sh`. On `busy`, `cannot tell` or a gate refusal nothing changed: the next night.
- [ ] **Step 5: Check**, as plan 1's Task 13 Step 8 (on a failure: its rollback, then stop), addendum A1's Step 6 and
  plan 9c's Task 12 Step 6.
- [ ] **Step 6: The runbook and the push.** Plan 1's Task 13 Step 9 (the ops note), plan 9c's runbook line. Pushing
  `hornhoof-edge` to GitHub, private for now (overview decision 1), is David AI's or Ivan's choice on the Mac; the
  copy on the build machine keeps no remote.

### Task 15: Number the migrations, and rehearse once

**Kind: written here, run elsewhere.** Steps alone. Runs: David AI, on David AI's own stand. Ivan is asked nothing but
what a step names.

**Repo:** the `network` branch. **Starts from:** Task 14 done. **Done when:** Steps 2 and 4 pass.

- [ ] **Step 1: Number the migrations again** (the overview's rule): every network migration gets a number after
  main's newest at this moment, and a journal `when` above that migration's, since drizzle skips one that is not above
  the last applied. Nothing else changes.
- [ ] **Step 2: Run** `npm test`, `npm run test:real` and one lab scenario (`copies`) on the result. Expected: pass;
  `migrations.test.ts` counts as before.
- [ ] **Step 3: Build** two images, as plan 5b's Task 10 Step 4 builds its B1 and B2: B1 from the commit before this
  plan's Task 1, B2 from the branch's head. A branch build pushes its commit tag alone (`pins.test.ts`), so no company
  moves.
- [ ] **Step 4: One rehearsal,** on a throwaway company on David AI's stand, never a company of Ivan's: from the
  current release to B1, back, forward again, then with a copy to B2, holding each plan's part. Any step that fails:
  stop, fix with a failing test first, and start again from Step 2.

  | Plan | Its part, as its own text says |
  |---|---|
  | 2 | Task 11 Step 4: the move by Update both ways, ports, `front` and `keeper` in place of `tunnel` |
  | 3 | Task 6 Step 4: the keeper paused, read mode and back |
  | 4 | Task 8 Step 4: a turn survives an update |
  | 5, 5b | Task 7 Step 4; Task 10 Step 4: a worker joined by the real command, renewal and Disconnect |
  | 6 | Task 7 Step 4: access per machine, by its owner |
  | 7 | Task 11 Step 4: a bundle, the recovery file, a restore. The total loss stays the lab's |
  | 8 | a restore with "Bring back what came after" on, then off (p8:1496-1498) |
  | 9, 9b | their lab scenarios' steps (p9:1900-1901, p9b:991-992) |
  | 9c | Task 11's scenario, and an Update of the rehearsal's company with a copy (p9c:1658-1659) |
  | 10 | Task 11's scenario, and its leader's power pulled once with the page open (p10:1659-1660) |
  | 11 | Task 9's scenario, and a router unplugged once with the page open |
  | 11b | Task 8's scenario, and a Mac's Wi-Fi off while an agent works |
- [ ] **Step 5: Clean up.** The rehearsal's company and machines gone, by their labels and that folder only.

### Task 16: The real run on Ivan's machines

**Kind: written here, run elsewhere.** Steps alone. Runs: David AI and Ivan, together. Ivan does what a person must
(power, lid, router, clicks); David AI starts the writer, keeps the times and reads results. No step asks Ivan to type
a command but the one install line.

**Repo:** none; the branch's build from Task 15. **Starts from:** Task 15 passed. **Done when:** Step 6's table has a
line for every row, and `check` says nothing is missing.

- [ ] **Step 1: Two companies on real machines, as a first user.** On Ivan's Debian, the full installer command with
  `--name` and a new name, at the branch's tag (`HORNHOOF_VERSION`), set up in the browser with a random link. On the
  Mac, Machines, "Connect a machine", its one command. Then a second new company the other way round, installed on the
  Mac and joined from Debian, so both machines carry it beside what they already run. Check: each has its own ports,
  no clash, and `localhost:<port>` on each opens the right company. Neither is a company Ivan works in.
- [ ] **Step 2: Start the writer.** `tsx apps/server/test/lab/real-run.ts write <the first company's link> <file>`,
  from a third place when Ivan has one, else from David AI's machine, with its session in `HORNHOOF_RUN_SESSION`,
  against that company only.
- [ ] **Step 3: Before each physical step, say what stops** (ruling 14): that machine's other companies, whatever else
  runs there. Ivan picks the moment or leaves the step out.
- [ ] **Step 4: The steps,** each from Debian leading and the Mac's copy up to date unless it says otherwise. After
  each, wait until both are up to date again and the page has settled, and take the screenshots of Step 5.

  | # | Step | By | Expected (spec section 4) |
  |---|---|---|---|
  | 1 | Pull Debian's power, the page open on the Mac | Ivan | Mac leads in about 60 s; "Moving the company to Mac", then "Hornhoof runs on Mac now"; the link and `localhost` go on |
  | 2 | Debian back on | Ivan | its copy catches up or remakes; "Debian ran the server until ... and is up to date again"; the server stays on the Mac |
  | 3 | "Move the server here" on Debian | Ivan | about 10 s, the banner, nothing lost |
  | 4 | Quit Docker (Docker Desktop or Colima) on the Mac, as a copy | Ivan | "Copy: asleep since ...", about 3 s of waiting commits, "Only Debian holds changes since ..." |
  | 5 | Docker back; then "Move the server here" on the Mac; then quit Docker on the Mac, as the leader | Ivan | Debian leads within 60 s |
  | 6 | Close the Mac's lid with the Mac leading, 5 minutes, open it | Ivan | Debian leads; on waking the Mac commits nothing confirmed and fences; its rows merge |
  | 7 | Unplug the router, both machines in one home; Ivan says whether their local network stayed up | Ivan | network up: no switch, the link is down, `localhost` works, agents wait for their providers. Network down too: each machine fences within 10 s and only reads, none goes on by itself, "Go on here" is offered; plugged back in, the same term's leader comes back and nothing split |
  | 8 | Turn the Mac's Wi-Fi off while an agent works there, Debian leading | Ivan | "This machine has no internet...", the saving list, "Go on here without Debian"; Wi-Fi back: saved work comes back as a branch |
  | 9 | Restart the relay, at night by decision 4's gate | David AI | the link blinks for seconds; no switch |
  | 10 | Stop the relay for 90 s, then start it, at night; both machines on one network | David AI | the lease holds by the peer proof; no switch, no split |
  | 11 | "Move the server here", then press Update while it moves; then Update, and press "Move the server here" while it runs | Ivan | "The server is moving to ... Update once it moved."; "Hornhoof is updating. Move the server once the update ended."; then each goes through |
  | 12 | An Update of the company with a copy, by the button | Ivan | every machine moves; "asking the copies to wait"; maintenance; the copy remakes if there are migrations |
- [ ] **Step 5: The screenshots,** in both languages, kept with David AI, outside both repositories: the Machines tab
  with its Priority column; a card's Priority row with "Automatically", "By hand" and its select; the inline confirm
  of "Move the server here"; "takes the server once its copy is up to date"; each banner a step shows; the old
  leader's note; the read-only page and "Go on here"; the update's progress with "asking the copies to wait". Each
  looked at against the guide's words.
- [ ] **Step 6: The result.** Stop the writer; `tsx apps/server/test/lab/real-run.ts check <the link> <file>`.
  Expected: exit 0, no id missing. Its gaps are the switches' lengths, and its p50, p95 and p99 the synchronous
  commits. A table, with the lab's column from Task 13:

  | Step | Done? (yes / not done, why) | Seconds, measured | Spec says | As expected? |
  |---|---|---|---|---|

  Ivan reads it and the screenshots. A write missing, or a row not as expected: its failing test first, the fix in its
  plan, Tasks 13 and 15 again as far as the fix reaches. A step left out says "not done", and Ivan decides whether the
  series ships without it.
- [ ] **Step 7: Clean up.** Those two companies removed from both machines by the guide's own steps, that folder and
  that registry line only.

### Task 17: The one merge, Ivan's Updates, and the close

**Kind: written here, run elsewhere.** Steps alone. Runs: David AI; each Update and each click is Ivan's.

**Repo:** Hornhoof's main checkout on the Mac. **Starts from:** Task 16's result accepted by Ivan. **Done when:** Step
5's checks pass and Step 6 is done.

- [ ] **Step 1: Read the list.** `notes/ops/going-public.md`, "Docs written ahead of the code": each line against
  `SECURITY.md` and the README as they stand after Task 7 (ruling 12). A line that promises what did not ship: a fix,
  or Ivan's word.
- [ ] **Step 2: Review once more.** The whole branch against the spec's sections 1 and 2 and each plan's Review Focus;
  the last review's findings fixed, each with its failing test first.
- [ ] **Step 3: Merge** the branch `network` into main, once, with exactly this subject (no double quote):
  ```text
  Run one company on all the owner's machines: copies, takeover, splits and merges
  ```
  Then the push of main, and wait for CI green, `test-real` included, and the new images. Before it, `main`'s newest
  migration is checked against Task 15's numbering once more; if main moved, Task 15 Steps 1 and 2 again.
- [ ] **Step 4: Ivan updates.** He presses Update on each company himself, one at a time, smallest first. David AI
  never runs an install, an update, a restore or a `request.json` on them.
- [ ] **Step 5: Check, reading only**, after each: the release's commit in `/api/health`; `front` and `keeper` running
  in place of `tunnel`; `/api/keeper` says `lead`; the link answers with the company's own certificate; a
  `net.backups` row within 10 minutes; the recovery file's banner in Ivan's browser. Then, Ivan's clicks and his one
  command: "Save the recovery file"; "Make Mac a full machine of the company" where a machine carries only plans. When
  a check fails, or an Update does not end within 20 minutes, David AI tells Ivan which release to go back to, and
  how, as plan 5b's Task 10 Step 6 says.
- [ ] **Step 6: Close.** `git worktree remove` of the series' worktree, and `git branch -d network`, once main has the
  merge. Mark the overview's status line and `QUESTIONS.md`'s items 2, 3 and 4 as done. Ivan hears: the timings, the
  screenshots, and that phase 1 is done with no confirmed write lost.
