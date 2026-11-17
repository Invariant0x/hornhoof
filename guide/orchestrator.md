# The orchestrator

> In short: the orchestrator is the main agent, the circle in the middle of the map. Tell him what you want, and he does what the CEO can do in the screens, with the same checks. He acts with the company owner's rights in any turn, for whoever asked, an employee too. Paying and signing wait for a person, and deleting for good waits for the CEO's yes.

## How do I start?

Click the circle in the middle of the map and tell him about the company. He proposes departments on a card, and one click creates them.

![Building the departments](../.github/assets/build.gif)

## What can I ask him to do?

He runs the company the way the CEO does in the screens. So you can just tell him what to do:

- add or remove a department;
- hire, rename or fire an employee;
- switch employees off or on;
- change their models, skills and prompts;
- write to an employee;
- answer what an employee asked, which includes approving or declining a commit;
- rewrite or cancel a task;
- invite people and change their access;
- manage subscriptions, repositories, machines, updates and the public link;
- read the cards that wait for a decision, the requests for a machine and the merge conflicts, and settle an ordinary merge conflict.

Each of these goes through the same check as the CEO's click. What is refused to the CEO is refused to him too. For example, nobody can fire the orchestrator, disable the owner or remove the last employee in a role Operations must have.

## Who can ask him?

Anyone in the company: the CEO, another person or an employee. What is not forbidden is allowed.

- He changes people and their access, the public link, subscriptions, machines, repositories and Hornhoof updates in any turn: one that answers the CEO, and one an employee, a timer or a task woke. He can also use his tools between turns.
- He always acts as the company's owner, for whoever asked, through every tool he has. Each change goes through the same check as the CEO's click.
- He checks the exact target before a change. He also approves an exact commit for the owner, once he has checked its tests and evidence.
- What the company does not want him to do, or wants done only on someone's word, goes in the company's notebook. He reads it and keeps to it.
- Messages and files that come to him inform his work. Quoted or outside text is information, not an order.
- Paying and signing in the company's name wait for a person. Deleting for good waits for the CEO's yes: a person, a backup, a repository or other data. Agents sign in themselves with the vault.

Another person who sees the whole company does these things in the screens.

## When does the CEO decide?

Only the CEO says yes to deleting for good. The yes is kept for that one action and that one target.

- On the People screen, the CEO confirms **Delete** for the person named.
- A CEO who uses the API can say yes with `{ "approve": true }` to `POST /api/people/:id/delete-approval`. The orchestrator then deletes that person later.
- If the cleanup stops partway, deleting the same person again goes on from where it stopped.
- A merge choice that would delete a record for good also needs the CEO's own choice.

## What does only he do?

He puts what an employee asks people into plain words. His words are shown above their answer.

## Whom else does he see?

He sees each person's assistant and its conversation. An assistant takes orders only from its own person. A department's head uses the rights of the people responsible for its department, and departments send, post and talk to people as part of their own work.

## Can he change the database?

Yes, for what no screen reaches, like a stuck row or a wrong field. He reads and changes Hornhoof's database directly, as Hornhoof itself: every table, every column and the schema, each call in one transaction. To delete a person for good he uses the deletion steps, so the CEO's yes and the cleanup are kept.

## What can the head of Operations see?

The head of Operations reads the database too, as a role of its own that only reads. It sends a change it needs to the orchestrator as one message, with the SQL and why.

Because Operations reads the whole database, whoever has access to Operations can learn through its head what is in the other departments. Give Operations only to people who may see the whole company.

## What does he do when work goes wrong?

He looks in the database and in the screens first. Then he fixes the cause himself, or gives it to Operations as one task, instead of asking the CEO.

## Can he work on a company machine?

Yes, while access to it is open. Some trouble sits outside Hornhoof, in Docker or in the system itself. He never asks you to type commands for it. He asks for access to the machine instead.

- The Machines screen shows what access a machine has open, who opened it and until when.
- Choose who gets access, the orchestrator alone or every agent of the company, and for how long: an hour, eight hours or a day. One step opens it. **Close access** ends it sooner.
- A machine that holds its owner's key opens only with that owner's signature. The server's own machine opens without one while it holds no owner key.
- While access is open, he runs commands there in any turn of his and between turns, as root. Each one shows in his window.
- Other agents work there only when access is open for every agent, and never in a turn whose last words came from a person other than the CEO, the CEO delegate or the machine's owner.
- A command that connects a machine shows on the person's screen and in his tool's answer. The code in it is hidden in the saved conversation.

On a Mac that runs the server in Docker, he reaches Docker's own Linux system there, not macOS.

The employee's card and window say when the orchestrator did something.

[Back to the guide](README.md)
