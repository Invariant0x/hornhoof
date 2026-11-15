# Network phase 1: the run on two real machines

**All six findings of this early run were fixed and checked on a test stand before release 0.23.6.** The page keeps the
run as it was measured on an early build; the places in the code it names are as they were then.

The run of 14 November 2026 (all times UTC), on build `eb17b961` of the network branch, with images from the registry
by their commit tag. It was stopped after step 3: the first three rows are as measured, the rest were not run on this
build. The second part of this page lists what the run found.

Two computers on one local network, both Macs with Docker Desktop: machine A, where the company was installed and which
led first, and machine B, which joined by the command from Machines. The company was a throwaway one, installed by the
branch's `install.sh server --name`, set up through the API, with a real link and a real certificate at hornhoof.org.
Both computers also ran nodes of other companies the whole time, which were not touched. A writer on each machine made
a task every 200 ms through the company's link, and a recorder on each wrote once a second what the machine's own
door, its keeper and the link said. The router step was left out.

## What happened

| Time | What |
|---|---|
| 00:57 | Installed on A, set up, link taken, certificate issued. |
| 01:00 | B joined. 01:04 it took place 2. 01:06 its copy was being made. 01:15:05 the copy was ready. |
| 01:14:37 | A: "Another machine holds a copy of the data: this machine leads only while hornhoof.org or that copy vouches for it." |
| 01:14:46 | A: "The lease ended (no renewal for 10 s)". The company only read until 01:15:16, when A led again under term 2. |
| 01:17:58 | Writers started. With A leading and the copy reached only through hornhoof.org, a task took about 3 s to confirm. |
| 01:21:00 | The path between A and B through hornhoof.org was gone for about 10 s. A stopped waiting for the copy; a task took 0.45 s from then. |
| 01:22:13 | The last task A confirmed. A's power button was held until it was off (step 1). |
| 01:22:43 | B: "This copy may lack changes; asking the CEO." The page on B showed the question, and a sign-in on the reading machine worked. |
| 01:23:36 | The CEO answered "Go on from B". 01:23:47 B led under term 4. 01:23:48 the first task was confirmed through the link again. |
| 01:27:03 | B's link was gone for 3 s ("this keeper's own link does not hold the company's route now"). |
| 01:28:46 | A was back (step 2). 01:28:49 it followed. 01:29:01 what it did while it led was saved. 01:29:37 its new copy was ready. |
| 01:33:30 | A Docker network on B that covered the home network was removed (see below). The direct path was open both ways from then. |
| 01:36:41 | "Move the server here" for A (step 3). 01:36:43: "The server stays here: A was not ready to take it." |

The merge of A's database from when it led was tried on B at 01:31:08, 01:32:09, 01:34:08, 01:38:05 and 01:46:05. Each
try took about 10 s and ended with "The merge stopped: Failed query: commit".

## The result

| Step | Done? | Seconds, measured | Spec says | As expected? |
|---|---|---|---|---|
| 1. Power off the leader | yes | The question after 30 s. B led 11 s after the CEO's answer. The writer's gap was 94 s, 53 s of them the answer's delay. | The copy leads by itself in about 60 s | No: a question, not a takeover by itself. Nothing was lost. |
| 2. The old leader back | yes | It followed in 3 s, was saved in 10 s, and its copy was ready 51 s after its start. | Its copy catches up or is remade, the server stays | Partly: remade, and the server stayed, but its merge never ends, so the new copy is never swapped in. |
| 3. Move the server back | asked | Refused in 1 s, "not ready". | About 10 s | No. |
| 4, 5, 6, 8, 9, 10, 11, 12 | not run on eb17b961 | | | Left for the build with the fixes below. |
| 7. Router | not done | | | Left out. |

Every task the company confirmed was there at the end: 4244 confirmed of 4332 sent, none missing in the leader's
database, none missing in A's new copy. With B leading and the copy waited for over the direct path, a task through
the link took 476 ms at the median and 621 ms at the 99th percentile.

## What the run found

Each finding with what was seen, where it was in the code, the test it called for and the direction of its fix. All six
are fixed, as the note at the top says.

### 1. The merge of a returned leader's database never commits

Seen: `net.merges` on the leader held one row, source `machine:<id>:led-2`, status `pending`, with `fork`, `cutoff`
and `counts` empty, `tries` going up, error "The merge stopped: Failed query: commit". At each try the app logged "A
transaction of work outside a request ran 10508 ms" (9277 ms at the fifth), Postgres refused the commit with "This
machine holds no lease now, so nothing was changed" (`net.assert_lease('0 s', NULL)` in `net.fence_check()`), and
every write of the company waited for as long as the try lasted: both writers stalled for 10.4 s at exactly each try.

Sampled in `pg_stat_activity` during the fifth try: the merge's session was one transaction, "idle in transaction",
waiting on `ClientRead`, for nearly all of its ten seconds. It sat idle for about 2 s after a query of the catalog's
foreign keys, and again after `SELECT below FROM net.horizon`. Nothing blocked it (`pg_blocking_pids` was empty) and
no other session was active. So the app holds the merge's transaction open while it does something that is no query
on the leader, most likely reading the returned machine's database over the peer link, about 2 s a step. The commit
was refused also when the whole try took less than a lease, so the lease seems not to be renewed while that
transaction stands.

What follows from it: the returned machine keeps the database that led and never swaps its new copy in
(`copy-state.json` said `phase: ready`, `database: hornhoof_next`, `swap: null`), a planned move to it is refused as
"not ready", and the company stalls for 10 s at every retry, for good.

Where: `apps/server/src/modules/merge` (`merger.ts` for the retries, `apply.ts`, `source.ts` and `read.ts` for the
step that is still `pending`), and the lease check of `net.assert_lease` and `net.fence_check` in the network's
migrations. The lab's merges read their source on the same host in milliseconds, which is why `takeover.lab.ts` and
`merge.lab.ts` pass.

Test first: a merge whose source answers each read after 2 s. It must end, the lease must be renewed meanwhile, and a
write made during it must not wait for it. Direction: read the source outside the transaction that stops writes, or
let the merge go in steps that each fit a lease.

### 2. The lease ends 9 s after the first copy is ready

Seen on A: at 01:14:37 the keeper said that another machine holds a copy, at 01:14:46 "The lease ended (no renewal
for 10 s): the sessions of the app and the agents were ended", then "No public link: the tunnel waits", "This machine
does not lead yet: it waits for the relay's window", and at 01:15:16 "This machine leads under term 2". Thirty
seconds in which the company only read. Afterwards the question at `/api/network/lease` through the link, asked by
hand from inside the keeper's container, came back in 0.3 to 0.9 s with this machine's own id, and the lease held.

So in the nine seconds after proofs began to be needed, neither proof came: no answer of its own through the link,
and no beat of the copy saying it follows this term. Not found: which of the two failed and why. At that moment the
copy reached the leader only through hornhoof.org (finding 5).

Where: `apps/server/src/modules/keeper/proofs.ts` (`LeaseProofs.tick`, `proof`), `lease.ts` (`renewOnProof`),
`keeper.ts` (`readNeeded`, `prove`, `linkWanted`). Test first: a leader whose first copy finishes while its link
probe takes a second to answer keeps its lease. Direction: let the lease that stood before proofs were needed stand
until the first proof had its chance, and log which proof is missing when a renewal is skipped.

### 3. hornhoof.org does not store which machine holds the latest changes

Seen: "Could not tell hornhoof.org which machine holds the latest changes" at 01:14:48 on A ("this keeper's own link
does not hold the company's route now") and at 01:23:45, 01:27:03 and 01:28:47 ("hornhoof.org did not store it
(unknown)" once, the route missing the other times). The client reports "unknown" for a request that failed, for any
status but 200 and 409, and for an answer that does not echo what was posted; the relay answers 503 "unknown" when it
cannot tell whether the route is live. The relay writes no line for these requests, so which of them it was cannot be
read afterwards.

What it cost: at 01:21:00 the path through hornhoof.org dropped for about 10 s and the leader stopped waiting for the
copy. It had not started again 70 s later, when the leader's power went. A copy that commits were not waiting for
cannot prove it holds everything, so it rightly asked the CEO where the spec expects a takeover by itself.

Where: `apps/server/src/modules/keeper/sync.ts` (`post`), `apps/server/src/modules/link/relay.ts` (`setSync`), and
the relay's `sync_answer`, `set_sync` and `locked_route_of`. Test first: after the copy was silent for ten seconds
and came back, commits wait for it again within a stated time, and the record at the relay names it. Direction: say
the relay's status and error code in the keeper's line, and have the relay log a refused sync record with its reason.

### 4. The leading keeper's link drops for seconds now and then

Seen: at 01:21:00 and 01:27:03, about six minutes apart and six minutes after the lease's end at 01:14:46, the
keeper that led lost its link for 3 to 10 s with no cause in its own lines: "this keeper's own link does not hold the
company's route now", "No public link: this machine is not offered to its peers through it", and the peer client
started again. After the direct path opened the keeper said nothing more of it, but the recorder still saw the link
give no answer for a second at 01:36:31 and at 01:42:36, six minutes apart again. So something on the way through
hornhoof.org, or in the keeper's own link client, hiccups about every six minutes.

Where: the link's settings reader in `keeper.ts` (`linkSettings`, `settingsNow`, `ownLink`) and the peer link's
`offer` in `peer-link.ts` and `follow.ts`. Direction: when the settings read comes back without a link, say why
before the tunnel is stopped, and do not stop a tunnel on one empty read.

### 5. Docker networks that cover the home network

Seen: on B a compose network of another project had the subnet 192.168.0.0/20, which holds every address from
192.168.0.0 to 192.168.15.255, and the home network was inside it. B's containers reached the internet but no machine
at home, while B itself reached them all and A's containers reached B. The product said so ("Reaching the company's
server through hornhoof.org as well") and went on through hornhoof.org, which is why a task took 3 s while A led.
Docker hands compose networks out of 192.168.0.0/16 in pieces of /20; Hornhoof's own network on B was
192.168.48.0/20. On a computer with a few compose projects one of them, Hornhoof's included, can land on the owner's
home range.

### 6. Several Hornhoof projects on one computer, several companies in one network of computers

A requirement, not a wish: one computer may hold two, three or more Hornhoof projects (companies, nodes, test
stands), and one network of computers may hold two, three or more companies. So:

- The installer and the network keep their Docker subnets apart from each other and from the computer's own
  addresses. A company's compose network is given a subnet that covers no address of the computer and no subnet of
  another Hornhoof project on it, and the installer says so when it cannot.
- Keepers, relay names and ports of different companies on the same machines do not collide. Ports are already kept
  in the registry of the volume `hornhoof-ports`; the same care is owed to compose project names, the names a keeper
  registers at hornhoof.org, the peer link's client ids, and the folders under the home folder.
- The guide says what to do when a machine at home reaches the others only through hornhoof.org.

Where: `scripts/install.sh` (the port registry, `project_elsewhere`, the compose project's name), `compose.yaml` and
`compose.worker.yaml` (the `internal` network), the updater's `write_addresses`. Test first: an install on a computer
whose address lies in the subnet Docker would hand out next gets another subnet, and two companies installed on the
same two computers each lead, copy and switch without touching the other.

## What is left on the machines

The throwaway company of `eb17b961` and its link name at hornhoof.org were removed before the second run on `64551f6a`.
