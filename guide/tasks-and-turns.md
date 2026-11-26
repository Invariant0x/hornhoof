# Tasks and turns

> In short: you write to the orchestrator, and he lays the work out as tasks under goals, each with one person who answers for it. The Tasks tab shows that work as a list, a board and a graph. Each department releases its work in turns, and different departments run theirs side by side. Each department's head keeps connected work with one owner and splits off only the parts that are truly independent, each passing only the checks it needs. The department's commit rule says when main or a release needs approval. The checks still apply to the exact commit.

![The task tracker: a list, a task's card and the board](../.github/assets/tasks.gif)

## What is a turn?

The word has two meanings in Hornhoof.

- A turn is one release of a department's work, like turn 3. A task joins its department's open turn when its result is accepted into the turn's branch, and the release closes the turn. Turn numbers count across the whole company, so the turns of one department can skip numbers.
- An agent's turn is one round of an agent's work, from the moment Hornhoof wakes it until it stops. The parts about waking agents, from "When does Hornhoof wake an agent?" on, count these.

## Where do tasks come from?

People write to the orchestrator or to a department's head, and they lay the work out as tasks. Anyone whose access lists a department can also give it a task in the tracker. Work flows: a new task goes to its department's head at once, and nothing waits for a turn, unless every slot of a Development department is busy (see "What are slots?" below).

A task runs in one of two ways:

- In stages. Code work goes through the checks below: Architecture, Development, Review, Security and Tests.
- Turnkey. A task given to a member of a sub-unit marked "Works turnkey" goes through no stages: that member does it alone from start to finish.

## What are slots?

A Development department runs its turn in slots: one for each developer, five at most, and each slot holds one task. A small addition to the same product joins a slot that is running instead of taking another. A new task that finds every slot busy waits in the department's queue for the next turn: nobody is woken for it, its card says "Waits for the next turn" (or the one after it, in batches of the slots), and the Turns and releases screen lists the queue by the turn each task waits for. When a release ends the turn, the turn that opens takes the queue in, in order, each task to the developer it was given to or to the head. A queued task you cancel leaves the queue; one made urgent goes past it at once. Urgent work takes no slot and waits for nothing. Work given to a named developer waits for that developer and never goes to another when they are busy. A department with no slot cap hands every task out at once, as before.

## What does the Tasks tab show?

The Tasks tab is the tracker. It opens on your own work.

On the left:

- "Waits for me": what agents wait for from you, such as questions to answer, commits to approve and tasks an agent got stuck on, and the orchestrator's cards.
- "My tasks": the open tasks and goals you answer for.
- "Working now": the tasks employees work on at this moment.
- "Responsible": the people who answer for departments and goals, each with how many open tasks they have.
- "Departments": each with the person who answers for it, its goals, pipelines and employees, and what each employee does now.
- "Turns and releases": each department's next release and the releases out already.

At the top you see where you are, a search over every task, and three ways to look at the same work:

- List: tasks grouped by status, with who does each, who answers for it, its goal and its date. Work under a task opens under it.
- Board: columns by status. With a pipeline picked, the columns are its stages.
- Graph: a map of a goal with its smaller goals, tasks and the work under them. Solid lines show what is part of what, dashed lines show what waits for what. Drag it, zoom it with the wheel or the zoom bar, and open any part of it.

Filters pick tasks by status, by who does them, by who answers for them and by goal. The CEO and the CEO's delegates can look at the screen as any other person sees it with "View as". It only filters: nobody sees more than they could before.

Every task, wherever you click it, opens the same card: its goal and the task above it, why it exists, who answers for it, who does it, its pipeline and stage, its date, how long it stands in its status, how long it was worked on and whom it waits for, the work under it, what it waits for and what waits for it, its files and its history in plain words.

## What are goals?

A goal says what the work is for, like "500 subscribers by March". A company goal splits into department goals and smaller goals, as deep as you like. Each task serves one goal; work under a task serves the goal of the task above it.

A goal can have a number to reach. Its progress is that number against the target, or else how many of the tasks under it are done. Cancelled tasks do not count.

The CEO and the CEO's delegates set company goals. A department's goals are set by anyone whose access lists the department, by its head, by its product manager and by the orchestrator. A product manager makes responsible for a goal only the person who decides for the department or the one already on it.

When a department is removed, its goals stay as goals of the company, and its pipelines go.

## Who answers for a task?

Each task and goal has one person who answers for it. You can name that person when you give the task. Otherwise it is the person who answers for the task above it, or else for its goal, or else the person who decides for the department.

When that person is switched off, or loses access to the department, their open tasks and goals pass to the person who decides for it, with a line in the history.

Whoever acts on a task's work can change its title, short text, why, goal, the person who answers for it, its date and its pipeline. Such a change wakes nobody. Who does the work and its status come only from the work itself: nobody drags a task to another column.

## What is a pipeline?

A pipeline is a department's map of who hands work to whom: stages in a tree from the first one, with forks, each owned by a role or one employee. It gives out no work and moves none. A task on a pipeline stands in the stage of whoever holds it now; when its holder owns no stage, it stays where it was.

A department has no pipeline until someone draws one. Its product manager drafts them from the department's roster and its work, and its people, its head and the orchestrator can change them.

## What does the product manager do?

Every department has a product manager. It keeps the department's work clear for people: a short human title, a why, a goal and a person who answers for each task, current numbers on the goals, and the pipelines. It wakes a few minutes after a task or goal of its department is made or changes status, at most every 15 minutes, and on a slow timer.

It never gives out work or changes who does it, its status, urgency, pause, waits or route: that stays with the head.

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

A coordination task with no executable result closes with a checked report once every child is done or cancelled, however each one closed: through its stages, by the orchestrator or by hand in the database. The report names each child's accepted result, or says that the child closed without one; only a child still open holds it back. A parent that produces its own executable result follows the route above.

The orchestrator can close any task in any state, done or cancelled, with its reason in the task's log. Open work under it is cancelled with it. Closing a task done this way accepts no result and puts nothing into a release or main.

## How does a member work its piece?

1. It works the task in a branch.
2. When it cannot go on, it marks the task blocked, which asks its head. The head answers with a comment, and that opens the task again once. If the task comes back blocked after that, the head writes the answer into the task, which opens it again.
3. It hands the task in, with evidence.
4. The current stage owner checks and repairs the same branch, records its findings and exact candidate, then passes the task forward.
5. Tests verifies that final candidate. The authorized head accepts the exact checked result through the task's integration route. For main acceptance and release, follow the department's commit rule. Any required approval names the exact commit.

Review and Security keep their own repairs, and nothing goes back to an earlier stage. Work that solves the wrong problem is escalated to the head. A failed applicable check stays visible; an old receipt cannot certify a newer repair. When the candidate's own change passed and it only needs the main line taken in, it stays at Tests: Tests takes the main line in and checks again.

## When does the head report?

The head hears once, when every task it gave out under its department's task is closed. Then it reports to the orchestrator.

## Can a task wait for other tasks?

Yes. A task can come after other tasks of its turn. It waits, and its member is woken by itself once the last of them is done.

When one of those tasks is cancelled, whoever made the waiting task is told.

## When does a turn end?

The head records the department's release, the main branch moves to its commit, and the version tag closes the turn. What the release left out goes into the next turn.

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

The files live in the company's file store, not in the database. Each file is kept sealed on as many of the company's machines as the CEO sets in Company settings, two by default, one copy to a machine, so losing one machine loses no file. The database and its backups keep only each file's name, size and hash.

- One task holds up to 500 MB of files.
- The whole company holds up to 2 GB, or as many megabytes as `TASK_FILES_MB` in `.env` says. The same content counts once, however many tasks carry it.
- The files of a turn go 30 days after it closes.
- The files of a task outside any turn go 30 days after the task closes.
- The logs and files of a test or work run go 30 days after the run ends.
- A file that no task, message or run names any more leaves the machines a day later.

## Which machines keep the files?

Every machine of the company with a keeper gives the files an area of its disk, 10 GB unless its owner sets another in the machine's settings, or none. For each file the leading machine picks as many machines as the CEO asked for, or as many as keep files when there are fewer:

- the leading machine first, when its area has room, as it reads the file at once;
- then one off site, so a house lost to fire, theft or flood takes no file with it;
- then the one with the most of its area free.

A machine away for up to a day, as a laptop asleep, keeps its files and takes the new ones once it is back. A machine away for longer has its files copied to another one, and lets them go when it comes back. A machine whose area is lowered or set to none, or a lower number of copies, lets a file go only after the other machines keep it as many times as asked. With no room elsewhere the file stays where it is, and Company settings shows what waits.

## How do files leave the database after an update from 0.43?

After the update the server copies each file of the database into the store while it serves, checks each one there by its hash, and reads it from the store from then on. It deletes nothing by itself: the bytes stay in the database until the CEO says yes.

- A file counts as copied once the machines picked for it keep it, as many as the CEO asked for, whether or not they are online at that minute.
- Once every file on the server is copied, the server writes a reconciliation in its log: how many files, distinct contents and bytes, how many files are not on this server (a big file kept on another machine's disk, or one lost before), the size of the database, and a digest of the list of every file's id, sha256 and size.
- The CEO, or the orchestrator for him, reads it with `GET /api/files/move` and says yes with `POST /api/files/move/approve` and that digest. Nobody else can.
- Only then does the server clear the bytes of exactly the files on that list, each only while the database still finds them the bytes the store keeps. It then drops the old column, gives the database's room back with `VACUUM FULL`, and writes its size before and after.
- Until then the two rules that came with the store wait too: the files of tasks outside any turn and of old runs stay. The files of turns closed 30 days ago go as before.

A comment, message, report or reason that carries a file pasted as a long run of base64 or hex is refused. The refusal says how to put the file on the task instead.

## How does an agent read a page that scripts build?

An agent of any department runs this on its machine:

```sh
hh-browse --screenshot page.png https://example.org/
```

The machine's own browser opens the page and waits until the page has loaded and drawn what its scripts build. The agent gets the page's visible text, its links and, if asked, a picture to put on a task with `hh-attach`.

- It opens only public http and https addresses. It refuses the machine itself, private networks and cloud metadata addresses, also when a redirect, a page's script or a name's address points there.
- Each call has a time limit of 30 seconds and may load 20 MB, and both can be changed within limits. `hh-browse --help` lists them.
- The browser signs in nowhere and gets past no robot check. A page that asks for either answers `login_required` or `robot_check`. At a sign-in the agent signs in itself in a real browser on its machine, with the login and password from the vault, and asks a person only for a code sent to their phone. At a robot check it notes the address for a person and goes on with the other addresses.
- When the call ends or fails, its browser processes and temporary files go with it. The picture stays.

## Who can give a department a task?

Anyone whose access lists a department can give it a task in the tracker. It goes to the department's head at once. A department set to "Works all the time" runs no turns, so its tasks come outside turns. Operations starts that way.

## Who approves what reaches the main branch?

The department's commit rule says whether main acceptance or a release needs approval. With no rule set, neither needs an approval card. When approval is required, the person responsible for the department can approve the exact commit on the task, as can the orchestrator acting for the owner. A release that brings work no check covers is the exception: whatever the rule, it is recorded only after a person approves it on a card that lists exactly that work next to Approve, and autonomous release never approves it. Hornhoof writes that list itself, apart from the words of whoever asked, so a plain-words explanation above it never hides it.

The head still accepts the exact checked candidate and Hornhoof verifies it is included in the observed main commit. To release a turn, record the release before main moves. The repository's own CI must be green on the exact commit of the turn branch: Hornhoof reads the GitHub Actions runs of that commit from the repository's host when it records the release, never from anyone's word, and every job of every run must have finished with success. Only the full runs of the repository's release workflow, which a person names in the repository settings, count: runs started by hand with the input `full`, which run every test. A skipped test job makes a run red, and commit statuses and the checks of other apps prove nothing. Where no such run is on the commit yet, `release_turn` starts the release workflow with `full` set on the turn branch itself, once for each commit, and the minute round records the release when CI is green. Red or unfinished CI refuses, naming the failing check and its link, a repository on another host than github.com refuses as unreadable, and a repository with no CI records with no run. Main must be able to fast-forward to it, and the version tag must name that same commit.

The people who run the department can enable autonomous release, including through the department's head acting for its people or through the orchestrator. When enabled, it can satisfy a rule that requires approval. For main acceptance, it records proof before the push from the repository's green CI on the exact commit (or none where the repository has no CI), an independent PASS verdict on the exact commit and a verified fast-forward path. For a turn release it also checks that the release covers only work with evidence from another employee or, for turnkey work, from the employee who did and checked it. Turnkey work counts as checked only from the commit its employee named on closing it down to the commit right under its first own commit, along that branch's own line, and never what the turn branch already held when the work started: Hornhoof notes where the turn branch was as the work starts and refuses a start named under it. A commit someone else put under or on top of it, a merge made on the turn branch, or work whose start Hornhoof has no record of, is listed for a person. The **Autonomous release log** lists the proof it recorded.

[Back to the guide](README.md)
