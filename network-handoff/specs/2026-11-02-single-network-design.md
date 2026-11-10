# One network of the owner's machines

Status: design for the next milestone, 2026-11-02, revised after four rounds of review the same day and Ivan's answers.
Nothing here is built.
Related: `notes/specs/2026-11-02-computer-access.md`, `notes/research/2026-11-02-shared-signin.md`, `guide/*.md`
(today's behavior).

Marks: `file:line` is current code I read. [S: ...] is an outside source, listed at the end. "Call:" is my decision with
its reason. "Ivan:" is his decision.

## 1. Intent

Ivan (the CEO) runs one company on several of his own machines, today a Debian 13 server (x86_64) and a Mac (Apple
Silicon, Docker Desktop), with more to come. He wants them to be one network with no server: "Децентрализованная сеть",
"Сервера быть, мне кажется, вообще не должно". When the leading machine stops, another takes over by itself: "У меня все
должно работать, как будто бы ничего не случилось". The same public link, or localhost on any of his computers, shows
everything.

Today a company lives on one computer: one compose stack (`compose.yaml:1-145`), all data in one Postgres, files too
(`attachments.bytes` is bytea, `apps/server/src/db/schema.ts:520`). Nodes know only that server's address
(`apps/node/src/state.ts:8`). Nothing about copies, standby or a leader exists.

**In simple words.** With two machines, neither can tell "the other is off" from "the other is cut off and taking over".
Something outside has to break the tie. Here it is the public link: hornhoof.org lets one name point to one machine
only, so the machine that holds the name leads. The machines that can hold the server get numbers on the Machines tab: 1
is where the server runs now; Hornhoof ranks the others by who is online most and has the best network, disk and memory,
and the CEO may pin a place by hand. If 1 stops, the copy it last named as having everything takes over, which is 2
unless 2 was away or behind, else 3. hornhoof.org also keeps one flag per name that the holder posts, "this copy has
everything" or not, naming the next number that keeps up. It never sees the numbers, never picks a machine and decides
nothing. When machines truly cannot see each other or hornhoof.org but still have internet, nothing stops: after 2
minutes each side goes on, and Hornhoof merges the sides when they meet. Phones never take the server, because Android
stops programs that run in the background.

Goals:

1. Every machine opens the company at `http://localhost:<company port>`; the public link always reaches it.
2. The data lives on up to 3 machines. When the leader stops, a copy takes over within about a minute, untouched by hand.
3. Every machine that can hold the server gets a number, shown on the Machines tab with one line on why (the first three
   hold copies in phase 1): 1 is where the server runs now, the others are ranked automatically by score, and the CEO
   may pin a place or say a machine does not take the server. When 1 stops, its sync copy takes over, which is the first
   number that was up and kept pace; the server moves otherwise only when the CEO says so. Phones and machines without
   Docker get no number and only work.
4. When machines cannot see each other, each side with internet keeps working, and the sides merge later: records by
   Hornhoof, code through the gates, real conflicts by the orchestrator, who tells the CEO.
5. 3 to 4 companies run side by side on every machine with no clash.
6. Plans run on any of their owner's machines; computer access is per machine.
7. One "Update" click moves every machine, and moves today's single-server installs into the network.
8. Encrypted backups of the company sit on other company machines (3.8).

Call: plans on any machine (section 7) ships first, on its own. It needs nothing from the network, and Ivan asked for it
first.

Non-goals: phones or browsers holding data; copies on machines of anyone but the CEO and people who see the whole
company (3.3); Windows; multi-writer databases such as pgEdge Spock; control of macOS itself from computer access
(section 8). Our own TLS on the public link left this list on 2026-11-02 (Ivan: hornhoof.org must not be able to read
company traffic) and is part of phase 1: see 3.10 and `notes/plans/2026-11-03-network-phase-1-overview.md`, "Our own
TLS on the public link".

Anti-goals and guarantees, stated exactly. Ivan, on splits: "мне кажется, и правда, что ничего не останавливает. Они
просто потом свои ветки смержат... оркестратор помнит, где работа". So:

- While a side reaches the arbiter, hornhoof.org, no two machines get commits confirmed at once. A split is avoided
  whenever it can decide. There is no other arbiter: voting was dropped on 2026-11-02 (3.5).
- A side with internet that reaches neither an arbiter nor a machine holding a valid lease goes on by itself after 2
  minutes, under a split term the journal shows (3.6). So two machines confirm in overlapping periods only while at
  least one of them writes under a split term or a CEO term ("Go on here", "Go on from 23:40"); never two normal terms
  at once.
- A machine with no internet never goes on by itself: it confirms nothing until the CEO presses "Go on here".
- Nothing confirmed is lost: every confirmed write ends up on the merged leader. One limit: a change confirmed while every
  copy is away (asleep, cut off, behind) is on the leader's disk only until a copy has it; the Machines tab then says
  "Only Debian holds changes since 23:40", and losing that disk then loses those changes.
- A change committed but never confirmed (its machine lost its lease mid-commit) stays on its disk and is merged. No
  database is thrown away (a remake, a rejoin, a restore, a wipe) before it is merged or the CEO removed the machine
  (3.7). A merge deletes or overwrites a leader's row only where the journal proves it; anything else is a conflict with
  both values, the leader's kept until a pick (section 5). A confirmed write may come back as a conflict or a
  resurrected row, but is never lost silently.
- No central decider. hornhoof.org breaks the tie as above and does nothing more; it never reads the server order.
- Open computer access gives the orchestrator root on that machine, and so power over its database beyond every fence
  here (section 8).
- Nothing that makes Ivan type commands, except the one install command a machine has always needed to join.

## 2. What the owner sees and does

**First install** is as today, `install.sh server` (`scripts/install.sh:688-795`). That computer leads a one-machine
network.

**Joining.** Machines, "Connect a machine", one command, as today (`scripts/install.sh:289-339`). It now installs the
company's small core (section 3.1), so localhost works there at once. A qualifying machine (section 3.3) gets a number
in the server order by itself, 2 when it is the second, shows "Copy: being made, 40%", then "Copy: up to date", and the
tab says: "Debian leads. Mac keeps a copy and takes over if Debian stops."

**Machines tab**, fully apart from plans. The "Plans" row leaves the cards (`apps/web/src/screens/Machines.tsx:268-271`).
Each card keeps owner, system, processor, memory, disk, load, what runs now and "Lend to test runs", and adds:

- a "Priority" / «Приоритет» row (3.3), as in the approved mockup (https://claude.ai/artifact/Twnj15fdFN4Z1gT4Z2AgxT),
  also a sortable column of the machines table:
  - the number, and beside it one line on why, from `server_why`. On the machine where the server runs now, "1" and
    "The company server runs here" / «Здесь работает сервер компании», with the badge "Company server here" / «Здесь
    сервер компании» by its name (today a Leader badge fixed to the server's machine, `Machines.tsx:118-122`; now it
    follows the real leader). On the others, for example "Always online, best connection to machine 1" / «Всегда в
    сети, лучшая связь с машиной 1», "Online almost always, good connection to machine 1" / «Почти всегда в сети,
    хорошая связь с машиной 1», "Always online, but has the least memory" / «Всегда в сети, но памяти у нее меньше
    всех», "Number set by hand" / «Номер задан вручную»; from 4 on, "Gets a copy if one of the first three leaves" /
    «Получит копию, если одна из первых трех уйдет»;
  - under it, on every numbered machine but 1, the CEO's choice: "Automatically" / «Автоматически» (the default),
    "By hand" / «Вручную», which shows a select of 2 to N, and "Does not take the server" / «Не берет сервер»;
  - the line "If machine 1 goes away, machine 2 takes the server, then 3." / «Если машина 1 пропадет, сервер возьмет
    машина 2, за ней 3.»;
  - on every numbered machine but 1, while the leader answers, the CEO's button "Move the server here" / «Перенести
    сервер сюда», which asks in place: "Move the company server to rack-02? Hornhoof stops for a short while as it
    moves; your work is kept." / «Перенести сервер компании на rack-02? Пока он переезжает, Hornhoof ненадолго
    остановится; ваша работа сохранится.» [Move the server / Перенести сервер] [Cancel / Отмена]. Then the leader
    makes that machine's copy if it has none, names it sync and waits until it keeps pace ("rack-02 takes the server
    once its copy is up to date (40%)"), and switches in about 10 s (3.4). It is the only way the server moves while
    its machine runs;
  - a machine that can never take the server shows a dash and the reason: "Cannot take the server: Docker here gets
    less than 4 GB of memory." / «Не может взять сервер: Docker здесь получает меньше 4 ГБ памяти.»; "Cannot take the
    server: the company's data stays only on machines of people who see the whole company, and Marat sees one
    department." / «Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а
    Марат видит один отдел.»; "Cannot take the server: Hornhoof runs here without Docker; make Mac a full machine." /
    «Не может взять сервер: здесь Hornhoof работает без Docker; сделайте Mac полной машиной.»; and on a phone,
    "Cannot take the server: it is a phone." / «Не может взять сервер: это телефон.»; a machine the CEO set to "Does
    not take the server" shows a dash with that choice still selected, so he can change it back;
- for a copy: "up to date", "asleep since 23:40", "3 min behind", "being made, 40%", "stopped: disk full";
- "Open here: localhost:8081", this company's address on that machine; other companies there have their own (section 6);
- computer access for that machine (section 8), and "Keep company backups" (3.8).

After a takeover, once the old leader is back and up to date, its card carries a note: "Debian ran the server until
14:02 and is up to date again." / «Debian держала сервер до 14:02, ее копия снова актуальна.», next to its "Move
the server here". Hornhoof never moves it back by itself.

**During a switch** the page stays open. Banner: "Moving the company to Mac. Your work is kept. About a minute." Requests
wait instead of failing (section 3.9). Then: "Hornhoof runs on Mac now. Debian stopped answering at 14:02." The
orchestrator writes the same in his window, and what waits for Debian's return, if anything.

**Cut off, with internet.** The page counts down: "Lost Mac and hornhoof.org. Going on by itself in 1:40; changes from
both sides are merged later." Then a banner stays: "Working apart from Mac since 14:02." Agents keep working throughout
(3.6).

**Cut off, with no internet**, a read-only Hornhoof stays open (3.9): "This machine has no internet and cannot reach Mac,
so it stopped taking changes. You can read everything." Ivan: the button stays, and running work is never cut; it is
saved first ("дождаться ее, закомит, а потом дальше уже продолжить здесь или автоматически переходить на ту"). The page
lists it: "Saving the work of 2 agents: dev-3 on task #41, ...". Button: "Go on here without Mac", with that list and:
"Only if Mac is off. If Mac works too, both sides get changes; Hornhoof merges them later and the orchestrator asks you
about real conflicts." It can be pressed while saving runs; the machine goes on once saving is done. Without the button,
the work moves to the side that leads (3.9).

**A copy that may be missing changes** asks before it goes on, when hornhoof.org can decide but says the copy may lack
something: "Debian stopped at 03:12. This Mac may not have what Debian did after 23:40 yesterday. That comes back when
Debian does. [Go on from 23:40] [Wait for Debian]". "Go on from 23:40" carries the warning of "Go on here". With more
than one copy up, the question lists each in the server order with the time its changes reach, one button each: "[Go
on from 23:40 on Mac] [Go on from 21:00 on Anna's PC] [Wait for Debian]".

## 3. Architecture

### 3.1 What runs where

One compose project per company per machine, from one compose file. No host networking: every company keeps its own
networks, so fixed inside ports never meet another company's.

| Service | Runs on | Networks and host ports | Job |
|---|---|---|---|
| `front` (new) | every computer | default; publishes `HORNHOOF_PORT` | Serves localhost; passes every request and websocket to the local keeper; holds them during a switch; stamps and keeps tool calls (3.9). |
| `keeper` (new) | every computer | default and internal; publishes `HORNHOOF_PEER_PORT` (TCP) | Main process of its container. Leadership, leases, fences, Postgres control, the peer link (3.2). Runs `frpc` as children: one for the link, one for peer stcp. |
| `updater` | every computer | default, Docker socket | As today, plus role changes, computer access for this machine, the port registry (section 6) and backups (3.8). |
| `db` | data machines | internal only, as today | Postgres 17.11 (`compose.yaml:43`) started with `wal_level=logical`, `max_replication_slots=10`, `max_wal_senders=10`, `max_prepared_transactions=0`. |
| `app` | data machines | default and internal | Mode `lead`, `read`, `maintenance` or `off`, set by the keeper (3.9). |
| `node` (built-in) | data machines | default | Today at `http://app:8080` (`compose.yaml:69`); now its own identity per machine, pointed at its machine's `front` (3.9). |
| plan nodes | as today | their own | Unchanged containers, pointed at the local `front`. |

The `tunnel` service goes: `frpc` already ships in the app image (`Dockerfile:42`), and as a child of the keeper it dies
with the keeper, so a keeper that crashes frees the link (fresh review I5). Call: the data services are a compose profile
the updater starts when a machine becomes a copy, since the updater already runs compose (`apps/updater/updater.sh:88`).
`front` and `keeper` are entry points in the app image, like `tunnel.js` today (`apps/server/src/tunnel.ts:1-20`).

### 3.2 How machines reach each other

The company's authority signs an X.509 certificate for each machine: its id and its role. Keepers talk over mutual TLS
on HTTP/2 (`node:http2`): requests carry keeper messages; CONNECT streams carry Postgres (a copy to the leader's `db`),
backups and web traffic (a `front` to the leader's `app`). The receiving keeper names the peer from its certificate
and sets `x-hornhoof-via`, dropping any copy of that header that came in; the app believes the header only from its own
keeper's address, as it believes only the tunnel today (`apps/server/src/auth/tunnel.ts:10-13`). A worker's certificate
reaches the leader's app and the leader keeper's backups endpoint (3.8) only, and never `db`.

Paths, both kept open when possible:

1. **Direct**, to a peer's local address and `HORNHOOF_PEER_PORT`. On Linux the updater reads addresses with a short
   `--network host` helper each minute. A Mac's installer records `ipconfig getifaddr` once, since updates run inside the
   Linux updater container, which cannot (`apps/updater/updater.sh:257`, Codex F); after that peers tell the Mac's keeper
   the source address they saw on its authenticated connections, which Docker Desktop sends from the Mac's own address.
   Addresses are stored on the machine's row, so a copy knows them without hornhoof.org. Published TCP ports work the
   same on Linux and Docker Desktop. The macOS firewall, when turned on, asks once whether Docker may accept incoming
   connections; the join command says so, and the card shows "Mac does not take connections from Debian" when direct
   tries fail while stcp works.
2. **Through hornhoof.org**, by frp `stcp`. Each data machine's peer `frpc` offers two services, each with its own secret
   kept in the database: `<link>-<machine8>-data`, the whole peer link, whose secret only data machines get;
   and `<link>-<machine8>-app`, which reaches only an app (its own in `lead`, else the leader's through that keeper) and
   the backups endpoint, whose secret workers get. So a worker in another home reaches the leader's app and never `db`.
   Peers connect as visitors. TLS runs inside, so the relay sees only encrypted bytes.

Call: no Nebula and no UDP in phase 1. Inside a bridge network Nebula does not know the host's address or published
port, and Docker Desktop sends outgoing UDP from ports the Mac picks, so hole punching is doubtful [S: Docker Desktop
networking]. The cost: between two homes all traffic goes through hornhoof.org: relay bandwidth, one more hop, and no
talk while the relay is down (3.6). Machines in one home stay direct. Phase 2 tries Nebula on Docker Desktop [S: Nebula
lighthouse].

### 3.3 Roles and the server order

Leader: the one machine whose app writes, per side in a split (3.6). Copy: holds the whole database, may lead. Worker:
runs agents and test runs, opens localhost, holds no data and no company secret. Numbers 1 to 3 in the server order
(below) are the data machines, the leader and its copies; every other machine is a worker, but for a copy being handed
over (below).

The keeper adds to the 20 s load report (`packages/protocol/src/index.ts:282-296`): uptime, disk fsync time and free disk
for volumes. The leader keeps a 7-day online share per machine.

**Who may hold data.** Ivan: "На моих машинах хранить, ну и можно на машинах заместителя". In code a "Deputy" is anyone
who sees two or more departments (`apps/server/src/modules/org/routes.ts:64-65`, `:187`), which an everyday access edit
gives and takes. So copies live only on machines of the CEO and of people who see the whole company; the CEO gives a
deputy whole-company scope when he wants that deputy's machines to keep copies. Backup bundles are sealed to the same
machines (3.8). Such a machine qualifies when it is a computer with Docker; Docker gets 4 GB of memory or more; free
disk is at least three times the database plus 10 GB; and fsync p99 is under 50 ms. Power is left out: Docker Desktop
cannot see the Mac's battery.

Losing whole-company scope is a role change at once: the leader removes the machine's number, drops its slot,
takes the data role off its certificate, renews the stcp secrets and the link key as for a stolen machine (section 10),
and renews the recovery pair (3.8). An offline machine keeps only what it had; on its return its certificate allows one
thing, uploading its database's unmerged rows to the leader through a restricted keeper endpoint for section 5. Then its
updater wipes the database volume, any plaintext dump and the `.env` secrets. It never receives anything new. A leading
machine first hands over by a planned switch; with no up-to-date copy the CEO is asked. The card then offers a new
company secret and API keys as the CEO's choice.

**The server order** (Ivan, 2026-11-02: "1 всегда главная (сервер компании), 2 идет после нее, потом 3", "если первый
отрубился, будет второй", and the numbers pick themselves: "кто лучше всех... у кого качество сети лучше на втором
месте"). It replaces voting (3.5). Call: three columns on `machines`, in schema `public`, so they are journaled, fenced
and replicated like any row (3.7), and only the leader writes them: `server_order` (1 to N, unique, null on a machine
that cannot or does not take the server), `server_pin` (null for automatic, a place from 2, or `none`) and `server_why`,
the line the card shows.

- Number 1 is always the machine where the server runs now, the leader. It changes only by a takeover, when promotion
  makes the new leader 1 (3.7), or by a planned switch the CEO starts with "Move the server here" (3.4). Hornhoof never
  moves the server because the ranking changed, and a machine that comes back after a takeover gets the server again
  only that way, once its copy is up to date.
- Every other qualifying machine gets a number from 2, ranked by the score below around the pinned places. In phase 1
  numbers 1 to 3 hold copies; from 4 on a machine only works until it ranks into the first three, and its why line
  says so. Phones, machines without Docker and machines of people who do not see the whole company never get a
  number.
- The leader ranks once a day, when a machine joins or leaves, and after every change of leader. A machine with less
  than 3 days of history ranks below every machine that has them, so a second computer still becomes 2, and a copy, at
  once.
- The score (Call), 0 to 100 in whole points, in Ivan's order of weight:
  - online share: a machine online 95% or more of the last 7 days never ranks below one that is not; within that,
    40 points times the share;
  - network, 30 points: 10 for the round trip to number 1 (the day's median from the heartbeats, 3.4), 10 for the
    throughput to number 1 (the best minute of the day's transfers of 4 MB or more from number 1, such as a file in the
    replication stream, a backup bundle or a remake; with none that day the last value stays, and none yet scores 5;
    no test transfer, since between homes it would go through hornhoof.org), 10 for the internet (5 for the round trip
    of the internet check of 3.6, 5 for a 4 MB download from github.com once a day). A round trip scores full at 20 ms
    or less and nothing at 300 ms or more, a throughput full at 100 Mbit/s and nothing at 5 Mbit/s or less, straight
    between;
  - disk, 20 points: fsync p99 full at 2 ms or less, nothing at 50 ms;
  - memory and cores, 10 points: 5 for the memory Docker gets past 4 GB, full at 16 GB; 5 for cores, full at 8.
  - Ties: the CEO's machines, then whole-company people's, then the older join. Call: a machine passes the one above
    it only when it leads by more than 5 points or enters the 95% class, so two close machines do not swap every day.
- `server_why` names the strongest part of the score and the weakest, if one is poor, in the mockup's words (section
  2): "Always online, best connection to machine 1", "Always online, but has the least memory", "Number set by hand",
  "The company server runs here".
- Pins. The card's choice (section 2), the CEO's alone: Automatically, By hand with a place from 2 to N, or Does not
  take the server. A pinned place stays and the others rank around it; Automatically unpins. Two machines never pin one
  place: places are unique in `server_pin`, so two sides of a split that pinned one place to different machines meet as
  a unique-key conflict, which the merge gives the CEO (section 5 step 5). A pin ends when its machine becomes number 1.
  "Does not take the server" is refused on the leader ("Move the server to another machine first") and on the only
  up-to-date copy ("Debian holds the only up-to-date copy; give another machine a place first").
- What a new ranking changes: which copy the leader names sync (3.7, through "sync off" for a few seconds), and, with
  more than 3 qualifying machines, which of them are in the first three and so hold a copy. That is a role change: at
  most one a day, one at a time, and the only up-to-date copy never dropped but on a lost scope. The copy is handed
  over (Codex round 7): the machine ranked into the first three gets its copy made first, and is not named sync until
  it is up to date; the one ranked out keeps its copy, and may stay sync, until then; only then does it become a
  worker, its database dropped only as 3.7 allows.
- In a split each side's leader writes itself as 1 in its own copy; choices between split sides use the order of the
  last normal term instead (3.6). After the merge the leader ranks again, so
  `server_order` and `server_why` are recomputed, never merged (section 5 step 4); `server_pin` merges like other data,
  and two different pins go to the CEO as a machine conflict.

What the order decides, and nothing else:

- The sync copy: the lowest number from 2 up that is up and keeps pace (3.7). Only the copy last named sync takes
  over by itself, by the relay rule (3.4); a number that is away or behind is skipped only because the leader named
  the next one while it could. If the leader and its sync copy stop together, or the leader stops while it is between
  two sync copies, the CEO is asked. With two data machines this is the only copy, as before.
- Inside a side that reaches no arbiter, which machine leads it (3.6).

hornhoof.org never reads the list. The order reaches it only as the copy the leader names in its sync record (R2).

### 3.4 Who leads: the relay rule

This rule holds for any number of data holders. "B" below is the copy the sync record names, which the server order
picks: the lowest number from 2 up that is up and keeps pace (3.3, 3.7). Other copies never take over
without the CEO. 3.6 covers a side that reaches no arbiter.

**The relay contract.** The rule below rests on these, so they are written down as relay work with tests, run against a
real frps in the relay's repository and against `apps/server/test/fake-relay.ts` in ours:

- R1, one route per name. A registration for a name with a live route is refused ("router config conflict"), as are
  load-balancer groups; all routes of a name come from one client. Each `frpc` logs in with its own client id,
  `<link>-<machine8>-link` or `<link>-<machine8>-peer`, `<machine8>` being the first 8 characters of the machine id, so
  the link name keeps companies on one machine apart. frps refuses a second live login with the same id (frp 0.71.1),
  and a new login never replaces a live one.
- R2, who holds a name, and its sync record. `GET /api/v1/links/<name>/route`, authenticated with the link's key,
  answers `{state: held | empty, client, since, generation, relayStarted, evictionBound, sync}`. The generation grows
  with every registration and survives relay restarts. Any error, timeout or other answer means unknown, never empty.
  `sync` is `{on | off, copy, epoch, generation, at}`. `POST /api/v1/links/<name>/sync {client, generation, on | off,
  copy, epoch}` with the link key sets it: the relay takes it only if that client holds the route in that generation and
  the epoch is higher than the stored one, writes it to disk, and only then answers. A missing record reads as off.
  Today the relay has only check, bind and unbind (`apps/server/src/modules/link/relay.ts:52-77`), and frps answers the
  same not-found page for no route and for a silent machine, so this is new.
- R3, eviction. frpc keeps tcpMux and sends no separate heartbeat (`transport.heartbeatInterval = -1`; today 30 with a 90 s
  timeout, `client.ts:32-33`); `transport.tcpMuxKeepaliveInterval = 10` on both sides. A silent client's route goes
  within `evictionBound`, about 20 to 30 s, measured by the tests.
- R4, `GET /api/health` answers only while frps accepts logins.
- R5, stcp for each name's peer services (3.2).

**Heartbeats.** Data machines send each other a heartbeat each second over the peer link, saying where they stand:
"I lead (T, A), normal, sync on b, lease until u", "I follow (T, A), not attempting", "I am attempting", or "I lead (T',
B)". The leader's heartbeat names its sync copy b, so a side cut off from the relay knows it (3.6).

**The lease.** Leader A writes only while its lease is valid (fences below). Its keeper renews `until = t + L`, L = 10 s,
where t is the moment the request was sent, by either:

- (a) Link proof: A's keeper sends `GET https://<name>.hornhoof.org/api/network/lease?nonce=n` at t. It reaches whichever
  machine's link frpc holds the route; that machine's keeper answers it itself, never through `front` and never forwarded
  to another machine, with `{machine, term, nonce}`. Only an answer naming A with nonce n renews.
- (b) Peer proof: B answers A's heartbeat sent at t with "I follow (T, A)".

**Re-entry.** A machine whose lease lapsed, or that never led, gets a lease only with a new term, in one of two ways. No
renewal brings back a lapsed lease (fresh review C1).

- The takeover below.
- A fresh peer promise, only for the machine that held the latest term. A leader whose lease lapsed while it was cut off,
  and that hears B again, keeps its app in `read` and asks B for term (T + 1, A). It leads again only once B answers "not
  attempting, follow (T + 1, A)"; it then re-registers its name if the relay dropped it. If B answers "I am attempting",
  A waits for the outcome; if "I lead (T', B)", A follows and section 5 merges what it wrote.

Terms are ordered by (number, machine id).

**Takeover by B.** B polls each second. Its window starts at the first "empty" reply and starts over on any "held"
reply, any generation change, any unknown answer, any failed relay health, any gap of 3 s or more between one poll's send
and the next poll's reply, and any heartbeat from A. B registers the name only when all hold:

1. no heartbeat from A over the peer link for 20 s (Ivan's check 1);
2. A did not answer at the link for 20 s (check 2);
3. the relay's health answered every time (check 3), and at least 25 s have passed since the relay last came back;
4. R2 said empty, with the same generation, for at least 12 s;
5. B is up to date: its first copy finished; R2's sync record says on, names B, and carries the generation R2 reports,
   that of the route's last holder; and A's last heartbeat said "normal, sync on" less than 100 s before the window ends,
   under the 2-minute split delay (3.6). Otherwise B asks the CEO (section 2), who may press "Go on from 23:40".

Then B disables its subscription, so a confused A can no longer get commits confirmed by B; registers the name; checks
its own nonce; takes term (highest number seen + 1, B); promotes (3.7). If registration fails, B enables its subscription
again and starts over.

**B's promise.** B answers "I follow (T, A)" only while it is not attempting, or after it aborted: link frpc stopped (the
name dropped if held), an expired lease in its own `net_local`, its app `off`, subscription enabled again. Once B
promoted, it answers "I lead (T', B)" instead, and A fences.

**Why the two never both get commits confirmed.** A's proof (a) sent at t means A's route was live at the relay at some
moment after t, so A's lease ends at most L after a moment its route was live. B registers only after seeing the route
empty for 12 s, more than L. Proof (b) is covered by B's promise. Any re-registration by anyone changes the generation and
restarts B's wait. This rests on R1 and R2 and on clocks running at about the real rate. If a clock lies, fence 3 below
still keeps the stale leader's commits from being confirmed.

**Fences, all fail-closed:**

1. In Postgres, at commit. Every row change in schema `public` writes a journal row (3.7). A constraint trigger on
   `net.journal`, `DEFERRABLE INITIALLY DEFERRED`, calls `net.assert_lease()` at commit: `net_local.lease` holds the
   current term, its kind is `normal` or `split` (3.6; section 9 adds `maintenance`), `until > clock_timestamp()`, and
   `synchronous_commit` is `on`; a `normal` lease also needs its sync flag, which the keeper sets only while
   `synchronous_standby_names` names a copy, the relay stored "off" at the generation of the keeper's own registration,
   or the machine is alone (below); otherwise the commit fails. `net.merges` and
   `net.backups` carry the same trigger. Every table the app writes lives in `public` or `net` and so is fenced; the
   keeper refuses to start the app while one lacks its trigger (fresh review N9). Only a live keeper renews the lease
   row; no row, no write. The fence functions are `SECURITY DEFINER` with `SET search_path = pg_catalog, net_local`. The
   agent roles own no table and are no superuser (`apps/server/src/db/agent-sql.ts:49-50`), so they cannot disable
   triggers (that needs ownership) or set `session_replication_role` (superusers or holders of the SET privilege only)
   [S: PG17 client settings]. In `net` they get USAGE and EXECUTE on `net.assert_lease(interval, uuid)` only: `ALTER
   DEFAULT PRIVILEGES IN SCHEMA net REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, and every other `net` function loses
   EXECUTE for PUBLIC too, since functions are executable by PUBLIC by default [S: PG17 privileges]. No table rights in
   `net`, nothing at all in `net_local`, so they cannot write a lease or a journal row of their own.
2. `transaction_timeout = 5s`, below the 10 s lease, on the app's runtime pool and the agent
   write role, and `max_prepared_transactions = 0`, since prepared transactions escape that timeout. Never on
   migrations, the merge or the keeper. No `statement_timeout` on any connection that commits writes: it fires as a
   cancel, and a cancelled commit wait reports success (below), while `transaction_timeout` ends the session [S: PG17
   client settings], so it never yields a false success. Today both agent roles get `statement_timeout = 15s`
   (`agent-sql.ts:58`); it stays on the reader role only. The parser below keeps an agent from clearing
   `transaction_timeout`.
3. Synchronous replication, with the sync record at the relay. A clears `synchronous_standby_names` only after
   hornhoof.org stored "sync off, epoch e" for its name and answered (R2), and posts "sync on" only after sync is back
   (3.7). The one exception is a split (3.6), which clears it locally. B disables its subscription before it registers.
   So a machine that wrongly thinks it leads, such as a Mac whose Docker VM clock lags after sleep (fresh review C3), can
   commit locally but never gets a commit confirmed: B no longer acknowledges, and the stale leader cannot turn sync off,
   because the relay takes the record only from the name's holder. The commit waits; when the keeper fences, the client
   gets an error. Those rows stay on its disk and are merged (section 5).
4. At lease end the keeper ends every session of the app's and agent roles with `pg_terminate_backend`, sets the app to
   `read`, and stops its link frpc; the app's pool reconnects in `read`. Termination, not cancel: a terminated commit wait
   reaches the client as a lost connection, and the source retries (3.9). If the keeper dies, frpc dies with it and no one
   renews the lease.

**The orchestrator's SQL** (fresh review N1, Codex A, Codex round 3). Today the agent's text runs as one simple-protocol
query between the app's `BEGIN` and `COMMIT` (`agent-sql.ts:136-138`), so it may itself hold `COMMIT`,
`SET LOCAL synchronous_commit = local`, or `SET CONSTRAINTS ALL IMMEDIATE`, which runs the deferred check at once and not
again at commit [S: SET CONSTRAINTS]. And `SELECT pg_cancel_backend(pid)` from another session of the same role cancels a
commit that waits on sync, which PostgreSQL then reports as a success with only a WARNING [S: syncrep.c, lines 296-309];
any role may cancel its own role's sessions [S: PG17 signaling]. So:

- Rights. `pg_cancel_backend`, `pg_terminate_backend` and the large-object functions `lo_*` lose EXECUTE for PUBLIC
  (large objects are never journaled or replicated [S: PG17 restrictions]), and the agent roles never get
  `pg_signal_backend`. The keeper and the app connect as superusers and keep them. The app applies these revokes and the
  agent roles' grants at every start, and the keeper checks them before `lead`, as it checks triggers, since a new copy's
  schema comes without privileges (3.7).
- Parsing. The app parses the text with Postgres's own parser, libpg_query through `pgsql-parser` [S: libpg_query], and
  runs it only if every statement is `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `WITH`. It also refuses calls to
  `pg_cancel_backend`, `pg_terminate_backend`, `pg_reload_conf`, `lo_*`, any `net` function, and `set_config` on
  `synchronous_commit`, `synchronous_standby_names`, `transaction_timeout` or any `net.` setting. This second guard sits
  behind the rights.
- Right before its own `COMMIT` the app runs `SET LOCAL synchronous_commit = on`, `SET LOCAL statement_timeout = 0`,
  `SET LOCAL client_min_messages = warning` and `SELECT net.assert_lease('2 s', <invocation id>)`. The last fails unless
  the lease holds 2 s more, and records the call in `public.tool_calls` (3.9). Whatever the text did, the commit waits for
  the copy, cannot be cancelled by a timeout, and shows its warnings; the deferred trigger checks once more at commit.
- Any WARNING during `COMMIT` on a write path, in the app's own code too, means "not confirmed": the database layer
  answers its caller with an error, and the source retries with the same id (3.9). The row is committed locally and
  either replicates or is merged. It matches any warning, not its text, which is localized.
- The app's own code keeps the deferred trigger. The app connects as the database owner, a superuser (`compose.yaml:13`,
  `46`), so a lint forbids `session_replication_role`, `SET CONSTRAINTS ... IMMEDIATE` and any lowered
  `synchronous_commit` in app code, the merge included. Only the keeper's own connection sets `synchronous_commit =
  local`.

The keeper's own writes use `synchronous_commit = local`, so its renewals never wait on a silent copy; they touch only
`net_local`, which has no fence trigger. A lease ends when either the wall clock or the monotonic clock says so, and a
keeper tick that comes more than 5 s late fences at once.

**When the relay and the copy are both gone**, the leader fences after L and its commits wait, since it cannot post
"sync off". With internet it goes on after 2 minutes under a split term (3.6); with none, it waits for "Go on here".

**Without a public link.** Call: the company keeps a hidden name at the relay for the lease and the sync record alone,
since two machines have nothing else to break a tie.

**One data machine.** Call: with no copy, the keeper renews its lease each second with no proof, since no other machine
may lead, and the sync flag reads "alone", allowed only while the database lists no other data machine. When a copy
starts being made, the leader first posts "sync off"; once the first copy finished it sets sync, posts "sync on", and
from then renews only by proof (a) or (b).

**Planned switch** (the CEO presses "Move the server here" on Mac's card). Nodes reconnect through their own `front` and
jobs keep running; none of 3.6's saving is needed. B is that machine; when it is not the sync copy yet, A first makes
its copy if it has none (number 4 or later), names it sync (3.7), for the switch even over a lower number, and starts
once B keeps pace, the card saying "Mac takes the server once its copy is up to date (40%)". Once B leads, its app makes
B number 1 and ranks A with the others (3.3).

1. A checks B is up to date, then sends "hand over to B" over the peer link. B confirms and stops any attempt.
2. A stops writes: `front`s hold requests; the keeper writes an expired lease into `net_local.lease` (fence 1 now refuses
   every commit) and ends the app's and agent roles' sessions (fence 4).
3. A reads its own WAL position W (`pg_current_wal_lsn()`) and waits until its slot for B, and for every other online
   copy, shows `confirmed_flush_lsn` at or past W. Keepalives move that position past WAL that holds no transaction,
   such as checkpoints, so it gets there (fresh review N4). A tells B "you have everything to W".
4. A stops its link frpc. The route's generation changes.
5. B disables its subscription, registers the name at once (A's lease is already gone, and B has A's word), and checks
   its nonce.
6. B writes term (T + 1, B). From here there is no abort. B promotes and makes a slot for A before its first write.
7. B detaches its subscription from A's slot (`ALTER SUBSCRIPTION ... SET (slot_name = NONE)`) and drops it; A drops its
   slot for B; A subscribes to B's slot with `copy_data = false`, and so does each other copy that reached W; the rest
   remake (3.7). Dropping a slot fails while a subscription uses it, hence this order.
8. Abort, only before step 6: if a step fails within 60 s, either side may abort. B does as its promise says and answers
   "not attempting, follow (T + 1, A)"; A re-enters with that term and registers its name again. After step 6, A follows
   B. If the peer link breaks mid-way, A does not re-enter by itself: both follow the takeover rule, which sees B's route
   if B registered.

About 10 s in all.

### 3.5 Voting: removed

Removed on 2026-11-02. Ivan asked why voting is needed at all and wants "very simple logic": a number per machine, "если
первый отрубился, будет второй, второй, третий". Voting mattered mainly when hornhoof.org is unreachable and machines
cannot see each other, and for that case Ivan chose availability first (3.6). So there is no etcd, no voter and no
majority; the server order (3.3) decides inside the relay rule (3.4) and inside a split side (3.6). The section number
stays free so that references to 3.6 to 3.10 keep holding.

What it costs against voting, honestly. Voting would have run only with 3 or more always-on computers, and between homes
it would have gone through the relay too (phase 1 has no other path between homes, 3.2). So two machines, Ivan's Debian
and Mac today, lose nothing. With 3 or more:

- hornhoof.org is the only arbiter for every company. With voting, such machines decided without it, so a relay that
  breaks its contract (a bug, or whoever controls the droplet) could cut them apart but never give two of them a normal
  term at once. Now that promise rests on R1 and R2 for everyone, as it already did for two machines. A lying relay
  still cannot lose anything confirmed (the merge brings it back, section 5), and it cannot fool a copy that hears the
  leader's heartbeat directly (check 1), nor answer the lease check in the leader's place (3.10).
- A relay outage pauses or splits machines that voting would have kept going. With the relay down and the machines on
  one network, voting replaced a dead leader within about 20 s, or renamed the sync copy when it dropped out, under a
  normal term. Now, while the leader and its sync copy still see each other, nothing changes (proof (b)). Otherwise the
  others cannot take over and the leader cannot name another sync copy, both of which need the relay: after 2 minutes
  each side goes on under a split term (3.6), and they are merged later. During that split, tasks that were free before
  it wait for the old leader's side (3.6, no double work).
- A short relay outage can end in a question to the CEO (Codex round 7). If the leader dies while the relay is down and
  the relay comes back between about 75 s and 2 minutes later, nobody has split, but by the time the sync copy may take
  over, the leader's last heartbeat is more than 100 s old, so check 5 sends it to the CEO even though it holds
  everything. Voting would have elected it. Two machines already had this cost (3.7, honest cost).
- So there are more split terms, merges and CEO questions, with the conflicts the orchestrator then sorts out, all
  around relay outages.

Unchanged: only the copy last named sync takes over without the CEO, as with voting (Codex D), so the leader and its
sync copy failing together still means a question to the CEO. Gained: no etcd cluster, no membership changes (the
riskiest part of the old phase 1), the same rule for 2 and for 5 machines, and an order the CEO can read, with a reason
per machine, and pin.

A cost of the automatic order itself, not of dropping voting: each change of the sync copy, by a ranking, a pin or a
copy that catches up, passes a few seconds of "sync off", and a leader that dies in them leaves the CEO a question. The
5-point margin and the daily ranking keep these rare.

### 3.6 Splits: when no arbiter can decide

The arbiter is hornhoof.org (3.4); there is no other (3.5). While a side reaches it, the rules there hold and nothing
splits. Ivan's rule for the rest is in section 1.

**Going on alone.** A side that has internet but reaches neither an arbiter nor a machine holding a valid lease goes on
by itself after 2 minutes (Call), counted awake on the monotonic clock; a leader and a copy alike. "Has internet" means
the keeper reaches at least one provider API its machine's plans use, or github.com; agents cannot work without that
anyway. Call: an HTTPS request to each in turn every 10 s, 5 s timeout, certificates checked; any HTTP answer counts and
a TLS error does not, so a captive portal does not count. The keeper then:

- takes a split term (n, machine, split), n above every number it saw, which the journal records;
- clears `synchronous_standby_names` locally, the only time it may without the relay; a copy promotes (3.7);
- writes a lease of kind `split` and renews it while the side stays apart.

A copy that splits is behind unless it was the sync copy and the leader's last heartbeat, within 5 s before the loss,
said sync on. It still goes on (Ivan), but the countdown, the banner and its agents' next prompt say "This side has
Debian's changes up to 23:40 only", and it hands out no old free task (below).

Meanwhile `front` holds requests (3.9) and agents go on working. Several data machines on one side follow the first of
them that holds everything the side has, by the server order (3.3): the leader of the last normal term if it is on that
side; else the sync copy its last heartbeat named, if that heartbeat said sync on; else the lowest number that side sees
in the order of the last normal term. The side's leader takes the split term; the others subscribe to it and promote
nothing. "Go on here" and "Go on from 23:40" take the same kind of term, marked "by the CEO". Call: so does "Go on from
23:40" when B got the name through the relay; B then holds the name, so it leads at the next meeting and turns normal by
the rule there.

**No internet.** A machine with no internet never goes on by itself and confirms nothing (section 2). Its agents are not
interrupted but cannot finish a step without their provider, so each node saves every work folder, with no button, as
soon as its machine fences with no internet and again every 10 minutes while cut off (Call), without touching the
agent's files or index: it copies the index to a temporary file and, with `GIT_INDEX_FILE` pointing there [S: git
environment], runs `git add -A`, `git write-tree` and `git commit-tree -p HEAD`, then `git update-ref
refs/hornhoof/saved/<task>/<time>`. When the internet is back the node pushes the last as a branch,
`saved/<task>@<machine>-<time>`, so heads see it. Not `git stash create`, which leaves out untracked files and writes
the real index under its lock [S: git stash] (`builtin/stash.c`).

**Workers** (no copy) stay with the leader they had. If it is gone, they go to a leader they reach and stay with it until
the sides meet; they never flip between two split leaders.

**No double work** (Call):

- A task in progress stays with the side whose agent has it.
- Free tasks from before the split are given out only by the side that held the last normal term's leader. The other
  side gives out only tasks created on it during the split. Rarely both sides believe they held it (a takeover the
  cut-off side never saw); then one free task may be done on both, and the merge shows it.
- Git settles code (Ivan): each side works in its branches. While its machine is split or cut off, and only then, a
  small `git` wrapper on the agent's PATH in the node sends a push that would not fast-forward to `<branch>@<machine>`,
  never forced, and tells the agent; otherwise git behaves as today. `/usr/bin/git`, `gh api` and GitHub MCP tools
  bypass it, so the merge task lists every branch it finds; no GitHub ruleset is required, since the repositories are
  the user's. Known limit: a force push that bypasses it can overwrite a branch, and GitHub keeps the overwritten
  commits reachable only for a limited time. `<machine>` is the machine's name in lowercase letters, digits and dashes
  plus 4 characters of its id, such as `mac-3f2a`; `<time>` is like `20261102-1405`. A ref may hold `@` but not `:` [S:
  git check-ref-format] [S: GitHub branch names].
- Orchestrator turns run on the side where they were queued, on a node that side reaches; with none, they wait for the
  merge.

**Meeting.** When the relay is back, nobody takes the name without the usual window: the route empty for 12 s with the
same generation (3.4). The side that believes it held
the last normal term only waits less; every other side waits 15 s more, and needs no CEO question, since its split is on
record. Call: each keeper keeps in `net_local` the generation of its own last registration; one that reads a higher one
in R2 knows it was not the last leader. A split side that reaches an arbiter naming another holder fences within 2 s. The
holder leads; every other side is merged into it as they meet, one side at a time (section 5). Split sides that meet over
the peer link with no arbiter do the same: the side that held the last normal term leads, else the side with the
lowest number in the order of the last normal term (Codex round 7: never the 1 a split leader wrote for itself), the
lower machine id if the two saved orders disagree, and the other fences and is merged. Each keeper keeps that order in
`net_local` whenever it follows a normal term, and the sides exchange it first.

Whoever leads after a split stays under a split term until an arbiter is back and every data machine of the last normal
term has answered it over the peer link, following it or merged, or the CEO removed that machine. Only then does it take
a normal term; it ranks the others again (3.3), and the server stays on it. So an old leader that slept with sync off
and wakes with a lagging clock overlaps only a split term, never a second normal one.

**What the CEO sees** afterwards: each free task done once, by one side (but for the rare case above); a message he
wrote on one side answered there; and conflicts the orchestrator resolved, listed in his window. Nothing confirmed is
lost: a split side only ever had what it confirmed itself plus what replicated to it. A machine with no internet and no
button pressed confirmed nothing; only its saved work folders come back.

### 3.7 Copies of the data across CPU types

**Not physical.** A standby's "hardware architecture must be the same" [S: PG17 warm standby], and x86 and ARM differ
even in C `char` signedness [S: pg_upgrade 18]. x86 Postgres under Rosetta on the Mac would match, but macOS 27, which
Ivan runs, is the last with full Rosetta [S: Apple via TechRepublic]. So no Patroni, no pg_rewind, no streaming standby.

**Call: Postgres 17 logical replication**, which sends rows, not files.

- The leader publishes `FOR TABLES IN SCHEMA public, net`. Drizzle's migration log lives in schema `drizzle`
  (`node_modules/drizzle-orm/pg-core/dialect.js:45-46`) and stays out. A new leader creates the publication when it
  promotes, before any slot, since copies are made without one.
- Each copy subscribes to one named publisher machine, through its keeper's CONNECT stream to that machine; a leader
  change replaces the subscription.
- All 27 tables have a primary key (`schema.ts`), so updates and deletes replicate as they are.
- Files replicate as bytea values. One file is at most 50 MB and one task at most 500 MB
  (`apps/server/src/modules/tasks/attachments.ts:19-22`), and text format sends them as hex, twice the bytes. No large
  objects are used; those would not replicate [S: PG17 restrictions].
- Text format: binary would halve file traffic, but the docs call it "less portable across machine architectures"
  [S: CREATE SUBSCRIPTION]. Call: text, until a cross-architecture test of binary passes.
- The copy's apply worker runs with `session_replication_role = replica`, so ordinary triggers do not fire there
  [S: PG17 architecture]: no second journal, no fence check on a copy.
- `max_slot_wal_keep_size` is the smaller of 20 GB and a quarter of free disk. WAL is shared, so this bounds what all
  slots keep together. The keeper drops slots of machines that are no longer copies.

**Synchronous replication** is fence 3 and the durability rule. The leader sets `synchronous_standby_names = 'FIRST 1
(b)'`, b being the subscription of the copy the relay's sync record names: the lowest number from 2 up that is up and
keeps pace (3.3); with two holders, the only one. Only that copy may lead without the CEO, as in Patroni's synchronous
mode [S: Patroni replication modes]. A subscriber counts by its application name, by default the subscription name [S:
synchronous_standby_names], with `synchronous_commit = local` on the subscription as the docs advise [S: CREATE
SUBSCRIPTION]. A treats B as silent when no acknowledgement came for 2 s, or when commits under 1 MB waited over 1 s for
5 s (a copy that applies slowly; one big file does not count). Then A posts "sync off, epoch e" (R2), clears sync once
the relay answered, and goes on alone. When a copy is within 1 s for 30 s, the lowest number that is, B again or a
higher one (Codex round 7), A sets sync to it, waits until it confirmed a position past every commit made while sync was
off, then posts "sync on, epoch e + 1" naming it. Naming another copy while one is named goes through "sync off" the
same way: when a copy with a lower number than b has kept pace (within 1 s) for 30 s, or a new ranking or pin puts
another copy first, A posts "sync off", sets `FIRST 1 (c)`, waits until c confirmed past every earlier commit, and posts
"sync on" naming c. For those seconds no copy takes over without the CEO. If A cannot reach the relay, it cannot clear
sync, and its commits wait (3.4).

**When a copy counts as up to date**: check 5 of 3.4, a finished first copy meaning every table is ready
in `pg_subscription_rel`. Then every confirmed commit is on B, by what synchronous replication means, so no position
compare is needed. The record cannot change while the route is empty, since only the holder sets it, so what B reads in
its window is final; the generation and the heartbeat's age catch an "on" left by a leader that later split (fresh
review C1). A broken peer link while both have internet is covered too: A posts "sync off" before
it goes on alone, and the record, not B's polls of a held but silent route, says so (Codex B).

Honest cost: the rule errs on the safe side. If A posted "sync off" for a copy that was gone a few seconds, and A dies
before it posted "sync on" again, B asks the CEO though it may hold everything. And nothing switches while the relay is
down: if both machines sit in one home, the home loses the internet and then A loses power, B waits for the internet or
the CEO's "Go on here". Once the internet is back it reads "sync on", since A could not change the record without the
relay, but A's last heartbeat is then more than 100 s old, so B still asks the CEO (3.4 check 5).

**Schema changes, phase 1.** DDL does not replicate, and rows that do not fit stop replication [S: PG17 restrictions].
Today's migrations mix data fixes with constraints and drop columns: `UPDATE ... = now()` before unique indexes
(`apps/server/drizzle/0023_impossible_rows.sql:3-4`), `DROP COLUMN` (`0001_m2_nodes.sql:60`, `0006_access_lists.sql:1`,
`0033_nodes.sql:45-47`). Call: after any update that has migrations, every copy remakes itself from the migrated leader,
into a side database, keeping its old one until the new one is up to date and merged (below).
It costs a full copy per such update and leaves no up-to-date copy for that time. Phase 2 splits migrations into
additive steps that copies take first and constraining or destructive steps that follow, with a lint.

**A new copy** takes `pg_dump --schema-only --no-publications --no-subscriptions --no-privileges` of the leader plus
drizzle's applied list, then subscribes with `copy_data = true`. Privileges are left out because the agent roles exist
only where an app ran; the app grants them and applies the PUBLIC revokes at every start (`agent-sql.ts:116-118`), and
the keeper checks both before `lead` (3.4).

**Sequences** do not replicate [S: PG17 restrictions]. There are two, `agent_events.seq` and `task_events.id`
(`apps/server/drizzle/0004_conversations.sql:6`, `0007_tasks.sql:17`). On promotion every sequence owned by a column in
`public` goes to `max + 1000`. `task_events` is keyed by its sequence alone (`schema.ts:444`), so the migration that
adds `net` gives it a `uuid` column, `default gen_random_uuid()`, backfilled; `agent_events` already has a uuid `id`
(`:321`). Merges match these rows by uuid, never by number or content; an imported row keeps its uuid and gets a new
sequence value.

**The journal.** A row trigger on every table in `public` writes `net.journal(id uuid, xact uuid, term_number,
term_machine, term_split, machine, at, tbl, op, key jsonb, cols text[], old jsonb)` in the same transaction: a uuid the
transaction gets at its first journal row, so a source maps to one transaction on any machine, the key, the names of
changed columns and their old values (bytea as a hash). The function is `SECURITY DEFINER`, so writes by the agent roles
are journaled too. The term comes from `net_local.state`, which is not published. The keeper attaches the trigger to new
tables after each migration and checks that no table lacks it. The journal replicates. Only the leader prunes, and only
rows older than 7 days that every data machine confirmed, so a machine that is away, split or not yet merged holds that
horizon back until it merged or the CEO removed it; consumed sets in `net.merges` go with it.

Schemas: `public` holds the company's tables, and also `applied` and `tool_calls` (3.9), so those are journaled, fenced,
replicated and merged like the rest. Both join `HIDDEN` (`apps/server/src/db/agent-sql.ts:15`), so the agent roles get
no rights on them; `assert_lease` writes `tool_calls` as its definer. `net` holds `journal`, `merges` and `backups`, all
fenced and replicated. `net_local` holds `lease`, `state` and `maintenance`, written by the keeper alone and never
published.

**Foreign keys.** A migration makes every foreign key `DEFERRABLE INITIALLY IMMEDIATE`, which changes nothing for the app,
so a merge can defer them: `turns.task_id` and `tasks.turn_id` point at each other (`schema.ts:370`, `391`).

**Promotion** (after the name or a split): record for the old leader its machine, its terms and the origin position B
applied; set sequences; create the publication if missing; make a slot for each other data machine; write the new term;
write the lease; set sync to the copy the server order names (3.3; none in a split), so a silent copy takes the usual
"sync off" path; start the app in `lead`, whose first write makes its machine number 1 and ranks the others (3.3), an
ordinary fenced commit; post "sync on" at its own generation once that copy confirmed past its first commit.

**No database is thrown away.** Before a machine drops a database, by a remake, a rejoin, a restore or a
wipe, section 5 runs against the current leader, and the drop waits for its completion check (step 6), or for the CEO to
remove the machine. A copy that never wrote still runs the compare; usually it finds nothing, at the cost of one id-set
read.

**Rejoining.** After a planned switch, seconds (3.4 step 7). After an unplanned switch or a split, every copy but the
new leader remakes itself after that compare: a fresh copy into a side database, swapped in once up to date, so the
machine always holds one whole database. Until then it is never named sync and leads only by "Go on from". Its position
on the old leader's WAL means nothing on the new one, and it may hold rows the new leader lacks: a walsender sends a
commit once it is flushed locally, before the sync copy acknowledges it [S: syncrep.c], and an async copy may hold a
commit confirmed while the sync copy slept. The merge brings those over. Call: incremental rejoin is phase 2.

### 3.8 Encrypted backups on other machines

Ivan: "в идеале скидывать, может быть, в зашифрованном виде еще какой-то дамп, это же децентрализованная сеть". Phase 1.

- **Keys.** No machine key exists today. Call: at install every machine makes an X25519 key pair
  for age [S: age]; the private key stays in its volume, the public key goes on its row. Step 0 brings these keys, since
  section 7 seals plan credentials to them. The machine's certificate (3.2) carries a separate Ed25519 key for signing.
- **Recovery file.** When the CEO presses "Save the recovery file" in Settings, the leader makes an age key pair and
  puts the private half only into that file, with the link name and link key and the authority's certificate, so a new
  machine can find the company and check what it gets. The private half never sits in the database or a bundle; the
  leader keeps the public half. Pressing it again makes a new pair: later bundles use the new public key, the old file
  opens only older bundles, and the screen says so. Until the first save, bundles go to data machines only and a banner
  asks for it. When the link key changes (section 10) or a machine loses whole-company scope (3.3), the leader drops the
  old public key the same way, and the banner asks for a new file, whose pair later bundles use.
- **Making.** The leader dumps every 6 hours and before every update. Every dump Hornhoof makes is such a bundle, fork
  dumps (section 5) and the one before an update included. Today's plaintext update dump
  (`apps/updater/updater.sh:171-186`, rotation at `:184`) may stay on data machines, which hold the database anyway; no
  plaintext dump stays on any other machine. Each bundle holds the dump and the `.env` secrets a restore needs, which
  the dump lacks: `HORNHOOF_SECRET`, which opens the stored API keys and the authority key
  (`scripts/install.sh:723-726`), `NODE_KEY` and `RELAY_URL` (`compose.yaml:14-19`). Not `POSTGRES_PASSWORD`: a restore
  makes a new database. Never a private key, a machine's or the recovery key. The leader encrypts the bundle with age to
  every machine that may hold data (3.3) and the recovery key, who are trusted with everything anyway. age does not say
  who made a file, so the leader signs the bundle, adds its certificate, and writes its id, time, size, hash and signer
  to the replicated `net.backups`. Only certificates with the data role may sign bundles.
- **Holding.** Bundles are pulled, never pushed into workers: up to 3 other company machines, workers included, picked
  by online share and free disk (at least 3 times the bundle), those in the leader's home first, fetch each new one with
  their own certificate from the leader keeper's backups endpoint (3.2). Each keeps the latest 2. "Keep company backups"
  is a tick on each machine's card, on by default, which the machine's owner can turn off, like "Lend to test runs".
  Holders cannot read the bundles (section 10).
- **Restoring.** On a machine that may hold data, Settings, "Restore from a backup" lists the bundles online machines
  hold, with their times. It warns first and names machines that may hold newer data ("Debian may have changes after
  21:00"). Call: it runs on the leader; with no leader it first takes the name after the usual empty window; on any
  other machine it says "Debian leads; restore there". It fetches a bundle and checks that the company authority
  certified its signer with the data role, valid at the bundle's time, so a later expiry does not matter; the role
  matters because a restore runs SQL from the dump [S: pg_dump]. With a database left, it also checks the hash against
  `net.backups`. Then it decrypts the bundle, writes the secrets to `.env`, and restores the dump as today
  (`updater.sh:220-231`) into a one-machine network. A restore starts a new history: every database that holds data, the
  restoring machine's old one included, merges into it as section 5 says after a restore, before it goes (3.7); to roll
  back on purpose, the CEO removes those databases on the warning screen.
- **Total loss.** A fresh `install.sh server` setup screen offers "Restore from a recovery file"; the new machine
  registers the link name after the usual empty window. Surviving machines that found no leader for 10 minutes (Call)
  poll the link and send the new machine a challenge: a fresh age file, sealed to the recovery public key of the bundles
  it holds, whose plaintext is "hornhoof-recovery-challenge v1", the link name and a 32-byte nonce, under 1 KB. The new
  machine answers with the nonce only, and only when the string, the name and the size match; anything else it refuses,
  so a bundle never passes as a challenge. Holders send the bundles of that key once it answers. A bundle can also be
  uploaded in the browser. Machine private keys are in no bundle, so plans sealed only to lost machines need a fresh
  sign-in, one click each with "Sign in with another account" (section 7); the restore screen lists them.

### 3.9 The app's modes, finding the leader, and work across a switch

**Modes.** `lead`: as today. `read`: no migrations, no timers, no write tools; serves pages, reads, read tools and a
recovery API (status, "Go on here", "Go on from", "Wait"). Nodes may connect for status only,
so it knows which turns still run; their messages stay in the nodes' outboxes. An existing browser session works, since
`sessions` is readable; a new login in `read` gets a short-lived cookie signed with the company secret instead of a
session row. Only the owner may use recovery actions; the app hands them to its keeper. `maintenance`: as `read`, with
the update's progress (section 9). `off`: the process waits. The keeper sets the mode.

**Finding the leader.** Every node already reaches a server on the host's localhost as `host.docker.internal`
(`scripts/install.sh:278-284`). Call: every node points at its own machine's `front`,
`http://host.docker.internal:<company port>`. `front` passes everything to its keeper, which sends it to the leader's app
over the peer link (directly, or through the `app` stcp service for a worker in another home, 3.2), or to its own app.
With no leader known, a data machine's keeper sends it to its own app in `read`, and a worker shows a page with the data
machines' localhost addresses and the link. `front` holds new requests and websocket upgrades up to 60 s during a switch,
then answers 503 with `Retry-After`.

**Where a change came from** (fresh review N5). Each change the app makes for a node message or a web request inserts its
source into `public.applied(source)` in the same transaction: the node and its message number, or the request id the
page sends with each change and keeps when it retries. A handler that commits more than once numbers its steps. Tool
calls record their invocation id in `public.tool_calls` (below). Journal rows carry their transaction's uuid, so section 5
knows each transaction's source. A retry that finds its source listed still commits a touch to that row before it
answers, so its answer too waits on the copy.

**Node messages survive.** Today the outbox is in memory and finished jobs are capped at 50
(`apps/node/src/main.ts:33-34`, `97-110`). Phase 1: the node numbers every message and keeps unconfirmed ones in its
volume; the server confirms the highest number below which every message committed or failed for good (Call: one that
failed for a passing reason, such as a fence, holds it back and comes again); the node drops confirmed ones and resends
the rest after hello; the server skips numbers `public.applied` already lists. The reconnect backoff
(`apps/node/src/connection.ts:16-26`) is capped at 10 s on a network.

**Jobs.** The new leader's database lists running jobs, so hello keeps them; jobs the node does not list fail as
`machine_restarted` (`apps/server/src/modules/nodes/messages.ts:60`). Today the server cancels jobs a node runs that the
database does not hold open (`messages.ts:64-68`), and drops results of unknown jobs (`messages.ts:121-133` only updates
open ones). Phase 1: while a merge is pending, unknown jobs keep running, their events and results are parked in
`net.merges` for the merge, and Y accepts the tool tokens of X's open jobs, read from X in section 5 step 3 (a token
needs a running job row, `apps/server/src/modules/tools/job.ts:37`).

**Tool calls** go to `<server>/mcp` (`apps/node/src/main.ts:87`) through `front`. Job tokens are checked against
`jobs.tool_token_hash` (`schema.ts:297`), which replicated. Phase 1 gives each call an invocation id (Codex E): `front`
on the agent's machine stamps every MCP tool call with a uuid when it first receives it, keeps it in a small persisted
outbox until the reply reaches the agent, and retries with the same id across a switch. `public.tool_calls` is keyed by
that id, with the answer written in the same transaction as the change; a retry gets the stored answer. Two identical
calls get two ids, and both run. Ids stay until the job ends, since turns may run two hours
(`apps/server/src/modules/conversation/queue.ts:26`). An agent that repeats a call itself after an error makes a new
call; the error says "the call may have run; check before repeating". Run and computer tools, and any tool with an
effect outside the database, first commit a confirmed "started" row under the invocation id, then act; a retry gets
"started at 14:02, result pending", never a second run.

**Work on a machine with no internet** (Ivan, section 2). Agents are never interrupted, as the house rule says: no
Escape, no closed program. The fenced app answers read tools; write tools get: "This machine is cut off and does not take
changes now. Finish your current step, commit your work on your task branch, push if you can, and end your turn." Work
folders are saved as 3.6 says. The side that leads sees those jobs as "running on a machine that cannot be reached" and
does not cancel them; the hello rule above still fails jobs a node no longer lists. Call:

- A task whose agent saved and pushed (its branch moved after the cut) is free there: its head gives it to an agent on
  the leading side, which goes on from the pushed branch.
- A task with nothing pushed waits for that machine up to 30 minutes, its card saying "Work saved on Debian at 14:05, not
  sent yet". Then the head may restart it from the last pushed state, which marks the old job superseded; the saved
  commits come back on return as a side branch through the gates (section 5 step 8). If the old agent comes back, it is
  not interrupted, but its next tool call gets "This task moved to dev-5 on Mac. Commit and push your work to
  `<branch>@<machine>`, then end your turn.", and the job closes.

**Built-in node.** Today every built-in node signs in as one, with `NODE_KEY`
(`apps/server/src/modules/nodes/socket.ts:24`), at `http://app:8080`, so a switch drops it and fails its turns as
`machine_restarted` (`messages.ts:60`). Phase 1 gives each data machine's built-in node its own identity, a key derived
from `NODE_KEY` and the machine id, and points it at its machine's `front`, so API-key turns survive a switch; those of
a dead machine restart in a fresh session.

The new leader's app starts as after any restart; turns left behind are queued at start
(`apps/server/src/modules/agents/timers.ts:95-102`).

### 3.10 The public link

The link frpc sends link traffic to its keeper, which answers `/api/network/lease` itself and passes the rest to its own
app in `lead`, or answers "switching". The standby reads name and key from its copy of `public_links`.

TLS on the link ends at the keeper (added 2026-11-02). hornhoof.org routes each connection by its TLS server name and
passes the encrypted bytes through the tunnel; the keeper holds the company's certificate for `<name>.hornhoof.org`,
kept in the database with its key under `HORNHOOF_SECRET`, so a standby that takes the route serves the same
certificate. The leader's answer to `/api/network/lease` therefore comes under the company's own certificate, and the
relay cannot answer in its place.

Timing, leader switched off at 0: the route goes at about 25 s (R3); B sees it empty for 12 s; registration, promotion
and app start take about 10 s; nodes are back within 10 s: about 60 s. localhost on another machine follows the keepers,
not the link.

## 4. Failures

Two machines unless noted. "Split" means 3.6: both sides confirm, and section 5 merges them.

| Case | What happens | How long | What the CEO sees | What is kept |
|---|---|---|---|---|
| Leader switched off | Copy takes the name and leads. | about 60 s | Switch banner. | All confirmed with sync on. If the copy was away (sync off, or no recent heartbeat), the CEO is asked. |
| Leader loses internet, copy elsewhere | Leader fences within 10 s and never goes on by itself. Copy takes over once the route goes. | about 60 s | Old leader: read mode, work saved, "Go on here". Other side: switch banner; pushed tasks move, unpushed ones wait 30 min. | All confirmed; unconfirmed rows and saved work merge on return. |
| Leader loses internet, copy in the same home | Peer proof keeps the lease. No switch. | none | Link down, localhost works; agents wait for providers. | All. |
| Leader's Docker quits, or keeper crash-loops | Keeper and frpc die; the route goes; copy takes over. Short loops only restart B's window. | 0 to 60 s | Switch banner if it switches. | All confirmed. |
| Leader laptop sleeps | Copy takes over. On wake a lagging VM clock may show a valid lease, but fence 3 lets nothing be confirmed; the keeper sees B's route and fences. | about 60 s | Switch banner. | Unconfirmed rows merge on wake. |
| Copy laptop sleeps, copy disk full, or copy behind | Leader sees the copy silent, posts "sync off", clears sync and goes on alone. | about 3 s of waiting commits | "Copy: asleep since 23:40" (or disk full, or behind); "Only Debian holds changes since 23:40". | On the leader's disk only until the copy catches up from its slot. |
| Peer link down, both online | Leader posts "sync off" as above; the copy reads it and knows it may miss changes. | about 3 s | "Mac cannot reach Debian; copy stopped." | As copy asleep. |
| Relay restarts | Leader's frpc re-registers in seconds; B must wait 25 s after recovery. The sync record is on the relay's disk. | seconds | Link blinks. | All. |
| Relay down, two homes | Each side with internet goes on after 2 minutes: a split. They merge when the relay is back. | the outage | Countdown, then "Working apart from Mac". | All confirmed, after the merge. |
| Relay down, 3 data machines, 2 in one home | If the two are the leader and its sync copy, peer proof keeps the lease, and the third, if it holds data, goes on after 2 minutes. Otherwise each side goes on after 2 minutes; the two follow the last normal leader or its sync copy (3.6). | the outage | Each side that splits: countdown, then working apart. | All confirmed, after the merge. |
| Relay down, 3 homes, no direct path | Each data machine with internet goes on after 2 minutes; workers stay with their leader. Merged one side at a time. | the outage | Countdown on each. | All confirmed, after the merges. |
| The home of the leader and its sync copy loses the internet; a third data machine elsewhere has it | The leader keeps its lease by peer proof; the link goes down. The third reaches the relay, so it does not split; it is not the sync copy, so it does not take over and asks the CEO. | the outage | Third: "Go on from 14:02 on Anna's PC". | All. |
| A split side reaches the relay again | Another holder in R2: it fences within 2 s and merges. Empty route: it takes the name after the window, 15 s longer unless it held the last normal term, and stays split until the old leader answered. | 2 to 30 s | "Back in touch with Mac; merging." | All confirmed, after the merge. |
| The server is 1, two laptops 2 and 3; the laptops sleep at night | The server leads by the relay rule. The sync copy is the lowest number awake and keeping pace, else none; copies catch up on wake. | none | "Copy: asleep since 23:40." | As copy asleep. |
| Leader and its sync copy stop together, a third copy is up | The third is not named, so it does not take over; it asks the CEO, listing what each copy up has. | until the CEO answers | "[Go on from 21:00 on Anna's PC] [Wait for Debian]". | All confirmed, after the merge when the two return. |
| The old leader comes back after a takeover | It catches up or remakes its copy (3.7) and ranks by score, usually as 2. The server stays where it is. | none | "Debian led until 14:02 and is up to date again. [Move the server to Debian]" | All. |
| The CEO pins a place, or the daily ranking changes | At most the sync copy changes, through "sync off" (3.7); with more than 3 qualifying machines, at most one copy a day moves. The server stays. | a few seconds without a sync copy | The new numbers, each with its line on why. | All. |
| The CEO presses "Move the server here" | Planned switch (3.4); if the machine is behind, it first catches up. | about 10 s | Switch banner. | All. |
| Leader disk full | The keeper's heartbeat write fails for 10 s, so it steps down and drops the route; a copy takes over. Cards warn at 85%. | about 60 s | "Debian's disk is full; Mac leads." | All confirmed. |
| Update fails, or the leader dies mid-update | Rollback under the maintenance fence. Copies keep the stored "updating" promise until it ends, then the usual rule; with migrations sync is off, so the CEO is asked. | up to 15 min | Update status, then the switch or the question. | The dump taken after writes stopped; nothing was confirmed after it. |

## 5. The cut-off return

When machine X meets the current leader Y (3.6 says which side leads) and wrote in an old or split term, or is about to
drop a database (3.7), Y merges X into itself.

**Safe merge** (Codex round 6). A merge never deletes a row or overwrites a value on Y unless the journal proves it: X
changed that row after the two diverged, and Y did not change it since. Where it cannot prove that (pruned, after a
restore, anything unclear), the merge only adds what Y lacks; any other difference is a conflict with both values, and
Y's value stays until the orchestrator or the CEO picks. A confirmed write can come back as a conflict or a resurrected
row, but is never lost silently.

1. X stays fenced; its keeper sets X's app to `read` and stops its link frpc.
2. If X wrote, its updater saves its database as an encrypted bundle (3.8), kept 30 days outside the usual rotation.
3. Y's keeper reads X over the peer link in one repeatable-read transaction. The divergent range is set by journal ids
   alone, both ways: every row on X whose id Y lacks and every row on Y whose id X lacks, above both pruning horizons
   (3.7); ids in Y's consumed sets (step 6) count as Y's. No term or time compares (Codex 3). If the journals share a
   row above both horizons, they prove coverage, and X holding no id Y lacks ends the merge. Otherwise they prove
   nothing: Y first compares X's tables row by row, and only then may X drop its database.
4. Per table and key, Y builds X's final row (or "removed"), Y's current row and, column by column, what the journal
   proves. It first drops X's changes from transactions whose source Y already lists in `public.applied` or
   `public.tool_calls`: Y has its own result of that input. Bookkeeping columns are not compared: `updated_at`,
   `nodes.last_seen_at`, `nodes.status`, `subscriptions.status`, `machines.server_order` and `machines.server_why`
   (recomputed), `subscriptions.limits` and `models` (last report wins), `tasks.version` (the larger plus 1).
5. Y applies every proven change and every addition in one transaction, foreign keys deferred, no `transaction_timeout`:
   - A column only X changed takes X's value, a row only X added is added, and a row only X deleted is deleted unless
     that would remove or empty a reference on one of Y's rows (`schema.ts:543`, `612`). Any other difference is a
     conflict.
   - Unique keys, one rule each (Call): a taken task, turn, test-run or notebook number gets the next free one, "was #57
     on X" (`schema.ts:378`, `423`, `564`, `622`); with an open turn on each side (`turns_one_open`), X's turn closes
     and its tasks join Y's; a second department head or orchestrator (`:235-236`) joins as an ordinary agent.
   - Append-only logs (`agent_events`, `task_events`, `agent_changes`, `attachments`) are matched by uuid and added with
     a new sequence value (3.7).
   - X's jobs stay as history; open ones stay open while their node lists them, else fail with "ran on X while it was
     cut off"; parked results apply. Sign-in sessions stay; join codes and waiting wakes go. Applied rows wake nobody.
   - Each row group, a row with the rows that depend on it, applies under a savepoint, its foreign keys checked against
     the result. A missing parent, a unique or a check violation makes that group and its dependents a conflict, and the
     merge never aborts: two people invited with one email (`schema.ts:32`) are a people conflict for the CEO; column
     changes that together break a task check (`schema.ts:429`, review with no executor) go to the orchestrator. The
     order of X's transactions does not matter.
6. The same transaction records in `net.merges` the conflicts with both values, files and parked job results included,
   and every journal id of X it consumed: applied, skipped as a duplicate source, or turned into a conflict; it
   replicates. X may drop its database (3.7) once X's journal ids are all on Y or in that set and X's rows the journal
   does not cover were added, found equal or listed: a set check that always finishes.
7. Conflicts go into one orchestrator task, "Bring back what X did while apart (14:02 to 15:30)", grouped by task and by
   table, both values in plain words. With `merge_conflicts` and `merge_pick` he picks a side or writes a merged value,
   one at a time or in bulk by table, side or time range, wakes agents whose tasks changed, and tells the CEO what was
   kept and what he decided. Conflicts about people, access, plans or machines go to the CEO.
8. Code: work on X was never cut (Ivan, 3.9), and git keeps both sides (3.6). The merge task lists every branch per task
   with its machine and time; the orchestrator decides who takes each, and the head takes it through the gates.

More than two sides merge one at a time into the same merge task.

**After a restore** the journal proves nothing across it. A returning database, the restoring machine's old one
included, only adds what the leader lacks; every row that differs is a conflict, the leader's value kept. A missing row
is never read as a deletion, nor an old value as a change. This path reads whole tables: slower, and rare.

**Known limits.** After a long split or a restore the orchestrator may face many conflicts. A row deleted on one side
while the journal no longer proves it comes back, and the orchestrator deletes it again. Both are deliberate: the safe
direction is never to lose a confirmed write.

## 6. Ports and several companies per machine

Two host ports per company per machine. Everything else stays inside the company's own compose networks, so fixed inside
ports never clash: db 5432, app 8080, keeper 7070.

| Port | Kind | Range | In `.env` |
|---|---|---|---|
| Web, served by `front` | TCP, all interfaces as today (`compose.yaml:9`) | 8080 to 8179 | `HORNHOOF_PORT` (exists) |
| Peer link, served by `keeper` | TCP, all interfaces, mutual TLS | 8180 to 8279 | `HORNHOOF_PEER_PORT` (new) |

Today's `free_port` reads other companies' `.env` files and tries `localhost` (`scripts/install.sh:603-614`). An updater
sees only its own folder (`compose.yaml:135`) and its own network, and `docker container prune` removes a stopped
company's containers and with them the last trace of its ports, so a port could be handed out twice (Codex 9, fresh
review N6). Phase 1 keeps a host-wide registry: a file in the named Docker volume `hornhoof-ports`, which every updater
mounts and the installer reaches through a short container. It lists each company folder with its two ports. Call:
the volume is `external: true` in the compose file and made by `docker volume create` at install, so compose neither
prefixes it per project nor ties it to one company.

1. Take the lock: `docker create --name hornhoof-port-lock` succeeds for one caller only. It is held only while
   reserving, never while images download, so it lasts seconds. A lock older than 2 minutes is stale; a caller removes
   it by the container id it read, so if another caller replaced it meanwhile, that removal fails.
2. Read the registry, every published port of every container on the host, running or stopped (`docker ps -a` and each
   container's port bindings), and the readable `.env` files.
3. Pick the first port in each range that none of them holds; write both to the registry and to `.env`; remove the lock by
   its id.
4. Start the containers. If a bind still fails (a program outside Docker took the port), reserve the next one the same
   way, up to 5 times.

A stopped or pruned company keeps its ports in the registry; its entry goes only when it is uninstalled.

Call: a joining machine first tries the company's web port from the leader, so a company tends to have one port
everywhere; otherwise the next free one, shown on the card.

A joined machine gets `~/hornhoof-<company>`, `<company>` being the link name or a random 6-letter id, with a suffix if the
folder holds another company, so two unnamed companies never both want `~/hornhoof`. Project, volumes and containers
follow the folder, as `--name` does today (`scripts/install.sh:704-705`).

## 7. Plans on any machine (first, on its own)

From the research note: a credential broker, never a request proxy, shipped on today's single server.

- Claude: `claude setup-token` once, through Anthropic's sign-in, on any of the owner's machines; the owner's nodes get
  `CLAUDE_CODE_OAUTH_TOKEN`; limits come from `rate_limit_event`. The note calls storing it a grey area of the terms; Ivan
  said go. If refused, the plan falls back to today's sign-in per machine.
- Kimi: a membership API key in each node's `config.toml`. GLM: its key, as today.
- Codex: a lease. One machine holds `auth.json`; the refreshed file goes back; the lease moves when the holder is offline.
  If the holder dies right after a refresh, the stored refresh token is used up and the owner signs in again with one
  click.
- Antigravity stays per machine until researched.

Call: each credential is sealed with age to the machine keys of its owner's machines (3.8), so the server and copies
store it but cannot read it. A new machine of the owner gets it re-sealed by another online machine of that owner.
Personal plans' turns go only to their owner's machines. Plans tab: "Signed in once, runs on any of Ivan's machines (3
online)" or "Signed in on Mac only", limits and "Tasks may use" as today; the plans row leaves the Machines tab in this
step.

Which account a plan runs on, from Ivan's day of 2026-11-02 (his Codex node had signed in to a free ChatGPT account
instead of his Pro one, so the plan offered only GPT-6 Luna and the team could not be made; and the orchestrator could
not say which account a machine works under, since Hornhoof never stored it):

- Each node reports its plan's account and tier after sign-in and on each check: Codex from the `id_token` claims
  (`chatgpt_plan_type`), Claude from `claude auth status`, Kimi from its status. The account address is shown only to the
  plan's owner and the CEO; agents get the tier only (`apps/server/src/modules/tools/company.ts` keeps emails from them).
- The Plans tab shows "Codex, Pro" or "Codex, Free: newer models need Plus or Pro". Two plans of one owner on different
  accounts get a note.
- "Sign in with another account" on the plan: the node runs the provider's sign-out and sign-in itself and the web shows
  the link and code, so nobody types commands. Today sign-in runs only through `docker exec -it` from the installer
  (`scripts/install.sh:454-462`), and `hornhoof-node login` does nothing while signed in (`apps/node/src/main.ts:417`).

## 8. Computer access per machine

Today access is one state for the server's computer, in the control folder (`apps/server/src/modules/computer/access.ts:27`,
`41-101`), and the card names the server's machine only (`access.ts:32-39`). Hence Ivan's "Close access" on another
machine.

- State moves to a replicated table `machine_access(machine, until, asked, opened_by)`. Each machine's keeper writes its
  own `computer.json` from it; its updater still checks `untilSec` before each command (`apps/updater/updater.sh:451-457`).
- Commands go from the leader's app to the target machine's keeper over the peer link, then to its updater through the
  existing `computer/<id>.json` and `.out.json` files.
- Tools take a machine: `ask_computer_access(machine, reason)`, `computer(machine, command, timeoutSeconds?)`,
  `computer_result(id)`; `machines` lists names and roles.
- Card: "The orchestrator asks for access to Debian: <reason>", "Open access to Debian for a day"; the window lists
  "Access to Debian is open until 18:20 [Close access]"; log lines name the machine.
- What it gives, said on the card: root on that machine, so on a data machine also the database's superuser through
  `docker exec`, past every fence of 3.4: "Open access lets the orchestrator change anything on Debian, the company's
  data included."
- On a Mac the helper reaches Docker's Linux system only, not macOS (`notes/specs/2026-11-02-computer-access.md:28`),
  and the card says so. A native macOS helper is later.
- The machine's owner opens it (the CEO for the CEO's machines), from any screen. Nobody else opens it, the CEO
  included: the pool's work runs on every machine by default, but leaving the sandbox for root is the owner's call alone. When the CEO came through a machine's
  localhost, the account menu offers "Give the orchestrator access to this machine (Mac)", and the orchestrator is told
  where the CEO sits. A faked header gains nothing: opening still needs the owner's session.

## 9. Moving today's installs, and updates

**Move in by Update.** The updater runs the new build's `install.sh` as today (`apps/updater/updater.sh:257-268`). It
adds `front` and `keeper`, removes `tunnel`, allocates `HORNHOOF_PEER_PORT`, moves the web port from `app` to `front`
(same number, so localhost and the link stay), and restarts `db` once with the new settings. Migrations add `net`,
`net_local`, the journal, deferrable foreign keys, the authority and the server order's columns (3.3). The server gets
number 1 and leads a one-machine network; nothing else changes. This one update runs today's flow, since no copy exists
yet.

Machines that carry only plan nodes have nothing that may run Docker for the company (nodes have no Docker socket on
purpose, `scripts/install.sh:396-399`), so each needs the install command once more, the one manual step, shown on its
card as "Make Mac a full machine of the company". After that updates come by the button.

**Updates across machines.** The request carries image index digests, which pull on either CPU type
(`apps/server/src/modules/updates/registry.ts:5`, `67-73`). An update starts only when there is one leader and no split.
It never waits for an offline copy.

**The maintenance state** (Codex C, fresh review N7). The leader's keeper writes it to its control folder and to
`net_local.maintenance` (version, since, until), so it survives keeper, app and updater restarts. While it is set: the
lease's kind is `maintenance`, so fence 1 refuses every commit except the migration path; the app starts only in
`maintenance`, never `lead`; nodes are not let in. Today migrations run inside the app's start
(`apps/server/src/db/client.ts:23`); they move to a one-shot `migrate` entry point the updater runs, as the owner with
application name `hornhoof-migrate`, the only session fence 1 lets through in maintenance (an agent role is no owner, so
the name gains it nothing), with no `transaction_timeout`. The state goes only after the updater records success or a
rollback finished. Its format stays readable across one version, as keeper messages do.

Steps:

1. Every online machine's updater downloads the images; nothing stops.
2. The leader sends each online up-to-date copy "updating until <now + 15 min>". The copy's keeper writes the promise to
   its control folder and `net_local`, so a keeper restart keeps it, then acknowledges; without every acknowledgement
   the leader cancels the update. While the promise holds, which the leader extends as the update runs, the copy
   attempts no takeover, and link answers say "updating".
3. The leader sets the maintenance state and a maintenance lease to the same time, ends the app's and agent roles'
   sessions (fence 4), and `front`s hold.
4. The leader reads its WAL position and waits until each online copy's slot confirmed it (3.4, planned switch step 3).
5. Only then the database dump, as today (`apps/updater/updater.sh:171-186`), so no confirmed write is newer than it. The
   dump holds the maintenance lease, so a restored database is fenced too. It is also encrypted and sent out (3.8).
6. If the update has migrations: copies disable their subscriptions, and the leader posts "sync off" and clears sync
   (fence 3), so a migration never waits on a copy that cannot apply it.
7. The leader installs. The install starts `app` and the built-in node before the updater's health check
   (`scripts/install.sh:775`, `apps/updater/updater.sh:374-376`), but the keeper reads the maintenance state, so the app
   comes up in `maintenance` and lets no node in. The updater runs the migrations on their own path, then checks health.
8. On success the updater records it. The keeper writes a normal lease, sets the app to `lead`, and only then tells copies
   and link answers "update ended".
9. Rollback, if needed, keeps the maintenance state throughout: copies disable their subscriptions and the leader drops
   its slots first, because today's restore runs `DROP DATABASE ... WITH (FORCE)` (`updater.sh:220-231`), which fails on
   an active slot and silently drops idle ones. Then restore as today; the old build comes up in `maintenance` and leaves
   it once it answers; copies remake themselves.
10. If the update had migrations, copies remake themselves (3.7), and the leader posts "sync on" once one is up to date;
    otherwise they install and keep their subscriptions.
11. Workers update one by one; keeper messages stay compatible across one version.

A machine that was offline moves to the leader's build before it rejoins, and remakes its copy if migrations ran meanwhile.

## 10. Security

- **Peer link**: one X.509 authority per company; certificates per machine and role, valid 30 days, renewed weekly; a
  revocation list pushed to every keeper. The peer port is open to the local network but takes only certificate holders.
  Through hornhoof.org the TLS runs inside stcp, so the relay sees encrypted bytes. Call: a machine back after more than
  30 days may use its expired certificate only to ask for a new one, which the leader gives unless the machine was
  disconnected.
- **The authority's key** is not offline, honestly: joining without typing means a machine must sign. It sits in the
  database, encrypted with the company secret; only the leader uses it.
- **Joining**: a one-use join command from the Machines tab, 24 hours, as today. Only computers of the CEO and of
  people who see the whole company hold data (3.3).
- **Secrets**: a data machine holds `HORNHOOF_SECRET`, `NODE_KEY`, the encrypted authority key, both stcp secrets and
  the whole database, as much as the server today. A worker holds its certificate, its node keys, the `app` stcp secret
  and its owner's sealed plan credentials.
- **Backups** (3.8): a holder learns that the company exists, how big each bundle is, when it was made and which machine
  signed it; it cannot read the content. A machine whose owner lost whole-company scope can still read the bundles from
  while it was trusted, until holders roll them over within 12 hours (or longer, if it kept some), and nothing newer:
  later bundles are sealed without it, to a renewed recovery key. Only data-role certificates sign bundles. A recovery
  file opens every bundle of its key: keep it like a password.
- **A stolen machine**: the CEO presses Disconnect. The leader revokes its certificate and node keys, changes the stcp
  secrets and gets a new link key (needs a "change key" call at the relay, added to the contract); a banner then asks
  the CEO to save the recovery file again. A stolen data machine still holds a copy of everything, so the card says to
  change the company secret and the API keys, and recommends FileVault or LUKS. A stolen worker's owner must revoke the
  Claude token, valid a year, at claude.ai; the card says so.

## 11. Phases

**Step 0: plans on any machine** (section 7), on today's single server, with the machine keys of 3.8.

**Network phase 1, 1 to 5 machines**: everything in sections 3 to 10 that phase 2 does not list, the server order (3.3),
splits (3.6) and backups (3.8) included, with the relay contract and its tests first. It must pass the lab and the real
tests of section 12 with no confirmed write lost.

**Phase 2**: phased migrations with the lint, so copies stop remaking themselves; incremental rejoin; Nebula if Docker
Desktop passes the test; more than 3 data holders (5 from 10 machines). **Phase 3**: phones as workers.

## 12. Testing

- Keeper decisions as a pure function of observations and two clocks, table-tested: each row of section 4, clock jumps,
  late ticks, slow replies, generation changes, a relay that frees names at once or after 30 s, re-entry, aborts before
  and after B's term, the 2-minute split with and without internet, an "on" record with an old heartbeat or generation,
  one data machine and its first copy, a split leader waiting for the old one, split sides meeting with no arbiter.
- Server order: the score from recorded measurements, the 95% class first, a newcomer under 3 days below the rest, ties
  by owner then join date, no swap at a lead of 5 points or less; pins kept while the rest rank around them, Automatic
  unpinning, a pin ending at number 1; number 1 always the leader and the new leader 1 after a takeover, the old one
  ranked again and never given the server back without "Move the server here"; the sync copy the lowest number up and
  keeping pace, a higher one named when the lower is away, a lower one that catches up replacing it through "sync off";
  "Move the server here" on a copy that is not sync or is behind, making it sync and waiting for it; a machine ranked
  into the first three getting its copy first while the one ranked out keeps its own, at most once a day; "Move the
  server here" on number 4 making its copy first; a split side following the last normal leader, else its sync copy,
  else its lowest number in the order of the last normal term; two split leaders, each 1 in its own copy, meeting with
  no arbiter and choosing by the saved order; after a merge the order recomputed, and one place pinned to two machines
  on two sides a CEO conflict; "Does not take the server" refused on the leader and on the only up-to-date copy; the
  leader dying in a relay outage of 90 s leaving its sync copy a CEO question.
- Relay contract (R1 to R5) against a real frps 0.71.1 (`Dockerfile:42`) and the fake relay: a second registration, a
  load-balancer group and a second live login with one client id are refused; two companies on one machine log in side
  by side; generations survive restarts; errors never read as empty; eviction stays in its bound; the sync record is
  taken only from the holder, answered once on disk, kept across a restart, and off when missing.
- Real Postgres 17.11 pairs, `linux/amd64` with `linux/arm64`, since PGlite has no logical replication
  (`apps/server/test/global-setup.ts:4`): replication, files, sequences, the journal; fence 1 after lease end and for a
  normal lease with no sync; fence 3 once the copy disabled its subscription; a terminated commit wait reaching the
  caller as an error; the agent role cannot disable a trigger, set `session_replication_role`, touch `net_local`,
  `applied` or `tool_calls`, or use anything in `net` but `assert_lease`; `PREPARE TRANSACTION` refused; revokes back on
  a new copy before `lead`; the planned switch reaching W over checkpoints only; a third copy remade after an unplanned
  switch; rollback with slots.
- Merge: the `turns` and `tasks` cycle, skipped sources, three sides, one split number on both sides; a proven overwrite
  applied; an unproven difference a conflict with the leader's value kept; a stale absence not read as a deletion and a
  stale value not read as a change; a row whose parent is gone a conflict; a bulk pick by table, side and time range;
  the completion set check finishing with applied, skipped and conflicted ids; an async copy's write the new leader
  lacks merged before its remake; a bundle older than the 7-day pruning restored, then a machine returning with newer
  confirmed writes: nothing confirmed on the leader changes without a pick, and those writes are added or shown as
  conflicts.
- After an older restore, an X with no missing ids is still compared row by row before it drops its database.
- Two forks' `task_events` with one number stay apart by uuid.
- One email invited on both sides goes to the CEO, a broken task check to the orchestrator, and the merge finishes.
- Orchestrator SQL: no cancelling another session of one's own role; the parser refuses `COMMIT`, `SET`, `SET
  CONSTRAINTS`, `DO`, `CALL`, `PREPARE TRANSACTION` and the refused functions, `lo_from_bytea` and
  `set_config('transaction_timeout', ...)` among them, also after a first statement; `set_config('synchronous_commit',
  'local', true)` still ends in a commit that waits; a text sleeping past the lease fails before `COMMIT`; a waiting
  commit cancelled by a superuser or a deliberate `statement_timeout` reaches the caller as an error.
- Node and front: messages survive a node restart and apply once; a retried invocation id gets the stored answer, and
  two identical calls both run; a run tool retried after a switch answers "started, result pending"; a superseded job's
  agent gets the move message; a built-in node's turn survives a planned switch; a saved work folder leaves files and
  index untouched and holds untracked files.
- install and updater (as `apps/server/test/install-script.test.ts`): four companies taking ports at once, a stale lock,
  a pruned company keeping its ports; the maintenance state surviving a keeper restart and a rollback; a lost
  whole-company scope revoked at once, an offline machine's later upload through the restricted endpoint, then the wipe
  with its plaintext dumps; a fork dump written only as a bundle.
- Backups and certificates: a holder cannot decrypt; a swapped file, a bundle sent as a challenge and a bundle a worker
  signed are refused; a fresh machine with the recovery file gets bundles from a surviving worker and restores, one
  without it gets none; a restore names a newer machine, which later merges. A worker's certificate reaches only the
  app and backups, never `db`.
- Git: while split, a non-fast-forward push lands on `<branch>@<machine>`, never forced, and otherwise fails as today;
  saved folders arrive as branches.
- A lab of 5 Docker-in-Docker machines, a local frps with the contract, `tc netem` and iptables to cut links, `docker
  pause` for sleep and a stepped clock for a lagging VM: joins from 2 to 5 and back, the CEO reordering 3 data machines,
  number 1 cut off and coming back, the leader and its sync copy stopped together, a 2 and 3 split across homes, three
  homes with the relay down, a split side meeting a newer leader. A writer logs every confirmed write; a checker asserts
  that each ends up on the merged leader, and that two machines confirm in overlapping periods only while one of them
  writes under a split or CEO term.
- Real, as a first user: Ivan's Debian and Mac through the full installer command, plus a third company on both. Pull
  the Debian's power, quit Docker Desktop, close the Mac's lid, unplug a router, restart and stop the relay, update
  during a switch; time each switch and synchronous commits; screenshot the Machines tab and banners on the stand Ivan
  watches.

## Sources

- [S: PG17 restrictions] https://www.postgresql.org/docs/17/logical-replication-restrictions.html
- [S: PG17 architecture] https://www.postgresql.org/docs/17/logical-replication-architecture.html
- [S: CREATE SUBSCRIPTION] https://www.postgresql.org/docs/17/sql-createsubscription.html
- [S: PG17 client settings] https://www.postgresql.org/docs/17/runtime-config-client.html (session_replication_role,
  statement_timeout, transaction_timeout)
- [S: PG17 privileges] https://www.postgresql.org/docs/17/ddl-priv.html
- [S: PG17 signaling] https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL
- [S: SET CONSTRAINTS] https://www.postgresql.org/docs/17/sql-set-constraints.html
- [S: syncrep.c] https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/replication/syncrep.c
- [S: PG17 warm standby] https://www.postgresql.org/docs/17/warm-standby.html
- [S: pg_dump] https://www.postgresql.org/docs/17/app-pgdump.html (Warning: restoring runs the source's SQL)
- [S: pg_upgrade 18] https://postgrespro.com/docs/postgrespro/18/pgupgrade
- [S: synchronous_standby_names] https://postgresqlco.nf/doc/en/param/synchronous_standby_names/
- [S: libpg_query] https://github.com/pganalyze/libpg_query
- [S: Patroni replication modes] https://patroni.readthedocs.io/en/latest/replication_modes.html
- [S: age] https://age-encryption.org/v1 and https://github.com/FiloSottile/age
- [S: git environment] https://git-scm.com/docs/git (GIT_INDEX_FILE)
- [S: git stash] https://git-scm.com/docs/git-stash and https://github.com/git/git/blob/master/builtin/stash.c
- [S: git check-ref-format] https://git-scm.com/docs/git-check-ref-format
- [S: GitHub branch names] https://docs.github.com/en/get-started/using-git/dealing-with-special-characters-in-branch-and-tag-names
- [S: Docker Desktop networking] https://docs.docker.com/desktop/features/networking/
- [S: Nebula lighthouse] https://nebula.defined.net/docs/config/lighthouse/
- [S: Apple via TechRepublic] https://www.techrepublic.com/article/news-apple-macos-27-drops-intel-mac-support-rosetta/
- Brief research (frp conflicts and retries, Patroni, phones, pitfalls), `notes/research/2026-11-02-shared-signin.md`, and
  the four rounds of reviews of 2026-11-02 (Codex, fresh reviewer), cited by their finding ids.
