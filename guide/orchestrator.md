# The orchestrator

> In short: the orchestrator is the main agent, the circle in the middle of the map. Tell him what you want, and he does what the CEO can do in the screens, with the same checks. He does it in any turn, for whoever asked, an employee too. Paying, signing and deleting for good still wait for a person.

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
- invite people;
- manage subscriptions, machines, updates and the public link.

Each of these goes through the same check as the CEO's click. What is refused to the CEO is refused to him too. For example, nobody can fire the orchestrator, disable the owner or remove the last employee in a role Operations must have.

## Who can ask him?

Anyone in the company: the CEO, another person or an employee. What is not forbidden is allowed.

- He changes people and their access, the public link, subscriptions, machines, repositories and Hornhoof updates in any turn: one that answers the CEO, and one an employee, a timer or a task woke.
- In a turn that answers the CEO or the CEO delegate, he acts as them. In any other turn he acts as the company's owner, for whoever asked. Each change goes through the same check as the CEO's click.
- He checks the exact target before a change. He also approves an exact commit for the owner, once he has checked its tests and evidence.
- What the company does not want him to do, or wants done only on someone's word, goes in the company's notebook. He reads it and keeps to it.
- Paying and signing in the company's name wait for a person. Deleting for good waits for the CEO's yes: a person, a backup, a repository or other data.

Another person who sees the whole company does these things in the screens.

## What does only he do?

He puts what an employee asks people into plain words. His words are shown above their answer.

## Can he change the database?

Yes, for what no screen reaches, like a stuck row or a wrong field. He reads and changes Hornhoof's database directly, as Hornhoof itself: every table, every column and the schema, each call in one transaction.

## What can the head of Operations see?

The head of Operations reads the database too, as a role of its own that only reads. It sends a change it needs to the orchestrator as one message, with the SQL and why.

Because Operations reads the whole database, whoever has access to Operations can learn through its head what is in the other departments. Give Operations only to people who may see the whole company.

## What does he do when work goes wrong?

He looks in the database and in the screens first. Then he fixes the cause himself, or gives it to Operations as one task, instead of asking the CEO.

## Can he fix the computer the server runs on?

Yes, when the CEO lets him. Some trouble sits outside Hornhoof, in Docker or in the system itself. He never asks you to type commands for it. He asks for access to the computer instead:

1. A thin line at the foot of his window says what he needs the computer for. Its round button explains the rest.
2. **Open for a day** gives it to him. He goes on by himself.
3. For a day he runs commands on that computer as root, and each one shows in his window.
4. Access closes by itself after a day. **Close access** in his window closes it sooner. **Not now** turns a request down.

Only the CEO opens and closes it, in the CEO's own window. While access is open, he runs commands there in any turn of his, also one an employee's letter, a timer or a retry started. He runs nothing there in a turn whose last words came from a person other than the CEO, the CEO delegate or the computer's owner, or from someone Hornhoof cannot name. The computer here is the one the server runs on, whichever machine you open Hornhoof from, so the card names that machine and shows on every screen of yours. On a Mac, he reaches Docker's own Linux system there, not macOS.

## What stays with people?

- He does not open the live feed, the pictures agents send, terminals, or the sign-in and invite pages.
- He cannot type into an employee's terminal.
- He does not take improvements into work or set them aside. The CEO decides, and he does the ones the CEO gives him.
- When he writes to an employee, his words do not answer what the employee asked people.

The employee's card and window say when the orchestrator did something.

[Back to the guide](README.md)
