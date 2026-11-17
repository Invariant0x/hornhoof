# Tasks and turns

> In short: you write to the orchestrator, and he lays the work out as tasks, grouped in turns. Each department runs one turn at a time, and different departments run theirs side by side. Each department's head keeps connected work with one owner and splits off only the parts that are truly independent, each passing only the checks it needs. Nothing reaches the main branch until a person approves the exact commit, unless the CEO has turned on autonomous release.

![Tasks and turns](../.github/assets/tasks.gif)

## What is a turn?

The word has two meanings in Hornhoof.

- A turn is a batch of one department's work, like turn 3. Tasks come in these turns. Turn numbers count across the whole company, so the turns of one department can skip numbers.
- An agent's turn is one round of an agent's work, from the moment Hornhoof wakes it until it stops. The parts about waking agents, from "When does Hornhoof wake an agent?" on, count these.

## Where do tasks come from?

Work moves as tasks, and tasks come in turns. Nobody fills the tracker by hand: people write to the orchestrator or to a department's head, and they lay the work out.

A turn has:

- a short title;
- its main point;
- the department whose turn it is;
- one task for each goal the CEO gave it, whole, for the department that owns it;
- the way it runs.

The people's own words it came from open on a click.

A turn runs in one of two ways, chosen as it starts:

- In stages. Code work goes through the checks below: Architecture, Development, Review, Security and Tests.
- Turnkey. One employee of a sub-unit marked "Works turnkey" does the turn's work alone from start to finish. Hornhoof refuses this way while no sub-unit works turnkey.

Whoever lays out a turn, the orchestrator or the department's head, picks the way. When you put tasks from a department's off-turn list into the next turn, you pick it next to the button. A person who sees the whole company, or the department's owner, can change it on the Tasks tab while the turn is planned. Once the turn starts, its way stays.

Work given outside any turn goes through no stages: whoever gets it does it alone from start to finish.

## What does the Tasks tab show?

From top to bottom:

1. What agents wait for from people: questions to answer, commits to approve, and tasks an agent got stuck on.
2. The department you pick.
3. "The running turn and the next ones": that department's running turn and its planned turns, in order, with their tasks. Another department's turn shows here too while it holds a task of this department. The tasks given outside turns come after them.
4. The department's off-turn list.
5. The finished turns, folded away.

## What happens when I add work while a turn runs?

Each department runs one turn at a time, and turns of different departments run side by side. A new turn of a department that runs none starts at once. A new turn of a department that runs one waits as planned, after that department's planned turns, with its tasks planned too.

When people add to the work, a new goal gets a new turn of the department that owns it. Work for the goal of a turn that is not over joins that turn: in the running turn it goes to the department's head at once, and in a planned turn it waits for the turn to start. The orchestrator says where it went.

## How does a department split its task?

Each task of a running turn goes to its department's head. The head gives it out at once. Connected work stays with one owner, only truly independent parts go to different people, and a whole task can go to one developer.

In Development, each piece is a whole feature for one developer of the pool. When the feature is new or large, an architect writes a short design note first.

## Which checks does a piece go through?

In a turn that runs in stages, Development uses one route for each executable task:

- Architecture writes the plan when the task is large. Small tasks start at Development.
- Development produces the change and its checks.
- Review checks the work and repairs its findings in the same branch.
- Cleanup runs after Review only when the head explicitly enables it for the task or turn. It is off by default and uses the existing dev-cleanup skill.
- Security checks sensitive work when the head requires it or Review discovers the risk.
- Tests verifies the final candidate, including repairs, using applicable checks and verified results at the same influencing fingerprint. Mutations cover only changed pure functions with fast tests.

A task given to a member of a sub-unit marked "Works turnkey" goes through none of these stages: that member does it alone from start to finish and closes it.

Each stage has one current owner. Review is required even when only one provider or subscription is available. The checker must use a model at least as capable as the producer's; an eligible different provider is preferred when available.

A coordination task with no executable result closes with a checked report and valid reviewed child results. An unfinished, unaccepted or stale child blocks that report. A parent that produces its own executable result follows the route above.

## How does a member work its piece?

1. It works the task in a branch.
2. When it cannot go on, it marks the task blocked, which asks its head. The head answers with a comment, and that opens the task again once. If the task comes back blocked after that, the head writes the answer into the task, which opens it again.
3. It hands the task in, with evidence.
4. The current stage owner checks and repairs the same branch, records its findings and exact candidate, then passes the task forward.
5. Tests verifies that final candidate. The authorized head accepts the exact checked result through the task's integration route. Main and release still require the authorized person's approval of the exact commit.

Review and Security keep their own repairs, and nothing goes back to an earlier stage. Work that solves the wrong problem is escalated to the head. A failed applicable check stays visible; an old receipt cannot certify a newer repair. When the candidate's own change passed and it only needs the main line taken in, it stays at Tests: Tests takes the main line in and checks again.

## When does the head report?

The head hears once, when every task it gave out under its department's task is closed. Then it reports to the orchestrator.

## Can a task wait for other tasks?

Yes. A task can come after other tasks of its turn. It waits, and its member is woken by itself once the last of them is done.

When one of those tasks is cancelled, whoever made the waiting task is told.

## When does a turn end?

Once every task of the turn is closed, the turn ends. The department's next planned turn starts by itself.

## How do I see how a turn went?

Open a department, then "Speed", then "Report", and pick any turn that ran. You see that department's time from issue to acceptance, its critical path apart from the sum of agent hours, time by stage, waits by reason, returns, failures, interrupted turns, numbers by kind of task, quality after release and test time by package and file. Each number comes with its change in percent to the department's previous turn that ran and to its starting turn: turn 7 when that is a finished turn of the department, or else the department's first finished turn.

Hornhoof saves a turn's numbers as it closes, before the next one opens. A turn closed before this existed is worked out from its events the first time someone reads it, and the report says so. Bugs found later keep counting after that, since they turn up later.

Only people who reach the whole department see its report. The orchestrator reads the same report with `pipeline_report`.

## What are a task's kind and risk class?

The head or the orchestrator can say what kind of work a task is (bug, known behavior, unknown path, legacy code) and what a mistake in it would touch (money, access, security, data or none). They show on the task and in its tools, and the report counts by kind. Changing them wakes nobody and leaves the task where it stands.

## When does Hornhoof wake an agent?

When there is something for it:

- a task given to it;
- work assigned to its current stage;
- a decision or repair assigned by the head;
- an answer from a person.

## What if an agent stops moving its task?

An agent that ends one of its turns without moving its task is reminded. After three such turns in a row, it stops, and a person is asked how it should go on.

Some turns count as going on instead:

- a turn that broke;
- a turn in which the agent wrote in the task how far it got;
- a turn that worked until its time ran out.

A person is asked only after eight such turns in a row. That is about six hours of work without handing anything in.

## What if an agent keeps breaking down?

Three turns in a row on a task that break within minutes of starting stop Hornhoof waking the agent there. Whoever gave the task out hears it once, with the error, and the task waits for them.

## Which turns are not counted?

- A turn that ends without moving its task while the agent's plan is at its limit counts for neither. Another employee may take the task over, as [Machines and plans](machines-and-plans.md#what-happens-when-a-plan-hits-its-limit) explains. Otherwise the agent goes on once the limit starts over.
- A turn a person stopped does not count.
- Nothing is counted while the agent has another turn waiting on the task, or while the task waits for the tasks it gave out or for people.

## Share a file on a task

An agent on a task can put a file on it, such as a build, a log or a data set of up to 50 MB. It runs this on its machine:

```sh
hh-attach --task 12 FILE
```

Any agent of the company downloads the file by its name, on any machine:

```sh
hh-fetch 12 FILE
```

The task's view lists its files.

## How much room do task files have?

The files live in the database, so every copy of the database carries them.

- One file can be up to 50 MB.
- One task holds up to 500 MB of files.
- The whole company holds up to 2 GB, or as many megabytes as `TASK_FILES_MB` in `.env` says.
- The files of a turn go 30 days after it closes.

A comment, message, report or reason that carries a file pasted as a long run of base64 or hex is refused. The refusal says how to put the file on the task instead.

## How does an agent read a page that scripts build?

An agent of any department runs this on its machine:

```sh
hh-browse --screenshot page.png https://example.org/
```

The machine's own browser opens the page and waits until the page has loaded and drawn what its scripts build. The agent gets the page's visible text, its links and, if asked, a picture to put on a task with `hh-attach`.

- It opens only public http and https addresses. It refuses the machine itself, private networks and cloud metadata addresses, also when a redirect, a page's script or a name's address points there.
- Each call has a time limit of 30 seconds and may load 20 MB, and both can be changed within limits. `hh-browse --help` lists them.
- The browser signs in nowhere and gets past no robot check. A page that asks for either answers `login_required` or `robot_check`. The agent notes the address for a person and goes on with the other addresses.
- When the call ends or fails, its browser processes and temporary files go with it. The picture stays.

## Who can give a department a task?

Anyone whose access lists a department can give it a task, from inside the department, with "New task". It goes to the department's head, and joins the department's running turn if one runs. A department set to "Works all the time" runs no turns, so its tasks come outside turns. Operations starts that way.

## Who approves what reaches the main branch?

Nothing reaches the main branch until someone who sees the whole company, or the orchestrator, approves the exact commit. The department's people see it waiting.

The one exception is autonomous release. Only the signed-in CEO turns it on or off, for the whole company, with the switch among a department's approvals. While it is on, an exact commit for the main branch goes in without that approval when a whole test run of its release passed on it, on the main branch or a release branch, a PASS from another employee who checked that commit, and a fast-forward path from the main branch. The "Autonomous release log" next to the switch lists each such commit.

[Back to the guide](README.md)
