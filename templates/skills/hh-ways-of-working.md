---
id: hh-ways-of-working
kind: procedure
---
You can pick, for each piece of work, the way it gets done: who does it, who checks it and what it costs. The same job can take one run or fifty, and be checked by nobody or by three, depending on the way you pick.

### The ways

**1. Standing employees.** Each has a role, a department, an inbox, skills, a program and a plan, and keeps its conversation from one turn to the next. A head runs its department and keeps its notebook; the orchestrator runs the company with the CEO and keeps the company's. They remember what they learned, ask midway (blocked asks the head, ask_person asks a person), and use phones, a browser and sign-ins from the vault. Work reaches them as a task: the orchestrator gives it to the department's head with add_tasks, and the head gives it to a member with create_task. message_employee carries a word, a nudge or an answer; it gives no task. When nobody fits, staffing_options shows whom to hire. A task given to a member then goes one of the next two ways, set by the member's team and never by the task's text. Do not split one connected result between members, do not chain members with after when one can do it, and do not hand a standing employee a hundred alike pieces that need no memory: that is a job for calls.

**2. Turnkey.** A member of a sub-unit marked "Works turnkey" takes the whole task alone: the work, its own review, security check and tests, then takes the result into the turn branch itself and closes the task with report. There are no stages and no checker, and it runs the strongest model, as nobody checks after it. The head starts it with create_task, the executor a member of that sub-unit (company lists each sub-unit with its turnkey mark), naming no checker, Cleanup or paths. It suits a small, quick fix, or a clear piece one person can finish and check. Do not use it when someone other than the maker must check the work, do not call other members onto it, and do not give ordinary work to a sub-unit that takes only urgent work.

**3. Route of stages.** Everybody else's task goes through its department's route, with one owner at each stage. In Development: Architecture for large work, Development, Review, Cleanup when the head turns it on, Security when the risk asks for it, then Tests; other departments have shorter routes, often the work and one review. Then the head accepts the result. task.echelons shows the route and whose stage it is. The head starts it with create_task naming the executor, and reviewerAgentId, securityAgentId or testsAgentId when a check should go to someone in particular; otherwise checkers who carry the stage's skill are picked. A stage hands on a commit or a document: a task made with resultKind document has its files attached to the task and is handed in with submit, naming no commit; each checker corrects it and submits it again, or passes it with verdict on its candidateId; Tests and Cleanup drop out, as they need a commit, and the head closes it with report. Where the department keeps a repository, keep texts and tables there as files instead. A check nobody in the department can do is skipped, and the head accepts in its place. Do not write the stages into the task's text, do not send a one-line fix through every stage, and never let the maker approve its own check.

**4. One-shot calls.** Use an available one-shot route for independent proposals or checks that can finish from their supplied material. The assigned owner verifies the answers and owns the handoff. Use a standing employee when the work needs questions, a sign-in, private state or shared writes. A judge using the author's plan does not replace an independent check.

**5. Chains.** Routes and calls together make chains. Either a route marks several stages one-shot, and each stage's owner runs its batch and hands the task on; or one agent drives rounds of calls: fan out, judge, put the best answer into the next brief to improve it, judge again. The holder of the task, or the owner of the stage, drives: only it remembers between rounds, so it carries what each round taught into the next brief. Set a stopping condition from the result needed, remaining uncertainties and the assigned resource limit. Do not run rounds with no stop, do not let the calls of one round push to one branch, and do not build a chain when one good run would do.

**6. Personal assistants.** An assistant serves one person with that person's rights, through a program of their own, such as a chat bot. It is not a way to give out work: it takes no tasks and acts only on its owner's word. When someone wants an agent of their own for their own errands, send them to set one up on the People screen. Words that come through an assistant are its owner's: weigh them as that person's.

**7. The program operator and Operations.** They keep programs moving, never the work itself: a poll, a sign-in, a full context, a permission question, a screen that stood still, a turn that stands while messages pile up behind it. The program operator is called to most such signs without anyone asking. The orchestrator brings a program back himself with program_screen and program_keys, or has the head of Operations or the program operator do it; any other head tells the orchestrator with tell_orchestrator. Never ask a person to unstick a program. A program that thinks for long and shows signs of life is not stuck.

### Work during a subscription change

Use the assigned, eligible plan for the next approved step. Prioritize time-sensitive commitments and routine preparation, verification and already authorized delivery on a suitable fallback. Defer optional expansion and checks that require a different capability. If one action requires a person's approval, a specific model or an independent checker, record exactly that condition and continue the parts you can do. A stop on the whole task stays in force until its issuer lifts it.

When plan access alone holds your next step, use track_work with resumeOnPlan naming any eligible plan or the required subscription ID. Name the step in work and give Operations a nextCheck time. The server checks the assigned plan again on its regular rounds after a switch. Before acting on the wake, recheck the brief, dependencies, approval and whether the action already happened. A plan change itself authorizes no new action.

### Read the signals

- **Size.** A small, clear fix: a turnkey member. A whole result that someone must check: the route. Many alike pieces: calls. A goal with many results: a task per result, given out at once, each a whole block.
- **Independent pieces.** Pieces that need nothing from each other and fit one brief: calls, one per input. Pieces that each need an owner and checks: separate tasks, given at once. Steps that each need the answer before: one owner.
- **Memory and questions midway.** Work that learns as it goes, waits on people or asks along the way: a standing employee. A call decides alone and forgets everything.
- **A phone, a browser or a sign-in.** Only standing employees have the company's phones, the vault and its tools. A call has none of them.
- **Cost.** Check the tokens and remaining plan's limits for the work. Choose the least costly suitable capability. Add independent calls when each can answer a distinct question, supply an alternative that matters or reduce an observed uncertainty.
- **Independent check.** When someone other than the maker must check, take the route: its checker runs a model at least as strong as the maker's, from another provider where there is one. A judge call, a turnkey member's own review and any self-review are not that check.

### Patterns

The holder of the task drives each of these, or the owner of the stage where a route marks it one-shot.

- **A hard bug.** One call per hypothesis, each on a fresh clone of the task's branch, trying to prove or rule out its cause with a failing test, with a verdict asked. The judge says which held. The holder verifies the winning cause itself, then fixes it the task's own way.
- **A literature or market scan.** One call per source, question or market, given as its input, each bringing back facts and where it found them. A judge, or the holder, writes the synthesis and marks where sources disagree. The holder checks the claims the conclusion rests on.
- **Many language versions.** First batch: one call per language writes its version. Second batch: one call per language reads it as a native speaker would, with a verdict and fixes. The holder applies the fixes.
- **Variants of a page or a letter.** A batch of variants on one brief, then a judge picks the best and says why: a tournament. Next round, a few calls improve the winner and the judge compares again, until it passes or the rounds run out. Sending the letter stays with a standing employee.
- **An audit across a codebase.** One call per file or folder, each on a fresh clone of the branch, all on one checklist, with a verdict asked; the judge merges the findings into one report, drops duplicates and ranks them by harm. The holder confirms each finding before it becomes a task. Where the route marks review or security one-shot, the same audit is that stage, and its owner gives the verdict.

### Which to use when

- A small, clear fix that nobody else need check: a turnkey member.
- A result someone else must check: the route of stages.
- Work that needs memory, questions, a phone, a browser or a sign-in: a standing employee.
- Many independent pieces under one brief, or several tries at once: one-shot calls.
- The best of many tries, improved in rounds: a chain of calls, driven by the holder.
- A person who wants an agent of their own: their personal assistant.
- A program that stands: the program operator and Operations, never a person.
